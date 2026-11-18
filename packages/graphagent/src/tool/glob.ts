import path from "path"
import { Effect, Schema } from "effect"
import { PositiveInt } from "@graphagent/core/schema"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@graphagent/core/fs-util"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import { ModelContext } from "./model-context"
import { describeSearchPathFailure } from "./search-path"
import * as Tool from "./tool"
import * as Truncate from "./truncate"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
// Scan past the preview limit so the notice can state an exact total up to this
// bound instead of only "more results exist".
const SCAN_LIMIT = 1000

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in; relative paths resolve from the project directory. If not specified, the project directory is used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: `Maximum paths to show (defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT})`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const trunc = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      clamps: { limit: { max: MAX_LIMIT } },
      execute: (params: { pattern: string; path?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          // Computed before the ask because it is pure: the permission request
          // reports the directory the search runs in, which `path` (an
          // argument, possibly relative) does not say.
          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              searchPath: search,
            },
          })

          const statFailure = (error: unknown) =>
            Effect.fail(
              new Error(
                describeSearchPathFailure(
                  search,
                  error,
                  undefined,
                  "Check the nearest existing parent directory or correct the path.",
                ),
              ),
            )
          const info = yield* fs.stat(search).pipe(Effect.catch((error) => statFailure(error)))
          if (info.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const scan = Math.max(limit, SCAN_LIMIT)
          const matches = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit: scan + 1, sorted: true })
          const more = matches.length > scan
          const files = matches.slice(0, limit)
          // The list is cut at the byte budget of the model, like any result that sets `metadata.truncated` itself.
          const limits = yield* trunc.limits({ context: ModelContext.contextOf(ctx.extra) })
          const lines = files.map((file) => path.resolve(search, file.path))
          const kept = Truncate.fitItems(lines, limits.maxBytes)
          const byBytes = kept < files.length

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...lines.slice(0, kept))
            if (more || files.length < matches.length || byBytes) {
              const total = more ? `at least ${scan}` : `${matches.length}`
              const next = more
                ? limit < MAX_LIMIT
                  ? `, or glob limit=${MAX_LIMIT} to show up to ${MAX_LIMIT} paths`
                  : ""
                : `, or glob limit=${Math.min(matches.length, MAX_LIMIT)} to show the rest`
              output.push("")
              output.push(
                byBytes
                  ? `[truncated: showing the first ${kept} of ${total} paths. ` +
                      `The output byte budget (${Truncate.formatSize(limits.maxBytes)}) stopped the list. ` +
                      `Continue: narrow path/pattern.]`
                  : `[truncated: showing the first ${files.length} of ${total} paths. ` +
                      (more
                        ? "The scan stopped at the path cap. "
                        : `${matches.length - files.length} paths omitted. `) +
                      `Continue: narrow path/pattern${next}.]`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: kept,
              truncated: more || files.length < matches.length || byBytes,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
