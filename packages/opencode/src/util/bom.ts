import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filePath: string) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(filePath)))
})

/**
 * Reads text that will be rewritten in place. Lenient decoding would turn every
 * non-UTF-8 byte (GBK, Latin-1, binary) into U+FFFD and write that back across
 * the whole file, so undecodable input is refused instead.
 */
export const readEditableFile = Effect.fn("Bom.readEditableFile")(function* (fs: FSUtil.Interface, filePath: string) {
  const bytes = yield* fs.readFile(filePath)
  try {
    return split(new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes))
  } catch {
    throw new Error(
      `${filePath} is not valid UTF-8 text. Editing it here would corrupt its non-UTF-8 bytes; use a shell tool that preserves the file's encoding (for example iconv) instead.`,
    )
  }
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (fs: FSUtil.Interface, filePath: string, bom: boolean) {
  const current = yield* readFile(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, join(current.text, bom))
  return current.text
})
