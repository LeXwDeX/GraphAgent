import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { adaptiveSettleMs, makeRewriteScheduler } from "../../src/session/reasoning-distillation/schedule"

import * as TestClock from "effect/testing/TestClock"
import { it } from "../lib/effect"
import { Flag } from "../../src/flag/flag"

const run = <A>(body: (scope: Scope.Scope) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* body(yield* Scope.Scope)
      }),
    ),
  )

const enabled = Effect.succeed(true)

test("a barrier collects adopted results once and leaves nothing pending", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      for (const key of ["a", "b"])
        yield* scheduler.submit({
          sessionID: "s",
          key,
          inputCharacters: 100,
          enabled,
          run: (canAdopt) => canAdopt.pipe(Effect.map((ok) => (ok ? `adopted-${key}` : undefined))),
        })
      expect((yield* scheduler.settle("s")).toSorted()).toEqual(["adopted-a", "adopted-b"])
      expect(scheduler.pending("s")).toBe(0)
      expect(yield* scheduler.settle("s")).toEqual([])
      expect(yield* scheduler.settle("other")).toEqual([])
    }),
  ))

test("a barrier waits for in-flight work finishing within the settle window", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 2_000 })
      const started = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "a",
        inputCharacters: 100,
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep("30 millis")
            return (yield* canAdopt) ? "late-but-in-window" : undefined
          }),
      })
      yield* Deferred.await(started)
      expect(yield* scheduler.settle("s")).toEqual(["late-but-in-window"])
    }),
  ))

test("work still organizing after the window is sealed, interrupted and can never adopt", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 20 })
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let captured: Effect.Effect<boolean> | undefined
      yield* scheduler.submit({
        sessionID: "s",
        key: "slow",
        inputCharacters: 100,
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            captured = canAdopt
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
            return "never"
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      })
      yield* Deferred.await(started)
      const begun = performance.now()
      expect(yield* scheduler.settle("s")).toEqual([])
      expect(performance.now() - begun).toBeLessThan(1_000)
      yield* Deferred.await(interrupted)
      expect(yield* captured!).toBe(false)
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("an adoption that passed the seal check is awaited and included", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0 })
      const adopting = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "a",
        inputCharacters: 100,
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            if (!(yield* canAdopt)) return undefined
            yield* Deferred.succeed(adopting, undefined)
            yield* Effect.sleep("30 millis")
            return "committed"
          }),
      })
      yield* Deferred.await(adopting)
      expect(yield* scheduler.settle("s")).toEqual(["committed"])
    }),
  ))

test("a zero window seals pending work immediately", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0, concurrency: 1 })
      const release = yield* Deferred.make<void>()
      const results: (string | undefined)[] = []
      for (const key of ["a", "b"])
        yield* scheduler.submit({
          sessionID: "s",
          key,
          inputCharacters: 100,
          enabled,
          run: (canAdopt) =>
            Effect.gen(function* () {
              yield* Deferred.await(release)
              const value = (yield* canAdopt) ? key : undefined
              results.push(value)
              return value
            }),
        })
      expect(yield* scheduler.settle("s")).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep("20 millis")
      expect(results.every((value) => value === undefined)).toBe(true)
    }),
  ))

test("disabled work is not scheduled and disabling later blocks adoption", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      let ran = false
      yield* scheduler.submit({
        sessionID: "s",
        key: "off",
        inputCharacters: 100,
        enabled: Effect.succeed(false),
        run: () => Effect.sync(() => (ran = true)).pipe(Effect.as("x")),
      })
      expect(ran).toBe(false)
      expect(scheduler.pending("s")).toBe(0)
      let on = true
      const started = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "toggled",
        inputCharacters: 100,
        enabled: Effect.sync(() => on),
        run: (canAdopt) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(proceed)
            return (yield* canAdopt) ? "adopted" : undefined
          }),
      })
      yield* Deferred.await(started)
      on = false
      yield* Deferred.succeed(proceed, undefined)
      expect(yield* scheduler.settle("s")).toEqual([])
    }),
  ))

test("concurrency is bounded per session, duplicates are ignored and sessions are independent", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 2_000, concurrency: 2 })
      let active = 0
      let peak = 0
      let calls = 0
      const job = (sessionID: string, key: string) =>
        scheduler.submit({
          sessionID,
          key,
          inputCharacters: 100,
          enabled,
          run: () =>
            Effect.gen(function* () {
              calls++
              active++
              peak = Math.max(peak, active)
              yield* Effect.sleep("15 millis")
              active--
              return `${sessionID}:${key}`
            }),
        })
      for (const key of ["a", "b", "c", "d"]) yield* job("s", key)
      yield* job("s", "a")
      yield* job("t", "a")
      expect((yield* scheduler.settle("s")).toSorted()).toEqual(["s:a", "s:b", "s:c", "s:d"])
      expect(yield* scheduler.settle("t")).toEqual(["t:a"])
      expect(calls).toBe(5)
      expect(peak).toBeLessThanOrEqual(3)
    }),
  ))

test("finished work that adopted nothing is dropped without waiting for a barrier", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      const done = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "skipped",
        inputCharacters: 100,
        enabled,
        run: () => Deferred.succeed(done, undefined).pipe(Effect.as(undefined)),
      })
      yield* scheduler.submit({
        sessionID: "s",
        key: "adopted",
        inputCharacters: 100,
        enabled,
        run: () => Effect.succeed("kept"),
      })
      yield* Deferred.await(done)
      yield* Effect.sleep("10 millis")
      expect(scheduler.pending("s")).toBe(1)
      expect(yield* scheduler.settle("s")).toEqual(["kept"])
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("cancelling a deleted session seals and interrupts its work without touching other sessions", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      const started = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "deleted",
        key: "slow",
        inputCharacters: 100,
        enabled,
        run: (canAdopt) =>
          Deferred.succeed(started, true).pipe(
            Effect.andThen(Effect.never),
            Effect.andThen(canAdopt),
            Effect.map((ok) => (ok ? "never" : undefined)),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      })
      yield* scheduler.submit({
        sessionID: "kept",
        key: "a",
        inputCharacters: 100,
        enabled,
        run: (canAdopt) => canAdopt.pipe(Effect.map((ok) => (ok ? "kept-a" : undefined))),
      })
      yield* Deferred.await(started)
      yield* scheduler.cancel("deleted")
      yield* Deferred.await(interrupted)
      expect(scheduler.pending("deleted")).toBe(0)
      expect(yield* scheduler.settle("deleted")).toEqual([])
      expect(yield* scheduler.settle("kept")).toEqual(["kept-a"])
      yield* scheduler.cancel("missing")
    }),
  ))

test("adaptive response-start window scales by waiting characters and stays within 3–15 seconds", () => {
  expect([0, 1, 4_000, 4_001, 8_000, 8_001, 12_001, 16_001, 100_000].map(adaptiveSettleMs)).toEqual([
    3_000, 3_000, 3_000, 6_000, 6_000, 9_000, 12_000, 15_000, 15_000,
  ])
})

test("a response starting inside the window may finish well after the window", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 30 })
      yield* scheduler.submit({
        sessionID: "s",
        key: "stream",
        inputCharacters: 8_001,
        enabled,
        run: (canAdopt, onResponseStarted) =>
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis")
            onResponseStarted()
            yield* Effect.sleep("80 millis")
            return (yield* canAdopt) ? "complete-stream" : undefined
          }),
      })
      expect(yield* scheduler.settle("s")).toEqual(["complete-stream"])
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("a zero window finishes an already started stream and seals a queued request", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0, concurrency: 1 })
      const started = yield* Deferred.make<void>()
      let queuedRan = false
      yield* scheduler.submit({
        sessionID: "s",
        key: "stream",
        inputCharacters: 100,
        enabled,
        run: (canAdopt, onResponseStarted) =>
          Effect.gen(function* () {
            onResponseStarted()
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep("30 millis")
            return (yield* canAdopt) ? "complete-stream" : undefined
          }),
      })
      yield* Deferred.await(started)
      yield* scheduler.submit({
        sessionID: "s",
        key: "queued",
        inputCharacters: 100,
        enabled,
        run: () =>
          Effect.sync(() => {
            queuedRan = true
            return "unexpected"
          }),
      })
      expect(yield* scheduler.settle("s")).toEqual(["complete-stream"])
      expect(queuedRan).toBe(false)
    }),
  ))

test("a response-start callback arriving after sealing cannot revive the job", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0 })
      const started = yield* Deferred.make<void>()
      let notify: (() => void) | undefined
      let check: Effect.Effect<boolean> | undefined
      yield* scheduler.submit({
        sessionID: "s",
        key: "late",
        inputCharacters: 100,
        enabled,
        run: (canAdopt, onResponseStarted) =>
          Effect.gen(function* () {
            notify = onResponseStarted
            check = canAdopt
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
            return "unexpected"
          }),
      })
      yield* Deferred.await(started)
      expect(yield* scheduler.settle("s")).toEqual([])
      notify!()
      expect(yield* check!).toBe(false)
      expect(yield* scheduler.settle("s")).toEqual([])
    }),
  ))

test("session deletion interrupts a started stream and blocks later adoption", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0 })
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let check: Effect.Effect<boolean> | undefined
      yield* scheduler.submit({
        sessionID: "s",
        key: "stream",
        inputCharacters: 100,
        enabled,
        run: (canAdopt, onResponseStarted) =>
          Effect.gen(function* () {
            check = canAdopt
            onResponseStarted()
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
            return "unexpected"
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      })
      yield* Deferred.await(started)
      yield* scheduler.cancel("s")
      yield* Deferred.await(interrupted)
      expect(yield* check!).toBe(false)
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("failure without a response releases the start barrier immediately", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => undefined })
      yield* scheduler.submit({
        sessionID: "s",
        key: "failure",
        inputCharacters: 100_000,
        enabled,
        run: () => Effect.fail(new Error("unavailable")),
      })
      const started = performance.now()
      expect(yield* scheduler.settle("s")).toEqual([])
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("unset and invalid window overrides are adaptive; explicit nonnegative integers are retained", () => {
  const previous = process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS
  try {
    for (const value of [undefined, "", " ", "bad", "-1", "1.5", "Infinity"]) {
      if (value === undefined) delete process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS
      else process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS = value
      expect(Flag.OPENCODE_REASONING_DISTILLATION_SETTLE_MS).toBeUndefined()
    }
    for (const value of ["0", "20", "30000"]) {
      process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS = value
      expect(Flag.OPENCODE_REASONING_DISTILLATION_SETTLE_MS).toBe(Number(value))
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS
    else process.env.OPENCODE_REASONING_DISTILLATION_SETTLE_MS = previous
  }
})

it.effect("completed and streaming source sizes do not inflate the adaptive start window", () =>
  Effect.gen(function* () {
    const scheduler = makeRewriteScheduler<string>(yield* Scope.Scope, { settleMs: () => undefined })
    const active = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    yield* scheduler.submit({
      sessionID: "s",
      key: "done",
      inputCharacters: 100_000,
      enabled,
      run: (canAdopt) => canAdopt.pipe(Effect.as("done")),
    })
    yield* scheduler.submit({
      sessionID: "s",
      key: "stream",
      inputCharacters: 100_000,
      enabled,
      run: (canAdopt, onResponseStarted) =>
        Effect.gen(function* () {
          onResponseStarted()
          yield* Deferred.succeed(active, undefined)
          yield* Deferred.await(finish)
          return (yield* canAdopt) ? "stream" : undefined
        }),
    })
    yield* Deferred.await(active)
    let check: Effect.Effect<boolean> | undefined
    const waiting = yield* Deferred.make<void>()
    yield* scheduler.submit({
      sessionID: "s",
      key: "waiting",
      inputCharacters: 100,
      enabled,
      run: (canAdopt) =>
        Effect.gen(function* () {
          check = canAdopt
          yield* Deferred.succeed(waiting, undefined)
          yield* Effect.never
          return "never"
        }),
    })
    yield* Deferred.await(waiting)
    const barrier = yield* scheduler.settle("s").pipe(Effect.forkChild)
    yield* TestClock.adjust("3 seconds")
    expect(yield* check!).toBe(false)
    yield* Deferred.succeed(finish, undefined)
    expect((yield* Fiber.join(barrier)).toSorted()).toEqual(["done", "stream"])
  }),
)
