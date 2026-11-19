import { LayerNode } from "@graphagent/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@graphagent/core/fs-util"
import { Config } from "@/config/config"
import { errorMessage } from "@/util/error"
import { headChars } from "@/util/text"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

/** The caps of one tool result: what a window of 256_000 tokens or more gets, and a call without a model. */
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
/** The smallest budget a window can shrink the caps to. */
export const MIN_BYTES = 4096
export const MIN_LINES = 200
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
  /** Code points in the preview when `partialLine` (the unit `read` counts `charOffset` in); 0 otherwise. */
  shownChars: number
}

export interface Preview {
  text: string
  cut: boolean
  details?: Details
}

/** Where `save` put a text, or why it could not (the first line of the write error, at most 200 characters). */
export type Saved = { path: string } | { failed: string }

export type Result =
  | { content: string; truncated: false }
  | { content: string; truncated: true; outputPath: string; details: Details }
  /** The full text could not be saved: the preview stands alone, and `unsaved` is the reason. */
  | { content: string; truncated: true; outputPath: undefined; unsaved: string; details: Details }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /** Context window in tokens of the model that reads the result; the default budget follows it. */
  context?: number
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Like `write`, for bytes: the file is named a tool id plus `extension` (with its leading dot), so it is cleaned up
   * after 7 days like any saved output and its name tells the type. A failed write is a defect, as in `write`.
   */
  readonly writeBytes: (bytes: Uint8Array, extension: string) => Effect.Effect<string>
  /**
   * Like `write`, but a failed write is the value `{ failed }` instead of a defect, so a caller can still
   * return what it has and say that the rest could not be saved.
   */
  readonly save: (text: string) => Effect.Effect<Saved>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus the continuation notice.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits. A value set under `tool_output` in the GraphAgent config wins; otherwise the budget
   * of the window (`budgetFor`) when `context` is given, or MAX_LINES / MAX_BYTES when there is no window.
   */
  readonly limits: (input?: { context?: number }) => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Truncate") {}

/**
 * The output budget of a model: a twentieth of its window in tokens at four bytes a token, so one result takes
 * at most a twentieth of the window, between MIN_BYTES and MAX_BYTES. The line limit scales with the bytes.
 */
export function budgetFor(context: number): { maxLines: number; maxBytes: number } {
  const maxBytes = Math.max(MIN_BYTES, Math.min(MAX_BYTES, Math.floor(context / 5)))
  const maxLines = Math.max(MIN_LINES, Math.floor((MAX_LINES * maxBytes) / MAX_BYTES))
  return { maxLines, maxBytes }
}

/**
 * How many of the first `items` fit `maxBytes`, each counted with the newline that follows it; at least one when
 * there is any, so a list always shows something.
 */
export function fitItems(items: readonly string[], maxBytes: number): number {
  let used = 0
  for (let index = 0; index < items.length; index++) {
    used += Buffer.byteLength(items[index], "utf-8") + 1
    if (used > maxBytes) return Math.max(1, index)
  }
  return items.length
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What a result says when its full text could not be written to disk. */
export function unsavedNote(reason: string): string {
  return `Full output could not be saved: ${reason}. The omitted part cannot be read back; repeat the call with a narrower scope.`
}

/** The first non-blank line of a write error, at most 200 characters: one short reason a note can carry. */
function reasonOf(error: unknown): string {
  const line = errorMessage(error)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "")
  return headChars(line ?? "unknown error", 200)
}

function codePoints(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
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
  let shownChars = 0
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      if (out.length === 0) {
        lineBytes = Buffer.byteLength(lines[i], "utf-8")
        const cut = headBytes(lines[i], maxBytes)
        out.push(cut)
        bytes = Buffer.byteLength(cut, "utf-8")
        shownChars = codePoints(cut)
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
      shownChars,
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
  let shownChars = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      if (out.length === 0) {
        lineBytes = Buffer.byteLength(lines[i], "utf-8")
        const cut = tailBytes(lines[i], maxBytes)
        out.unshift(cut)
        bytes = Buffer.byteLength(cut, "utf-8")
        shownChars = codePoints(cut)
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
      shownChars,
    },
  }
}

/**
 * A preview that is a slice of one line. A cut first line continues from the
 * character after the last one shown, and says how many lines come after it.
 */
function partialLineNotice(file: string, details: Details): string {
  const edge = details.direction === "head" ? "first" : "last"
  const first =
    `[truncated: showing the ${edge} ${formatSize(details.outputBytes)} of line ${details.startLine} ` +
    `(line is ${formatSize(details.lineBytes)}; ${formatSize(details.totalBytes)} total output). Full output: ${file}]`
  if (details.direction === "tail")
    return [
      first,
      `Continue: read filePath="${file}" offset=${details.startLine} limit=1 maxLineLength=${MAX_LINE_FETCH}; ` +
        `use the shell tool for characters beyond that.`,
    ].join("\n")

  const after = details.totalLines - 1
  return [
    first,
    `Continue this line: read filePath="${file}" offset=1 limit=1 charOffset=${details.shownChars + 1} ` +
      `maxLineLength=${MAX_LINE_FETCH}`,
    ...(after > 0 ? [`${after} more lines follow it; read them with: read filePath="${file}" offset=2`] : []),
  ].join("\n")
}

/**
 * The one truncation notice every tool uses: what was omitted, where the full
 * output is, and the exact parameters that continue reading it.
 */
export function notice(file: string, details: Details): string {
  if (details.partialLine) return partialLineNotice(file, details)

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

/** The preview of a text whose full copy could not be saved: it says so where the saved path would have been. */
function unsavedOutput(preview: string, details: Details, reason: string) {
  const note = `[truncated: ${unsavedNote(reason)}]`
  return {
    content: details.direction === "head" ? `${preview}\n\n${note}` : `${note}\n\n${preview}`,
    truncated: true,
    outputPath: undefined,
    unsaved: reason,
    details,
  } as const
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

    const writeBytes = Effect.fn("Truncate.writeBytes")(function* (bytes: Uint8Array, extension: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending() + extension)
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFile(file, bytes).pipe(Effect.orDie)
      return file
    })

    const save = Effect.fn("Truncate.save")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      return yield* fs.ensureDir(TRUNCATION_DIR).pipe(
        Effect.andThen(fs.writeFileString(file, text)),
        Effect.as<Saved>({ path: file }),
        Effect.catch((error) => Effect.succeed<Saved>({ failed: reasonOf(error) })),
      )
    })

    const limits = Effect.fn("Truncate.limits")(function* (input?: { context?: number }) {
      const derived =
        input?.context === undefined ? { maxLines: MAX_LINES, maxBytes: MAX_BYTES } : budgetFor(input.context)
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return derived
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? derived.maxLines,
        maxBytes: cfg?.tool_output?.max_bytes ?? derived.maxBytes,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, _agent?: Agent.Info) {
      const resolved = yield* limits({ context: options.context })
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const preview =
        direction === "head" ? headPreview(text, maxLines, maxBytes) : tailPreview(text, maxLines, maxBytes)
      if (!preview.cut || !preview.details) return { content: text, truncated: false } as const

      const saved = yield* save(text)
      if ("failed" in saved) return unsavedOutput(preview.text, preview.details, saved.failed)
      const hint = notice(saved.path, preview.details)
      return {
        content: direction === "head" ? `${preview.text}\n\n${hint}` : `${hint}\n\n${preview.text}`,
        truncated: true,
        outputPath: saved.path,
        details: preview.details,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, writeBytes, save, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(NodePath.layer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Truncate from "./truncate"
