// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { TrackCoordinator } from "../../src/snapshot/track-coordinator"

const scoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

test("requests arriving during a run share one next batch", async () => {
  const result = await scoped(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* TrackCoordinator.make(() =>
        Effect.gen(function* () {
          runs += 1
          const current = runs
          if (current === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }
          return `tree-${current}`
        }),
      )

      const first = yield* Effect.forkScoped(coordinator.track())
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(coordinator.track())
      const third = yield* Effect.forkScoped(coordinator.track())
      yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)

      return {
        first: yield* Fiber.join(first),
        second: yield* Fiber.join(second),
        third: yield* Fiber.join(third),
        runs,
      }
    }),
  )

  expect(result).toEqual({ first: "tree-1", second: "tree-2", third: "tree-2", runs: 2 })
})

test("sequential requests always run again", async () => {
  const result = await scoped(
    Effect.gen(function* () {
      let runs = 0
      const coordinator = yield* TrackCoordinator.make(() => Effect.sync(() => ++runs))
      return [yield* coordinator.track(), yield* coordinator.track(), runs] as const
    }),
  )
  expect(result).toEqual([1, 2, 2])
})

test("a failed batch fails every waiter and the coordinator keeps serving", async () => {
  const result = await scoped(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* TrackCoordinator.make(() =>
        Effect.gen(function* () {
          runs += 1
          if (runs === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return 1
          }
          if (runs === 2) return yield* Effect.fail("boom")
          return 3
        }),
      )

      const first = yield* Effect.forkScoped(coordinator.track())
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(coordinator.track())
      const third = yield* Effect.forkScoped(coordinator.track())
      yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)

      const [firstExit, secondExit, thirdExit] = yield* Effect.all([
        Fiber.await(first),
        Fiber.await(second),
        Fiber.await(third),
      ])
      return { firstExit, secondExit, thirdExit, next: yield* coordinator.track(), runs }
    }),
  )

  expect(Exit.isSuccess(result.firstExit)).toBe(true)
  expect(result.secondExit).toMatchObject({ _tag: "Failure" })
  expect(result.thirdExit).toMatchObject({ _tag: "Failure" })
  expect(result.next).toBe(3)
  expect(result.runs).toBe(3)
})

test("interrupting a waiter does not cancel its batch", async () => {
  const result = await scoped(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* TrackCoordinator.make(() =>
        Effect.gen(function* () {
          runs += 1
          const current = runs
          if (current === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }
          return current
        }),
      )

      const first = yield* Effect.forkScoped(coordinator.track())
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(coordinator.track())
      yield* Effect.yieldNow
      yield* Fiber.interrupt(first)
      yield* Deferred.succeed(gate, undefined)

      return { second: yield* Fiber.join(second), runs }
    }),
  )

  expect(result).toEqual({ second: 2, runs: 2 })
})

test("closing the state scope fails waiting requests instead of stranding them", async () => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const started = yield* Deferred.make<void>()
      const coordinator = yield* TrackCoordinator.make(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope))

      const waiter = yield* coordinator.track().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)

      return yield* Fiber.await(waiter).pipe(Effect.timeoutOption("2 seconds"))
    }),
  )

  expect(Option.isSome(exit)).toBe(true)
  if (Option.isNone(exit)) return
  expect(Exit.isFailure(exit.value)).toBe(true)
})
