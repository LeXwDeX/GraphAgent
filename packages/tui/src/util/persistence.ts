import path from "path"
import { appendFile, mkdir, rename, rm } from "fs/promises"

export function readText(filePath: string) {
  return Bun.file(filePath).text()
}

export function readJson<T>(filePath: string) {
  return Bun.file(filePath).json() as Promise<T>
}

/**
 * Writes to one file run one at a time, in the order they were issued. `Bun.write` and `appendFile` are separate
 * asynchronous operations, and two calls left alone reach the disk in either order: an append issued after a rewrite
 * can land first and be truncated by it, and one issued before it can land after it and repeat a line it holds.
 * This keeps, per file, the end of the last write queued, until the file has none left.
 */
const pending = new Map<string, Promise<void>>()

/** Runs `write` once every write queued for the same file before it has ended, whether it succeeded or not. */
function queued(filePath: string, write: () => Promise<void>) {
  const key = path.resolve(filePath)
  const result = (pending.get(key) ?? Promise.resolve()).then(write)
  // The next write waits for this one's end, not its outcome; the caller gets the outcome from `result`.
  const ended = result.then(
    () => undefined,
    () => undefined,
  )
  pending.set(key, ended)
  void ended.then(() => {
    if (pending.get(key) === ended) pending.delete(key)
  })
  return result
}

/**
 * Replaces the file. Writes to one file, these and `appendText`, run one at a time in the order they were issued;
 * a failed write does not hold up the ones behind it, and each call's promise reports its own write.
 */
export function writeText(filePath: string, content: string) {
  return queued(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    await Bun.write(filePath, content)
  })
}

/** Appends to the file, in the order `writeText` documents. */
export function appendText(filePath: string, content: string) {
  return queued(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    await appendFile(filePath, content)
  })
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(value)).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await rename(temporary, filePath).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}
