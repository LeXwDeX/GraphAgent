import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
/** Lines in one `read` page when the caller does not pass a limit. */
export const PAGE_LINES = 200
/** Largest per-line fetch the read tool accepts; longer lines need the shell. */
export const MAX_LINE_FETCH = 50_000
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export interface Details {
  direction: "head" | "tail"
  truncatedBy: "lines" | "bytes"
  /** Lines in the complete output. */
  totalLines: number
  /** Bytes in the complete output. */
  totalBytes: number
  /** First line (1-based) present in the preview. */
  startLine: number
  /** Last line (1-based) present in the preview. */
  endLine: number
  /** Bytes in the preview. */
  outputBytes: number
  /** Bytes in the complete line that `partialLine` cut (0 when not partial). */
  lineBytes: number
  /** Byte budget that stopped the preview. */
  maxBytes: number
  /** The preview is a byte slice of one line instead of whole lines. */
  partialLine: boolean
}

export interface Preview {
  text: string
  cut: boolean
  details?: Details
}

export type Result =
  { content: string; truncated: false } | { content: string; truncated: true; outputPath: string; details: Details }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus the continuation notice.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Cut UTF-8 text at a byte budget without splitting a code point. */
function headBytes(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf-8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf-8")
}

function tailBytes(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf-8")
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf-8")
}

function splitLines(text: string) {
  const lines = text.split("\n")
  // A trailing newline terminates the last line; it does not start an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Lines in `text`, counting neither a trailing newline nor an empty string as a line. */
export function countLines(text: string) {
  return splitLines(text).length
}

/**
 * Keep the first whole lines that fit both limits. A first line larger than the
 * byte budget is cut at a code-point boundary and flagged partial so the notice
 * can point at the read parameters that continue it.
 */
export function headPreview(text: string, maxLines: number, maxBytes: number): Preview {
  const lines = splitLines(text)
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return { text, cut: false }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  let partialLine = false
  let lineBytes = 0
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      if (out.length === 0) {
        lineBytes = Buffer.byteLength(lines[i], "utf-8")
        const cut = headBytes(lines[i], maxBytes)
        out.push(cut)
        bytes = Buffer.byteLength(cut, "utf-8")
        partialLine = true
      }
      break
    }
    out.push(lines[i])
    bytes += size
  }

  return {
    text: out.join("\n"),
    cut: true,
    details: {
      direction: "head",
      truncatedBy: hitBytes ? "bytes" : "lines",
      totalLines: lines.length,
      totalBytes,
      startLine: 1,
      endLine: Math.max(1, out.length),
      outputBytes: bytes,
      lineBytes,
      maxBytes,
      partialLine,
    },
  }
}

/** Keep the last whole lines that fit both limits, cutting one oversized line. */
export function tailPreview(text: string, maxLines: number, maxBytes: number): Preview {
  const lines = splitLines(text)
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return { text, cut: false }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  let partialLine = false
  let lineBytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      if (out.length === 0) {
        lineBytes = Buffer.byteLength(lines[i], "utf-8")
        const cut = tailBytes(lines[i], maxBytes)
        out.unshift(cut)
        bytes = Buffer.byteLength(cut, "utf-8")
        partialLine = true
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }

  return {
    text: out.join("\n"),
    cut: true,
    details: {
      direction: "tail",
      truncatedBy: hitBytes ? "bytes" : "lines",
      totalLines: lines.length,
      totalBytes,
      startLine: Math.max(1, lines.length - out.length + 1),
      endLine: lines.length,
      outputBytes: bytes,
      lineBytes,
      maxBytes,
      partialLine,
    },
  }
}

/**
 * The one truncation notice every tool uses: what was omitted, where the full
 * output is, and the exact parameters that continue reading it.
 */
export function notice(file: string, details: Details): string {
  if (details.partialLine) {
    const edge = details.direction === "head" ? "first" : "last"
    return [
      `[truncated: showing the ${edge} ${formatSize(details.outputBytes)} of line ${details.startLine} ` +
        `(line is ${formatSize(details.lineBytes)}; ${formatSize(details.totalBytes)} total output). Full output: ${file}]`,
      `Continue: read filePath="${file}" offset=${details.startLine} limit=1 maxLineLength=${MAX_LINE_FETCH}; ` +
        `use the shell tool for characters beyond that.`,
    ].join("\n")
  }

  const limit = details.truncatedBy === "bytes" ? ` (${formatSize(details.maxBytes)} limit)` : ""
  const omitted =
    details.direction === "head"
      ? `${details.totalLines - details.endLine} lines omitted after this range.`
      : `${details.startLine - 1} lines omitted before this range.`
  const next = details.direction === "head" ? details.endLine + 1 : 1
  return [
    `[truncated: showing lines ${details.startLine}-${details.endLine} of ${details.totalLines}${limit}. ` +
      `${omitted} Full output: ${file}]`,
    `Continue: read filePath="${file}" offset=${next}`,
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        if (!info) continue
        const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
        if (mtime >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, _agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const preview =
        direction === "head" ? headPreview(text, maxLines, maxBytes) : tailPreview(text, maxLines, maxBytes)
      if (!preview.cut || !preview.details) return { content: text, truncated: false } as const

      const file = yield* write(text)
      const hint = notice(file, preview.details)
      return {
        content: direction === "head" ? `${preview.text}\n\n${hint}` : `${hint}\n\n${preview.text}`,
        truncated: true,
        outputPath: file,
        details: preview.details,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(NodePath.layer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Truncate from "./truncate"
