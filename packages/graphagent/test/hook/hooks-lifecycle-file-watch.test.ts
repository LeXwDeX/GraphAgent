import { expect } from "bun:test"
import { Effect, Deferred } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HookFileWatch } from "@/hook/file-watch"
import { testEffect, awaitWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
const it = testEffect(HookFileWatch.layer)
it.instance("external filesystem writes reach the owning session and dynamic paths replace safely", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const one = path.join(directory, "one.txt")
    const two = path.join(directory, "two.txt")
    yield* Effect.promise(() => Promise.all([fs.writeFile(one, "before"), fs.writeFile(two, "before")]))
    const watch = yield* HookFileWatch.Service
    const first = yield* Deferred.make<void>()
    const second = yield* Deferred.make<void>()
    const received: string[] = []
    const changed = (file: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        received.push(file)
        if (file === one) {
          // Replacing the watcher from its own callback must not interrupt itself.
          yield* watch.replace("session-a", [two], changed)
          yield* Deferred.succeed(first, undefined)
        } else yield* Deferred.succeed(second, undefined)
      })
    yield* watch.replace("session-a", [one], changed)
    yield* Effect.promise(() => fs.writeFile(one, "external-first"))
    yield* awaitWithTimeout(Deferred.await(first), "first external change was not delivered")
    yield* Effect.promise(() => fs.writeFile(two, "external-second"))
    yield* awaitWithTimeout(Deferred.await(second), "replacement change was not delivered")
    expect(received).toEqual([one, two])
    yield* watch.clear("session-a")
  }),
)
