import path from "path"
import { Effect, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import { describeSearchPathFailure } from "./search-path"
import * as Tool from "./tool"
import * as Truncate from "./truncate"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
// Scan past the preview limit so a truncated listing can be saved whole and
// read back with exact line offsets.
const SCAN_LIMIT = 1000
const MATCH_TEXT_LIMIT = 2000

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The file or directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: `Maximum matches to show (defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT})`,
  }),
})

const searchPathFailure = (searchPath: string, error: unknown, requested?: string) =>
  Effect.fail(new Error(describeSearchPathFailure(searchPath, error, requested)))

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const trunc = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string; limit?: number }, ctx: Tool.Context) =>
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
          const previewLimit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const scan = Math.max(previewLimit, SCAN_LIMIT)
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            file: info.type === "File" ? path.basename(search) : undefined,
            include: params.include,
            limit: scan + 1,
          })
          if (result.length === 0) return empty

          const more = result.length > scan
          const rows = result.slice(0, scan).map((item) => ({
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))

          // Setting metadata.truncated opts out of the shared output cap, so the
          // listing enforces the same byte budget itself.
          const entries: string[][] = []
          let current = ""
          for (const match of rows) {
            const text =
              match.text.length > MATCH_TEXT_LIMIT
                ? `${match.text.slice(0, MATCH_TEXT_LIMIT)}... (line truncated to ${MATCH_TEXT_LIMIT} of ${match.text.length} chars; ` +
                  `continue with read filePath="${match.path}" offset=${match.line} limit=1 ` +
                  `charOffset=${MATCH_TEXT_LIMIT + 1} ` +
                  `maxLineLength=${Math.min(match.text.length - MATCH_TEXT_LIMIT, Truncate.MAX_LINE_FETCH)})`
                : match.text
            const lines = current === match.path ? [] : [...(current === "" ? [] : [""]), `${match.path}:`]
            lines.push(`  Line ${match.line}: ${text}`)
            entries.push(lines)
            current = match.path
          }

          const total = more ? `at least ${rows.length}` : `${rows.length}`
          const header = `Found ${total} matches`
          const body: string[] = []
          let bytes = 0
          let shown = 0
          let byBytes = false
          for (const lines of entries) {
            if (shown >= previewLimit) break
            const size = Buffer.byteLength(lines.join("\n"), "utf8") + 1
            if (shown > 0 && bytes + size > Truncate.MAX_BYTES) {
              byBytes = true
              break
            }
            body.push(...lines)
            bytes += size
            shown++
          }

          const truncated = more || shown < rows.length
          const output = [header, ...body]
          if (!truncated) {
            return {
              title: params.pattern,
              metadata: { matches: shown, truncated: false },
              output: output.join("\n"),
            }
          }

          const full = yield* trunc.write([header, ...entries.flat()].join("\n"))
          const next = output.length + 1
          const omitted = rows.length - shown
          output.push("")
          output.push(
            `[truncated: showing ${shown} of ${total} matches. ` +
              (more
                ? "The scan stopped at the match cap. "
                : `${omitted} ${omitted === 1 ? "match" : "matches"} omitted. `) +
              `Full output: ${full}]`,
          )
          output.push(
            `Continue: read filePath="${full}" offset=${next}` +
              (more
                ? "; narrow path/include or use a more specific pattern for matches beyond the saved listing."
                : byBytes
                  ? "; the byte budget stopped the preview, so read the saved listing or narrow the search."
                  : `; raise grep limit to ${Math.min(Math.max(previewLimit * 2, previewLimit + 1), MAX_LIMIT)} to show more.`),
          )

          return {
            title: params.pattern,
            metadata: {
              matches: shown,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
