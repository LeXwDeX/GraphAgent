import path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
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
const MAX_CONTEXT = 20

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
  context: Schema.optional(NonNegativeInt).annotate({
    description: `Lines of context before and after each match (defaults to 0, capped at ${MAX_CONTEXT}); use it to read a saved shell output in one search`,
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
      execute: (
        params: { pattern: string; path?: string; include?: string; limit?: number; context?: number },
        ctx: Tool.Context,
      ) =>
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
          const context = Math.min(params.context ?? 0, MAX_CONTEXT)
          const scan = Math.max(previewLimit, SCAN_LIMIT)
          // Context rows consume the process row budget; matches still cap at
          // `scan`.
          const rowBudget = context > 0 ? scan * (2 * context + 1) : scan
          const found =
            context > 0
              ? yield* ripgrep.grepContext({
                  cwd,
                  pattern: params.pattern,
                  file: info.type === "File" ? path.basename(search) : undefined,
                  include: params.include,
                  limit: rowBudget + 1,
                  context,
                })
              : (yield* ripgrep.grep({
                  cwd,
                  pattern: params.pattern,
                  file: info.type === "File" ? path.basename(search) : undefined,
                  include: params.include,
                  limit: rowBudget + 1,
                })).map((match) => ({ kind: "match" as const, match }))
          if (found.length === 0) return empty

          const matches = found.filter((row) => row.kind === "match")
          const more = found.length > rowBudget || matches.length > scan
          // The extra match that proves the scan cap was reached only signals
          // "more"; the saved listing stays within the cap the caller can ask
          // for, keeping its continuation past the end of the saved lines.
          let probe = -1
          let seen = 0
          for (let i = 0; i < found.length && probe < 0; i++) {
            if (found[i]!.kind !== "match") continue
            if (seen++ === scan) probe = i
          }
          const kept = probe >= 0 ? found.slice(0, probe) : found
          const rows = kept.map((row) => ({
            kind: row.kind,
            path: path.resolve(cwd, row.match.entry.path),
            line: row.match.line,
            text: row.match.text,
          }))

          // Every match keeps its context window in the saved listing; the
          // preview stops at previewLimit matches and the shared byte budget.
          const include = new Set<number>()
          rows.forEach((row, index) => {
            if (row.kind !== "match") return
            for (let i = Math.max(0, index - context); i <= Math.min(rows.length - 1, index + context); i++) {
              include.add(i)
            }
          })

          // Setting metadata.truncated opts out of the shared output cap, so the
          // listing enforces the same byte budget itself.
          const entries: { lines: string[]; match: boolean; matchIndex: number }[] = []
          let current = ""
          let previousLine = -1
          let matchIndex = -1
          for (let i = 0; i < rows.length; i++) {
            if (!include.has(i)) continue
            const row = rows[i]!
            if (row.kind === "match") matchIndex++
            const owner = matchIndex >= 0 ? matchIndex : 0
            const text =
              row.text.length > MATCH_TEXT_LIMIT
                ? `${row.text.slice(0, MATCH_TEXT_LIMIT)}... (line truncated to ${MATCH_TEXT_LIMIT} of ${row.text.length} chars; ` +
                  `continue with read filePath="${row.path}" offset=${row.line} limit=1 ` +
                  `charOffset=${MATCH_TEXT_LIMIT + 1} ` +
                  `maxLineLength=${Math.min(row.text.length - MATCH_TEXT_LIMIT, Truncate.MAX_LINE_FETCH)})`
                : row.text
            const lines: string[] = []
            if (current !== row.path) {
              if (current !== "") lines.push("")
              lines.push(`${row.path}:`)
              current = row.path
              previousLine = -1
            } else if (previousLine >= 0 && row.line > previousLine + 1) {
              lines.push("  ...")
            }
            lines.push(row.kind === "match" ? `  Line ${row.line}: ${text}` : `  Line ${row.line}- ${text}`)
            entries.push({ lines, match: row.kind === "match", matchIndex: owner })
            previousLine = row.line
          }

          const total = more ? `at least ${matches.length}` : `${matches.length}`
          const header = `Found ${total} matches`
          const body: string[] = []
          let bytes = 0
          let shown = 0
          let byBytes = false
          for (const entry of entries) {
            if (entry.matchIndex >= previewLimit) break
            if (entry.match && shown >= previewLimit) break
            const size = Buffer.byteLength(entry.lines.join("\n"), "utf8") + 1
            if (body.length > 0 && bytes + size > Truncate.MAX_BYTES) {
              byBytes = true
              break
            }
            body.push(...entry.lines)
            bytes += size
            if (entry.match) shown++
          }

          const truncated = more || matches.length > previewLimit || shown < Math.min(matches.length, previewLimit)
          const output = [header, ...body]
          if (!truncated) {
            return {
              title: params.pattern,
              metadata: { matches: shown, truncated: false },
              output: output.join("\n"),
            }
          }

          const saved = [header, ...entries.flatMap((entry) => entry.lines)].join("\n")
          const full = yield* trunc.write(saved)
          // Match text may carry its trailing newline, so an entry can render as
          // more than one line. Count rendered lines, not array entries, or the
          // continuation points back into the preview. When the scan itself was
          // capped there is nothing left to page through in the saved listing,
          // so continue past its last line.
          const next = (more ? saved : output.join("\n")).split("\n").length + 1
          const omitted = matches.length - shown
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
