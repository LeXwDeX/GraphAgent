import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const dir = path.join(Global.Path.data, "storage")

const it = testEffect(Layer.mergeAll(Storage.defaultLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const scope = Effect.fnUntraced(function* () {
  const root = ["storage_test", crypto.randomUUID()]
  const fs = yield* FSUtil.Service
  const svc = yield* Storage.Service
  yield* Effect.addFinalizer(() =>
    fs.remove(path.join(dir, ...root), { recursive: true, force: true }).pipe(Effect.ignore),
  )
  return { root, svc }
})

describe("Storage", () => {
  it.live("round-trips JSON content", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "session_diff", "roundtrip"]
      const value = [{ file: "a.ts", additions: 2, deletions: 1 }]

      yield* svc.write(key, value)
      expect(yield* svc.read<typeof value>(key)).toEqual(value)
    }),
  )

  it.live("maps missing reads to NotFoundError", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const error = yield* Effect.flip(svc.read([...root, "missing", "value"]))
      expect(error).toBeInstanceOf(Storage.NotFoundError)
      expect(error._tag).toBe("NotFoundError")
      expect(error.message).toContain(path.join(...root, "missing", "value") + ".json")
    }),
  )

  it.live("update on missing key throws NotFoundError", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const error = yield* Effect.flip(
        svc.update<{ value: number }>([...root, "missing", "key"], (draft) => {
          draft.value += 1
        }),
      )
      expect(error).toBeInstanceOf(Storage.NotFoundError)
      expect(error._tag).toBe("NotFoundError")
    }),
  )

  it.live("write overwrites existing value", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "overwrite", "test"]

      yield* svc.write<{ v: number }>(key, { v: 1 })
      yield* svc.write<{ v: number }>(key, { v: 2 })

      expect(yield* svc.read<{ v: number }>(key)).toEqual({ v: 2 })
    }),
  )

  it.live("remove on missing key is a no-op", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      yield* svc.remove([...root, "nonexistent", "key"])
    }),
  )

  it.live("list on missing prefix returns empty", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      expect(yield* svc.list([...root, "nonexistent"])).toEqual([])
    }),
  )

  it.live("serializes concurrent updates for the same key", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "counter", "shared"]

      yield* svc.write(key, { value: 0 })

      yield* Effect.all(
        Array.from({ length: 25 }, () =>
          svc.update<{ value: number }>(key, (draft) => {
            draft.value += 1
          }),
        ),
        { concurrency: "unbounded" },
      )

      expect(yield* svc.read<{ value: number }>(key)).toEqual({ value: 25 })
    }),
  )

  it.live("concurrent reads do not block each other", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "concurrent", "reads"]

      yield* svc.write(key, { ok: true })

      const results = yield* Effect.all(
        Array.from({ length: 10 }, () => svc.read(key)),
        { concurrency: "unbounded" },
      )

      expect(results).toHaveLength(10)
      for (const r of results) expect(r).toEqual({ ok: true })
    }),
  )

  it.live("nested keys create deep paths", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "a", "b", "c", "deep"]

      yield* svc.write<{ nested: boolean }>(key, { nested: true })

      expect(yield* svc.read<{ nested: boolean }>(key)).toEqual({ nested: true })
      expect(yield* svc.list([...root, "a"])).toEqual([key])
    }),
  )

  it.live("lists and removes stored entries", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const a = [...root, "list", "a"]
      const b = [...root, "list", "b"]
      const prefix = [...root, "list"]

      yield* svc.write(b, { value: 2 })
      yield* svc.write(a, { value: 1 })

      expect(yield* svc.list(prefix)).toEqual([a, b])

      yield* svc.remove(a)

      expect(yield* svc.list(prefix)).toEqual([b])
      const exit = yield* svc.read(a).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

})
