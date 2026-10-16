import { Cause, Effect, Exit, FileSystem, Formatter, Logger, Scope, type LogLevel } from "effect"
import path from "path"
import { threadId } from "node:worker_threads"
import { Global } from "../global"
import { runID } from "./shared"

const fileWriters = new WeakSet<object>()

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

function ignoreFileFailure<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> {
  return effect.pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)),
  )
}

export function fileLogger(file = path.join(Global.Path.log, "opencode.log"), id: string = runID) {
  return Effect.gen(function* () {
    // Keep one writer and one batching fiber, as Logger.toFile does. Own its
    // finalizers so a failed log close cannot fail application teardown.
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => ignoreFileFailure(Scope.close(scope, exit)))
    const fs = yield* FileSystem.FileSystem
    const opened = yield* Effect.suspend(() => fs.open(file, { flag: "a" })).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.exit,
    )
    if (Exit.isFailure(opened)) {
      if (Cause.hasInterrupts(opened.cause)) return yield* Effect.failCause(opened.cause)
      yield* ignoreFileFailure(Scope.close(scope, opened))
      return Logger.make(() => {})
    }
    const encoder = new TextEncoder()
    const logger = yield* Logger.batched(formatter(id), {
      // Do not set this to 0; it causes high idle CPU usage.
      window: 1000,
      flush: (output) =>
        ignoreFileFailure(Effect.suspend(() => opened.value.write(encoder.encode(output.join("\n") + "\n")))),
    }).pipe(Effect.provideService(Scope.Scope, scope))
    fileWriters.add(logger)
    return logger
  })
}

/** Best-effort diagnostics routed only to file writers already owned by the runtime. */
export function backgroundDebug(
  message: string,
  fields: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = yield* Effect.service(Logger.CurrentLoggers)
    const writers = new Set([...current].filter((logger) => fileWriters.has(logger)))
    if (writers.size === 0) return
    yield* Effect.logDebug(message, { ...fields, pid: process.pid, threadId }).pipe(
      Effect.provideService(Logger.CurrentLoggers, writers),
    )
  }).pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.OPENCODE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
