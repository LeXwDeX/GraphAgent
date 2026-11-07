import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CompactionTimeoutError, watchCompactionStream } from "@/session/compaction-timeout"
import { it } from "../lib/effect"

describe("compaction inactivity", () => {
  it.effect("times out a silent stream and interrupts its upstream", () =>
    Effect.gen(function* () {
      let interrupted = false
      const source = Stream.fromEffect(
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        ),
      )
      const fiber = yield* watchCompactionStream(source, "1 second").pipe(Stream.runDrain, Effect.forkChild)
      yield* TestClock.adjust("1 second")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(CompactionTimeoutError)
      expect(interrupted).toBe(true)
    }),
  )

  it.effect("reasoning progress can exceed the inactivity deadline in total", () =>
    Effect.gen(function* () {
      const events: string[] = []
      const done = yield* Deferred.make<void>()
      const source = Stream.fromIterable([
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "text",
      ]).pipe(Stream.mapEffect((event) => Effect.sleep("500 millis").pipe(Effect.as(event))))
      const fiber = yield* watchCompactionStream(source, "1 second").pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
          }),
        ),
        Effect.ensuring(Deferred.succeed(done, undefined)),
        Effect.forkChild,
      )
      yield* TestClock.adjust("3 seconds")
      yield* Deferred.await(done)
      yield* Fiber.join(fiber)
      expect(events).toEqual(["reasoning-start", "reasoning-delta", "reasoning-delta", "reasoning-end", "text"])
    }),
  )

  it.effect("a reasoning-start cannot hide an indefinitely stalled stream", () =>
    Effect.gen(function* () {
      const source = Stream.make("reasoning-start").pipe(Stream.concat(Stream.never))
      const fiber = yield* watchCompactionStream(source, "1 second").pipe(Stream.runDrain, Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(CompactionTimeoutError)
    }),
  )

  it.effect("user cancellation remains interruption, not a timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* watchCompactionStream(Stream.never).pipe(Stream.runDrain, Effect.forkChild)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }),
  )
})
