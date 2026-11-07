import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { makeReasoningQueue } from "@/session/reasoning-queue"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live("background reasoning never waits for unfinished jobs and commits only at a later boundary", () =>
  Effect.gen(function* () {
    const queue = yield* makeReasoningQueue
    const release = yield* Deferred.make<void>()
    let committed = 0
    const job = Deferred.await(release).pipe(
      Effect.as(
        Effect.sync(() => {
          committed++
        }),
      ),
    )
    yield* queue.enqueue("s", "p", job)
    yield* queue.drain("s")
    expect(committed).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* pollWithTimeout(queue.drain("s").pipe(Effect.map(() => committed || undefined)), "candidate never committed")
    expect(committed).toBe(1)
    yield* queue.drain("s")
    expect(committed).toBe(1)
  }),
)

it.live("background reasoning limits each session to two organizers and deduplicates parts", () =>
  Effect.gen(function* () {
    const queue = yield* makeReasoningQueue
    const started = yield* Deferred.make<void>()
    let count = 0
    const job = Effect.sync(() => {
      if (++count === 3) Deferred.doneUnsafe(started, Effect.void)
    }).pipe(Effect.andThen(Effect.never))
    yield* queue.enqueue("s", "p1", job)
    yield* queue.enqueue("s", "p1", job)
    yield* queue.enqueue("s", "p2", job)
    yield* queue.enqueue("s", "p3", job)
    yield* queue.enqueue("other", "p1", job)
    yield* Deferred.await(started)
    expect(count).toBe(3)
  }),
)

it.live("turn interruption preserves organizers and session deletion cancels them", () =>
  Effect.gen(function* () {
    const queue = yield* makeReasoningQueue
    const started = yield* Deferred.make<void>()
    let cancelled = false
    const job = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          cancelled = true
        }),
      ),
    )
    const turn = yield* queue.enqueue("s", "p", job).pipe(Effect.andThen(Effect.never), Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(turn)
    expect(cancelled).toBe(false)
    yield* queue.cancel("s")
    expect(cancelled).toBe(true)
    yield* queue.drain("s")
  }),
)

it.live("organizer and adoption defects fail open without blocking subsequent candidates", () =>
  Effect.gen(function* () {
    const queue = yield* makeReasoningQueue
    yield* queue.enqueue("broken", "p1", Effect.die(new Error("organizer defect")))
    yield* queue.enqueue("s", "p1", Effect.succeed(Effect.die(new Error("adoption defect"))))
    let committed = false
    yield* queue.enqueue(
      "s",
      "p2",
      Effect.succeed(
        Effect.sync(() => {
          committed = true
        }),
      ),
    )
    yield* pollWithTimeout(queue.drain("s").pipe(Effect.map(() => committed || undefined)), "candidate never committed")
    yield* queue.drain("broken")
    expect(committed).toBe(true)
  }),
)

it.live("turn interruption preserves the interrupted commit and all remaining ready candidates", () =>
  Effect.gen(function* () {
    const queue = yield* makeReasoningQueue
    const started = yield* Deferred.make<void>()
    let organized = 0
    let attempts = 0
    const committed: string[] = []
    for (const key of ["p1", "p2"])
      yield* queue.enqueue(
        "s",
        key,
        Effect.sync(() => {
          organized++
          return Effect.gen(function* () {
            if (key === "p1" && ++attempts === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }
            committed.push(key)
          })
        }),
      )
    yield* pollWithTimeout(
      Effect.sync(() => (organized === 2 ? true : undefined)),
      "candidates never organized",
    )
    const turn = yield* queue.drain("s").pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(turn)
    expect(committed).toEqual([])
    yield* queue.drain("s")
    expect(committed).toEqual(["p1", "p2"])
    expect(attempts).toBe(2)
    yield* queue.drain("s")
    expect(committed).toEqual(["p1", "p2"])
  }),
)
