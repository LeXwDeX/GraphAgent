import { Effect, Option, Schema, Scope, Stream } from "effect"
import { PositiveInt } from "@graphagent/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@graphagent/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { FileState } from "@/session/file-state"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import type { Provider } from "@/provider/provider"
import { ModelContext } from "./model-context"
import * as Truncate from "./truncate"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const SAMPLE_BYTES = 4096
const MAX_PDF_BYTES = 10 * 1024 * 1024
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

class ReadStop extends Schema.TaggedError<ReadStop>()("ReadStop", {}) {}

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema requires positive integers; callers must send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Path to the file or directory to read; relative paths resolve from the project directory",
  }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "The line number or directory entry to start reading from (1-indexed positive integer)",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "The maximum number of lines or directory entries to read (positive integer, defaults to 2000)",
  }),
  page: Schema.optional(Schema.Int).annotate({
    description: `Read one page of the file (${Truncate.PAGE_LINES} lines, or limit when set): page 1 is the start, -1 is the last page, -2 the page before. Cannot be combined with offset`,
  }),
  maxLineLength: Schema.optional(PositiveInt).annotate({
    description: `Maximum characters to show from each line (defaults to ${MAX_LINE_LENGTH}, capped at ${Truncate.MAX_LINE_FETCH}); use it to continue a truncated long line`,
  }),
  charOffset: Schema.optional(PositiveInt).annotate({
    description:
      "Character offset within each displayed line (1-indexed); combine it with maxLineLength to continue a long line past the character cap",
  }),
})

/**
 * Why a media file cannot be attached, with the shell command that gets its content instead; `undefined` when it can.
 * Said here: left to the request, a file the model cannot take only turns into an error line one turn later (#1447).
 */
function attachmentRefusal(filepath: string, isImage: boolean, size: number, model: Provider.Model | undefined) {
  if (model && !model.capabilities.input[isImage ? "image" : "pdf"]) {
    const who = `${model.providerID}/${model.api.id}`
    return isImage
      ? `Cannot attach ${filepath}: ${who} does not accept image input. Inspect it with the shell tool: file "${filepath}"`
      : `Cannot attach ${filepath}: ${who} does not accept PDF input. Extract text with the shell tool: pdftotext -layout "${filepath}" -`
  }
  if (!isImage && size > MAX_PDF_BYTES)
    return `PDF ${filepath} is ${Truncate.formatSize(size)}, over the ${Truncate.formatSize(MAX_PDF_BYTES)} limit. Extract pages: pdftotext -f 1 -l 20 -layout "${filepath}" -`
  return undefined
}

const LINE_NOTICE_BUDGET = 512

/** Largest code-point prefix that fits the byte budget `maxBytes`, always at least one character. */
function fitLine(chars: readonly string[], start: number, end: number, maxBytes: number) {
  const budget = Math.max(1, maxBytes - LINE_NOTICE_BUDGET)
  const bytes = (to: number) => Buffer.byteLength(chars.slice(start, to).join(""), "utf8")
  if (bytes(end) <= budget) return end
  let low = start + 1
  let high = end
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(mid) <= budget) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * A line longer than the per-line budget states exactly how to fetch the rest
 * with the same tool: charOffset advances past the shown characters, so even a
 * line far beyond MAX_LINE_FETCH is reachable in bounded chunks.
 */
function lineSuffix(filepath: string, line: number, start: number, shown: number, total: number, chunk: number) {
  const next = start + shown + 1
  return (
    `... (line truncated to ${shown} of ${total} chars; ` +
    `continue with read filePath="${filepath}" offset=${line} limit=1 charOffset=${next} maxLineLength=${chunk})`
  )
}

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | FileState.Service | Truncate.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const fileState = yield* FileState.Service
    const trunc = yield* Truncate.Service
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      // A truncated result points at a saved file that the 7-day cleanup removes: say that, not "not found".
      if (dir === Truncate.DIR && base.startsWith("tool_"))
        return yield* Effect.fail(
          new Error(
            `Saved output has expired: ${filepath} was removed by the 7-day cleanup. Run the original command again to regenerate it.`,
          ),
        )
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}. Check the path with glob.`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // LSP warm-up is optional; do not let a background defect fail an otherwise successful read.
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (
      filepath: string,
      opts: { limit: number; offset: number; maxLineLength: number; maxBytes: number; charOffset?: number },
    ) {
      const start = opts.offset - 1
      const raw: string[] = []
      // `bytes` counts the file's text; `shown` counts what the page shows, which has a `<line>: ` prefix on each line.
      const flags = { bytes: 0, shown: 0, before: 0, count: 0, cut: false, more: false, done: false }

      // Note: prefer manual TextDecoder over Stream.decodeText — when the source stream
      // ends without flushing, decodeText drops the final unterminated line. We also
      // avoid Stream.runForEachWhile (it currently swallows the final unterminated
      // line of the upstream splitLines pipeline) and use a tagged error to stop the
      // upstream file stream as soon as the byte cap is reached.
      const decoder = new TextDecoder("utf-8")
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            if (flags.done) return yield* new ReadStop()
            flags.count += 1
            if (flags.count <= start) {
              flags.before += Buffer.byteLength(text, "utf-8") + 1
              return
            }

            if (raw.length >= opts.limit) {
              flags.more = true
              return
            }

            let line = text
            if (
              opts.charOffset !== undefined ||
              text.length > opts.maxLineLength ||
              Buffer.byteLength(text, "utf-8") > opts.maxBytes
            ) {
              const chars = Array.from(text)
              const from = Math.min(Math.max((opts.charOffset ?? 1) - 1, 0), chars.length)
              const to = fitLine(chars, from, Math.min(chars.length, from + opts.maxLineLength), opts.maxBytes)
              const shown = chars.slice(from, to).join("")
              line =
                to < chars.length
                  ? shown +
                    lineSuffix(
                      filepath,
                      flags.count,
                      from,
                      to - from,
                      chars.length,
                      Math.min(opts.maxLineLength, chars.length - to),
                    )
                  : shown
            }
            const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
            const prefix = String(flags.count).length + 2
            // The first line is always shown, so a budget smaller than one line cannot leave a page empty.
            if (raw.length === 0 || flags.shown + size + prefix <= opts.maxBytes) {
              raw.push(line)
              flags.bytes += size
              flags.shown += size + prefix
              return
            }

            flags.cut = true
            flags.more = true
            flags.done = true
            return yield* new ReadStop()
          }),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )

      return {
        raw,
        count: flags.count,
        bytes: flags.bytes,
        before: flags.before,
        cut: flags.cut,
        more: flags.more,
        offset: opts.offset,
      }
    })

    /** Total lines for a negative page; the read itself stays streaming. */
    const countFileLines = Effect.fn("ReadTool.countFileLines")(function* (filepath: string) {
      const decoder = new TextDecoder("utf-8")
      let count = 0
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach(() =>
          Effect.sync(() => {
            count += 1
          }),
        ),
      )
      return count
    })

    /** Maps a page number onto offset/limit; negative pages count from the end. */
    const resolvePage = Effect.fn("ReadTool.resolvePage")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      total?: number,
    ) {
      if (params.page === undefined) {
        return { offset: params.offset ?? 1, limit: params.limit ?? DEFAULT_READ_LIMIT }
      }
      if (params.offset !== undefined) {
        return yield* Effect.fail(new Error("Use page or offset, not both."))
      }
      if (params.page === 0) {
        return yield* Effect.fail(new Error("page must not be 0; use 1 for the first page or -1 for the last."))
      }
      const pageSize = params.limit ?? Truncate.PAGE_LINES
      if (params.page > 0) {
        return { offset: (params.page - 1) * pageSize + 1, limit: pageSize }
      }
      if (total === undefined) {
        return yield* Effect.fail(new Error("A negative page needs the total line count."))
      }
      // An empty file or directory still has one empty page. page=-1 is the
      // documented way to read that page, so return it instead of failing the
      // disjoint-page guard below.
      if (total === 0 && params.page === -1) return { offset: 1, limit: pageSize }
      const requested = total + params.page * pageSize + 1
      if (requested >= 1) return { offset: requested, limit: pageSize }
      // A page before the first one must not replay the start of the file. Keep
      // negative pages disjoint by returning only the lines before the next page.
      const limit = total - (Math.abs(params.page) - 1) * pageSize
      if (limit <= 0) {
        const pages = Math.max(1, Math.ceil(total / pageSize))
        return yield* Effect.fail(
          new Error(
            `page ${params.page} is before the first page; ${total} lines make ` +
              `${pages} ${pages === 1 ? "page" : "pages"} of ${pageSize} lines.`,
          ),
        )
      }
      return { offset: 1, limit }
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        // The pattern is folded (`link/../x` reads `x`); `filepath` is the path
        // every access below uses, which the kernel resolves link first.
        metadata: { filepath },
      })

      if (!stat) return yield* miss(filepath)

      // The caps of this read are the output budget of the model that asked.
      const limits = yield* trunc.limits({ context: ModelContext.contextOf(ctx.extra) })

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const page = yield* resolvePage(params, items.length)
        const offset = page.offset
        const start = offset - 1
        const range = items.slice(start, start + Math.min(page.limit, limits.maxLines))
        const sliced = range.slice(0, Truncate.fitItems(range, limits.maxBytes))
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Continue: read filePath="${filepath}" offset=${offset + sliced.length}.)`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
            display: {
              type: "directory" as const,
              path: filepath,
              entries: sliced,
              offset,
              totalEntries: items.length,
              truncated,
            },
          },
        }
      }

      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(filepath))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)
      const isMedia = isImage || isPdfAttachment(mime)
      // A refused read must not claim the nearby instruction files: nothing would carry them to the model.
      if (isMedia) {
        const refusal = attachmentRefusal(filepath, isImage, Number(stat.size), ModelContext.modelOf(ctx.extra))
        if (refusal) return yield* Effect.fail(new Error(refusal))
      }
      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)

      if (isMedia) {
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        // The nearby instructions are claimed as loaded, so they must reach the model here too (#1447).
        const reminder =
          loaded.length > 0
            ? `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
            : ""
        return {
          title,
          output: msg + reminder,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      // The record must describe the version this read consumes: freeze it before reading, and record only if the
      // file is still that version afterwards. Recording whatever is on disk later could hand the model's
      // authority to overwrite a version it never saw.
      const seen = yield* fileState.baseline(filepath)
      const total = params.page !== undefined && params.page < 0 ? yield* countFileLines(filepath) : undefined
      const page = yield* resolvePage(params, total)
      const file = yield* lines(filepath, {
        limit: Math.min(page.limit, limits.maxLines),
        offset: page.offset,
        maxLineLength: Math.min(params.maxLineLength ?? MAX_LINE_LENGTH, Truncate.MAX_LINE_FETCH),
        maxBytes: limits.maxBytes,
        charOffset: params.charOffset,
      })
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        const total = Number(stat.size)
        // Everything before `offset` is neither shown nor omitted *after* this
        // range; subtracting it keeps the notice honest for late reads.
        const omitted = Math.max(0, total - file.before - file.bytes)
        output +=
          `\n\n[truncated: showing lines ${file.offset}-${last} of a ${Truncate.formatSize(total)} file ` +
          `(${Number((limits.maxBytes / 1024).toFixed(2))} KB limit); about ${Truncate.formatSize(omitted)} omitted after this range. ` +
          `Continue: read filePath="${filepath}" offset=${next}.]`
      } else if (file.more) {
        output +=
          `\n\n[truncated: showing lines ${file.offset}-${last} of ${file.count}. ` +
          `${file.count - last} lines omitted after this range. ` +
          `Continue: read filePath="${filepath}" offset=${next}.]`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      yield* warm(filepath)
      if (seen) yield* fileState.record(ctx.sessionID, filepath, "read", seen)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          display: {
            type: "file" as const,
            path: filepath,
            text: file.raw.join("\n"),
            lineStart: file.offset,
            lineEnd: last,
            totalLines: file.count,
            truncated,
          },
        },
      }
    })

    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
