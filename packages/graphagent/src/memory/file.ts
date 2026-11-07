export * as MemoryFile from "./file"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

export const atomicWrite = Effect.fn("MemoryFile.atomicWrite")(function* (
  fs: FSUtil.Interface,
  file: string,
  content: string,
) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(file), { recursive: true })
    yield* fs.writeFileString(temporary, content)
    yield* fs.rename(temporary, file)
  }).pipe(
    Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    Effect.uninterruptible,
  )
})
