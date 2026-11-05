/**
 * Synchronous Log shim for modules ported from v1.15.10.
 *
 * The application still owns its Effect logger; this shim exists because those
 * call sites create loggers at module load and cannot yield the Effect service.
 * It writes the same structured lines to opencode.log and exposes an injectable
 * sink so tests can observe records without sharing a mutable default object.
 */
import { appendFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

type Level = "debug" | "info" | "warn" | "error"

export type Entry = {
  timestamp: string
  level: Level
  service: string
  message: string
  meta?: string
}

export type Sink = (entry: Entry) => void

interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  time(label: string, meta?: Record<string, unknown>): Disposable
}

const ranks: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function minimumLevel(): number {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  if (value === "DEBUG") return ranks.debug
  if (value === "WARN") return ranks.warn
  if (value === "ERROR") return ranks.error
  return ranks.info
}

function enabled(level: Level) {
  return ranks[level] >= minimumLevel()
}

function text(value: unknown, limit = 1_000) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value)
  return (rendered ?? "").replace(/\s+/g, " ").slice(0, limit)
}

function formatMeta(meta: Record<string, unknown> | undefined) {
  if (!meta) return undefined
  const entries = Object.entries(meta)
  if (entries.length === 0) return undefined
  return entries
    .map(([key, value]) => {
      const limit = ["stderr", "stdout", "command", "cmd", "args"].includes(key) ? 200 : 1_000
      return `${key}=${text(value, limit)}`
    })
    .join(" ")
}

function fileSink(entry: Entry) {
  try {
    appendFileSync(
      path.join(Global.Path.log, "opencode.log"),
      `${entry.timestamp} ${entry.level} service=${entry.service} message=${entry.message}${entry.meta ? ` ${entry.meta}` : ""}\n`,
    )
  } catch {
    // Logging must never fail the operation it describes.
  }
}

let sink: Sink = fileSink

export function setSink(next?: Sink) {
  const previous = sink
  sink = next ?? fileSink
  return () => {
    sink = previous
  }
}

function emit(service: string, level: Level, message: string, meta?: Record<string, unknown>) {
  if (!enabled(level)) return
  sink({
    timestamp: new Date().toISOString(),
    level,
    service,
    message: text(message),
    meta: formatMeta(meta),
  })
}

export function create(opts: { service: string }): Logger {
  const service = opts.service
  return {
    debug: (message, meta) => emit(service, "debug", message, meta),
    info: (message, meta) => emit(service, "info", message, meta),
    warn: (message, meta) => emit(service, "warn", message, meta),
    error: (message, meta) => emit(service, "error", message, meta),
    time: (label, meta) => {
      const started = performance.now()
      return {
        [Symbol.dispose]() {
          emit(service, "debug", `${label} completed`, { ...meta, duration_ms: performance.now() - started })
        },
      }
    },
  }
}

export function Log() {
  return Default
}

export const Default: Logger = create({ service: "default" })
