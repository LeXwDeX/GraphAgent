import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import { describeSearchPathFailure } from "./search-path"
import * as Tool from "./tool"
import * as Truncate from "./truncate"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The file or directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

const searchPathFailure = (searchPath: string, error: unknown, requested?: string) =>
  Effect.fail(new Error(describeSearchPathFailure(searchPath, error, requested)))

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          // Best-effort realpath; when the path itself is the failure, the
          // classified stat below reports the actual category for the requested path.
          let search = requested
          try {
            search = FSUtil.resolve(requested)
          } catch {
            search = requested
          }
          const info = yield* fs.stat(search).pipe(Effect.catch((error) => searchPathFailure(search, error, requested)))
          const cwd = info.type === "Directory" ? search : path.dirname(search)
          const limit = 100
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            file: info.type === "File" ? path.basename(search) : undefined,
            include: params.include,
            limit: limit + 1,
          })
          if (result.length === 0) return empty

          const rows = result.slice(0, limit).map((item) => ({
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))

          // Setting metadata.truncated opts out of the shared output cap, so the
          // listing enforces the same byte budget itself.
          const body: string[] = []
          let bytes = 0
          let shown = 0
          let current = ""
          for (const match of rows) {
            const lines = current === match.path ? [] : [...(current === "" ? [] : [""]), `${match.path}:`]
            lines.push(`  Line ${match.line}: ${match.text}`)
            const size = Buffer.byteLength(lines.join("\n"), "utf8") + 1
            if (shown > 0 && bytes + size > Truncate.MAX_BYTES) break
            body.push(...lines)
            bytes += size
            shown++
            current = match.path
          }

          const total = shown
          const truncated = result.length > shown
          const output = [`Found ${total} matches${truncated ? " (more matches available)" : ""}`, ...body]

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
