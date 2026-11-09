// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Buffered Log shim for modules ported from v1.15.10.
 *
 * The application still owns its Effect logger; this shim exists because those
 * call sites create loggers at module load and cannot yield the Effect service.
 * It writes the same structured lines to the graphagent log and exposes an injectable
 * sink so tests can observe records without sharing a mutable default object.
 *
 * Writes are buffered in memory and flushed asynchronously in batches: the hot
 * path (every hook short-circuit) must never block on a synchronous file
 * append. `flush()` drains the buffer for tests and normal shutdown; the exit
 * and terminating-signal handlers drain it synchronously so a crash loses as
 * little as possible. The formatted `Entry` shape and the redaction rules are
 * unchanged.
 */
import { closeSync, openSync, writeSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { APP_NAME } from "@graphagent/core/brand"

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

/** An entry as emitted; formatting/redaction is deferred to the drain. */
interface Pending {
  readonly timestamp: string
  readonly level: Level
  readonly service: string
  readonly message: string
  readonly meta?: Record<string, unknown>
}

/** A drained batch is bound to the sink that was active when it was taken. */
interface Batch {
  readonly sink: Sink | undefined
  readonly entries: Entry[]
}

const ranks: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function minimumLevel(): number {
  const value = process.env.GRAPHAGENT_LOG_LEVEL?.toUpperCase()
  if (value === "DEBUG") return ranks.debug
  if (value === "WARN") return ranks.warn
  if (value === "ERROR") return ranks.error
  return ranks.info
}

function enabled(level: Level) {
  return ranks[level] >= minimumLevel()
}

const reason = "[redacted]"

// Credentials can arrive through hook commands, URLs, or captured stderr.
// The log is persisted by default, so redact common secret shapes before the
// text leaves this module. This is a defensive filter, not a credential parser.
function redactText(value: string) {
  return value
    .replace(/(https?:\/\/)[^/\s@]+@/gi, `$1${reason}@`)
    .replace(
      /(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi,
      `$1${reason}`,
    )
    .replace(/(\b(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${reason}`)
    .replace(
      /(^|[\s,;{&?"'])([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(?:"|')?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"',;&}]+)/gi,
      `$1$2=${reason}`,
    )
    .replace(
      /(^|\s)(--?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi,
      `$1$2${reason}`,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      reason,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, reason)
}

function redactURL(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return redactText(value)
    // Credentials, signed query strings, and fragments never reach the log.
    const clean = `${url.protocol}//${url.host}${url.pathname}`
    return url.username || url.password || url.search || url.hash ? `${clean} ${reason}` : clean
  } catch {
    return redactText(value)
  }
}

function text(value: unknown, limit = 1_000) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value)
  return redactText(rendered ?? "")
    .replace(/\s+/g, " ")
    .slice(0, limit)
}

function formatMeta(meta: Record<string, unknown> | undefined) {
  if (!meta) return undefined
  const entries = Object.entries(meta)
  if (entries.length === 0) return undefined
  return entries
    .map(([key, value]) => {
      const limit = ["stderr", "stdout", "command", "cmd", "args"].includes(key) ? 200 : 1_000
      return `${key}=${key === "url" ? redactURL(String(value)).slice(0, limit) : text(value, limit)}`
    })
    .join(" ")
}

function toEntry(pending: Pending): Entry {
  return {
    timestamp: pending.timestamp,
    level: pending.level,
    service: pending.service,
    message: text(pending.message),
    meta: formatMeta(pending.meta),
  }
}

function formatLine(entry: Entry) {
  return `${entry.timestamp} ${entry.level} service=${entry.service} message=${entry.message}${entry.meta ? ` ${entry.meta}` : ""}\n`
}

// ── Buffered writer ─────────────────────────────────────────────
//
// The queue is bounded so a runaway debug-level producer cannot grow memory
// without limit. On overflow the oldest debug/info record is dropped first
// (warn/error are kept), and the loss count is surfaced as one summary line
// in the next batch.

const MAX_QUEUE_ENTRIES = 10_000

let queue: Pending[] = []
let dropped = 0
let scheduled = false
let draining: Promise<void> = Promise.resolve()

/** Injected test sink. Undefined means the buffered file writer. */
let custom: Sink | undefined

const logFile = () => path.join(Global.Path.log, `${APP_NAME}.log`)

function takeBatch(): Batch {
  if (queue.length === 0) return { sink: custom, entries: [] }
  const pending = queue
  queue = []
  const entries = pending.map(toEntry)
  if (dropped > 0) {
    entries.unshift({
      timestamp: new Date().toISOString(),
      level: "warn",
      service: "log",
      message: `dropped ${dropped} buffered log entries: queue limit ${MAX_QUEUE_ENTRIES} reached`,
    })
    dropped = 0
  }
  return { sink: custom, entries }
}

async function deliver(batch: Batch) {
  if (batch.entries.length === 0) return
  if (batch.sink) {
    for (const entry of batch.entries) batch.sink(entry)
    return
  }
  try {
    await appendFile(logFile(), batch.entries.map(formatLine).join(""))
  } catch {
    // Logging must never fail the operation it describes.
  }
}

async function drain() {
  const batch = takeBatch()
  if (batch.entries.length === 0) return
  draining = draining.then(() => deliver(batch))
  await draining
}

function schedule() {
  if (scheduled) return
  scheduled = true
  setImmediate(() => {
    scheduled = false
    void drain()
  })
}

function enqueue(pending: Pending) {
  if (queue.length >= MAX_QUEUE_ENTRIES) {
    dropped++
    const droppable = queue.findIndex((entry) => entry.level === "debug" || entry.level === "info")
    if (droppable >= 0) queue.splice(droppable, 1)
    else if (pending.level !== "warn" && pending.level !== "error") return
    else queue.shift()
  }
  queue.push(pending)
  schedule()
}

/** Synchronously write the buffered entries through the batch's sink. */
function flushSync() {
  const batch = takeBatch()
  if (batch.entries.length === 0) return
  if (batch.sink) {
    // An injected test sink is synchronous by contract.
    for (const entry of batch.entries) batch.sink(entry)
    return
  }
  try {
    const fd = openSync(logFile(), "a")
    try {
      // One synchronous write per flush; exit cannot await the async chain.
      writeSync(fd, batch.entries.map(formatLine).join(""))
    } finally {
      closeSync(fd)
    }
  } catch {
    // Logging must never fail the operation it describes.
  }
}

/**
 * Drain the in-memory buffer. Tests call this before asserting on an injected
 * sink; shutdown paths call it so the tail of the log reaches the file.
 */
export async function flush(): Promise<void> {
  while (true) {
    await draining
    if (queue.length === 0) return
    await drain()
  }
}

/** Number of entries dropped by the bounded queue since the last summary line. */
export function droppedEntries(): number {
  return dropped
}

export function setSink(next?: Sink) {
  // Entries produced before the swap belong to the previous sink.
  flushSync()
  const previous = custom
  custom = next
  return () => {
    flushSync()
    custom = previous
  }
}

function emit(service: string, level: Level, message: string, meta?: Record<string, unknown>) {
  if (!enabled(level)) return
  enqueue({ timestamp: new Date().toISOString(), level, service, message, meta })
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

// ── Shutdown flushing ───────────────────────────────────────────
//
// `exit` runs synchronously and cannot await, so it uses the synchronous
// writer. `beforeExit` may still do async work on an otherwise idle loop.
// `uncaughtExceptionMonitor` observes a fatal exception without changing the
// process's default crash behavior.

process.on("exit", flushSync)
process.on("beforeExit", () => {
  void flush()
})
process.on("uncaughtExceptionMonitor", flushSync)

const onSigterm = () => {
  flushSync()
  // Restore the default termination action we masked by listening.
  process.removeListener("SIGTERM", onSigterm)
  process.kill(process.pid, "SIGTERM")
}
process.on("SIGTERM", onSigterm)

export function Log() {
  return Default
}

export const Default: Logger = create({ service: "default" })