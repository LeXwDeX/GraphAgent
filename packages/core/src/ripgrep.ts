export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { LayerNode } from "./effect/layer-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

// ripgrep emits `bytes` (base64) instead of `text` for data that is not valid
// UTF-8, such as GBK sources. Those matches are still real matches.
const RawData = Schema.Union([Schema.Struct({ text: Schema.String }), Schema.Struct({ bytes: Schema.String })])
const rawText = (data: typeof RawData.Type) =>
  "text" in data ? data.text : Buffer.from(data.bytes, "base64").toString("utf8")

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: RawData,
    lines: RawData,
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = Omit<(typeof RawMatch.Type)["data"], "path" | "lines"> & {
  path: { text: string }
  lines: { text: string }
}

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

/**
 * Builds the message for a failed ripgrep execution. Platform errors (for
 * example a missing working directory) are not JavaScript Error instances;
 * their normalized reason carries the category, syscall, and path, which must
 * stay visible instead of collapsing into a generic failure.
 */
const describeExecutionFailure = (cause: unknown): string => {
  const reason = (cause as { reason?: unknown } | undefined)?.reason
  if (reason && typeof reason === "object" && "_tag" in reason) {
    const record = reason as { _tag?: unknown; description?: unknown; syscall?: unknown; pathOrDescriptor?: unknown }
    const parts: string[] = []
    if (typeof record.description === "string" && record.description) parts.push(record.description)
    if (typeof record._tag === "string") parts.push(record._tag)
    if (typeof record.syscall === "string") parts.push(record.syscall)
    if (typeof record.pathOrDescriptor === "string" && record.pathOrDescriptor) parts.push(record.pathOrDescriptor)
    if (parts.length > 0) return `ripgrep execution failed (${parts.join("; ")})`
  }
  if (cause instanceof globalThis.Error && cause.message) return `ripgrep execution failed (${cause.message})`
  return "ripgrep execution failed"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false, stderr: "" }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2, stderr }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure(describeExecutionFailure(cause), cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.flatMap((result) => {
            // Exit code 2 means ripgrep hit traversal errors (for example an
            // unreadable directory). Those failures must stay visible instead
            // of becoming a misleading empty or partial-success result, even
            // when some paths were already listed. Limit truncation above is
            // an intentional partial result and is unaffected.
            if (result.partial) {
              return Effect.fail(failure(result.stderr.trim() || "ripgrep reported traversal errors"))
            }
            return Effect.succeed(
              result.items.map((relative) =>
                Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
              ),
            )
          }),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            // One oversized record (a match inside a minified bundle) is skipped
            // rather than failing every other match in the search.
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.succeed(undefined)
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: rawText(match.data.path).replace(/^\.[\\/]/, "") },
                    lines: { text: rawText(match.data.lines) },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.flatMap((result) => {
            // Exit code 2 means ripgrep hit traversal/read errors (for example
            // unreadable files). Those failures must stay visible instead of
            // becoming a misleading successful or no-match result, even when
            // some matches were already found. Limit truncation above is an
            // intentional partial result and is unaffected.
            if (result.partial) {
              return Effect.fail(failure(result.stderr.trim() || "ripgrep reported traversal errors"))
            }
            return Effect.succeed(
              result.items.map((match) => {
                const relative = match.path.text
                  .replace(/^(?:\.[\\/])+/u, "")
                  .replace(/^[\\/]+/u, "")
                  .replaceAll("\\", "/")
                return Match.make({
                  entry: Entry.make({
                    path: RelativePath.make(relative),
                    type: "file",
                  }),
                  line: match.line_number,
                  offset: match.absolute_offset,
                  text:
                    match.lines.text.length > 2_000
                      ? match.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                      : match.lines.text,
                  submatches: match.submatches.map((submatch) => ({
                    text: submatch.match.text,
                    start: submatch.start,
                    end: submatch.end,
                  })),
                })
              }),
            )
          }),
        ),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.merge(RipgrepBinary.defaultLayer, AppProcess.defaultLayer)))
export const node = LayerNode.make(layer, [RipgrepBinary.node, AppProcess.node])
