import path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@graphagent/core/schema"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@graphagent/core/fs-util"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { addCorrections } from "@graphagent/core/session/outcome"
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

/** What an empty search says it did, so "no match" is not read as "does not exist" when nothing was searched. */
function noMatchesLine(pattern: string, searchPath: string, include: string | undefined, searched: number | undefined) {
  const tail =
    searched === 0
      ? "No file passed the include filter or ignore rules (.gitignore, .ignore)."
      : "Rust regex, case-sensitive."
  return (
    `No matches: pattern=${JSON.stringify(pattern)} path=${JSON.stringify(searchPath)} ` +
    `include=${include ? JSON.stringify(include) : "none"}; files searched: ${searched ?? "unknown"}. ${tail}`
  )
}

/** Matching lines over the record cap are skipped by the search; say so and give the command that previews them. */
function skippedLine(skipped: number, more: boolean) {
  return (
    `[skipped: ${skipped}${more ? "+" : ""} matching ${skipped === 1 ? "line" : "lines"} over 64 KB not shown. ` +
    "Preview them with the shell tool: rg -n -M 200 --max-columns-preview -e <pattern> <path>]"
  )
}

/** The result text, followed after a blank line by the skipped-lines line when the search skipped any. */
function withSkipped(text: string, report: Ripgrep.GrepReport, more: boolean) {
  return report.skipped > 0 ? `${text}\n\n${skippedLine(report.skipped, more)}` : text
}

/** The result metadata, with the `long_lines_skipped` correction when the search skipped lines. */
function withCorrection<M extends Record<string, unknown>>(
  metadata: M,
  report: Ripgrep.GrepReport,
): M & { corrections?: string[] } {
  return report.skipped > 0 ? addCorrections(metadata, "long_lines_skipped") : metadata
}

/**
 * ripgrep's complaint about look-around or a backreference ends with advice to enable PCRE2, a flag this tool does
 * not have. Keep the complaint and say what to do here instead; any other complaint stands as it is.
 */
function explainPattern(message: string) {
  if (!message.includes("look-around") && !message.includes("backreferences")) return message
  const [reason = message] = message.split(/\r?\n\r?\n/, 1)
  return (
    `${reason}\n\ngrep uses Rust regex (no look-around or backreferences). ` +
    "Rewrite the pattern, or run rg --pcre2 -n -e <pattern> <path> with the shell tool."
  )
}

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const trunc = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (
        params: { pattern: string; path?: string; include?: string; limit?: number; context?: number },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          // Computed before the ask because it is pure: the permission request
          // reports the path the search starts from, which `path` (an argument,
          // possibly relative) does not say.
          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
              searchPath: requested,
            },
          })

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
          const report = yield* ripgrep
            .grepReport({
              cwd,
              pattern: params.pattern,
              file: info.type === "File" ? path.basename(search) : undefined,
              include: params.include,
              limit: rowBudget + 1,
              context,
              sorted: true,
            })
            .pipe(
              Effect.catchTag("Ripgrep.InvalidPatternError", (error) =>
                Effect.fail(new Error(explainPattern(error.message))),
              ),
            )
          const found = report.rows
          if (found.length === 0) {
            return {
              title: params.pattern,
              metadata: withCorrection({ matches: 0, truncated: false }, report),
              output:
                report.skipped > 0
                  ? skippedLine(report.skipped, false)
                  : noMatchesLine(params.pattern, search, params.include, report.searched),
            }
          }

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
            textLength: row.match.textLength,
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
              row.textLength !== undefined && row.textLength > MATCH_TEXT_LIMIT
                ? `${row.text}... (line truncated to ${MATCH_TEXT_LIMIT} of ${row.textLength} chars; ` +
                  `continue with read filePath="${row.path}" offset=${row.line} limit=1 ` +
                  `charOffset=${MATCH_TEXT_LIMIT + 1} ` +
                  `maxLineLength=${Math.min(row.textLength - MATCH_TEXT_LIMIT, Truncate.MAX_LINE_FETCH)})`
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

          const truncated =
            more || matches.length > previewLimit || shown < Math.min(matches.length, previewLimit) || byBytes
          const output = [header, ...body]
          if (!truncated) {
            return {
              title: params.pattern,
              metadata: withCorrection({ matches: shown, truncated: false }, report),
              output: withSkipped(output.join("\n"), report, more),
            }
          }

          const saved = [header, ...entries.flatMap((entry) => entry.lines)].join("\n")
          const full = yield* trunc.save(saved)
          // Match text may carry its trailing newline, so an entry can render as
          // more than one line. Count rendered lines, not array entries, or the
          // continuation points back into the preview. When the preview did not
          // cover every saved entry, continue at the first unshown saved line;
          // only the scan-cap case can exhaust the saved listing itself.
          const next = output.join("\n").split("\n").length + 1
          const hasMoreSaved = next <= saved.split("\n").length
          const omitted = matches.length - shown
          output.push("")
          output.push(
            `[truncated: showing ${shown} of ${total} matches. ` +
              (more
                ? "The scan stopped at the match cap. "
                : byBytes
                  ? omitted > 0
                    ? `${omitted} ${omitted === 1 ? "match" : "matches"} omitted by the output byte budget. `
                    : "Context lines were omitted by the output byte budget. "
                  : `${omitted} ${omitted === 1 ? "match" : "matches"} omitted. `) +
              ("path" in full ? `Full output: ${full.path}]` : `${Truncate.unsavedNote(full.failed)}]`),
          )
          // Without a saved listing there is nothing to read on from: the note above says what to do instead.
          if ("path" in full)
            output.push(
              hasMoreSaved
                ? `Continue: read filePath="${full.path}" offset=${next}` +
                    (more
                      ? "; narrow path/include or use a more specific pattern for matches beyond the saved listing."
                      : byBytes
                        ? "; the byte budget stopped the preview, so read the saved listing for the omitted context."
                        : `; raise grep limit to ${Math.min(Math.max(previewLimit * 2, previewLimit + 1), MAX_LIMIT)} to show more.`)
                : `Continue: narrow path/include or use a more specific pattern for matches beyond the saved listing.`,
            )

          return {
            title: params.pattern,
            metadata: withCorrection({ matches: shown, truncated }, report),
            output: withSkipped(output.join("\n"), report, more),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
