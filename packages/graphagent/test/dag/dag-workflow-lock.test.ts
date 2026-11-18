// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagStore } from "@graphagent/core/dag/store"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { transactLayer } from "./fixture/transact"
import { testEffect } from "../lib/effect"

// The store and the bus are doubles; `Dag` still runs each command in the real transaction, over an in-memory
// database that only the transaction uses. A mock read that sleeps inside the critical section stands for a
// database read that takes too long, which is what the lock timeout guards against.
const transact = transactLayer(Database.layerFromPath(":memory:"))

// getWorkflow mock that sleeps past the lock timeout on the first call only, so
// a first guarded command exceeds WORKFLOW_LOCK_TIMEOUT while any subsequent
// command completes immediately. The first call's sleep is interrupted on
// timeout, but `slow` is flipped synchronously before the suspension, so the
// flag survives the interruption.
const slowFirstGetWorkflow = (config: string) => {
  let slow = true
  return () =>
    Effect.gen(function* () {
      if (slow) {
        slow = false
        yield* Effect.sleep("40 seconds")
      }
      return { id: "wf1", status: "running", config }
    }) as never
}

const lockTimeoutLayer = (getWorkflow: () => Effect.Effect<unknown>) => {
  const store = Layer.mock(DagStore.Service, {
    getWorkflow: getWorkflow as never,
    getNodes: () => Effect.succeed([]) as never,
  })
  const events = Layer.succeed(
    EventV2Bridge.Service,
    EventV2Bridge.Service.of({
      publish: () => Effect.succeed({ seq: 1 }),
      publishMany: () => Effect.succeed([]),
    } as never),
  )
  return Layer.mergeAll(
    Dag.layer.pipe(Layer.provide(events), Layer.provide(store), Layer.provide(transact)),
    TestClock.layer(),
  )
}

describe("Dag.Service workflow lock", () => {
  it("serializes concurrent extend operations for the same workflow", async () => {
    let activeReads = 0
    let maxActiveReads = 0
    const config = JSON.stringify({ name: "lock-test", nodes: [] })
    const store = Layer.mock(DagStore.Service, {
      getWorkflow: () =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            activeReads += 1
            maxActiveReads = Math.max(maxActiveReads, activeReads)
          })
          yield* Effect.sleep("25 millis").pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeReads -= 1
              }),
            ),
          )
          return { id: "wf1", status: "running", config }
        }) as never,
      getNodes: () => Effect.succeed([]) as never,
    })
    const events = Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: () => Effect.succeed({ seq: 1 }),
        publishMany: () => Effect.succeed([]),
      } as never),
    )
    const layer = Dag.layer.pipe(Layer.provide(events), Layer.provide(store), Layer.provide(transact))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const node = (id: string) => ({
          id,
          name: id,
          worker_type: "build",
          depends_on: [],
          required: true,
          prompt_template: { inline: id },
        })

        yield* Effect.all([dag.extend("wf1", [node("first")]), dag.extend("wf1", [node("second")])], {
          concurrency: "unbounded",
        })

        expect(maxActiveReads).toBe(1)
      }).pipe(Effect.provide(layer)) as Effect.Effect<never>,
    )
  })
})

const lockIt = testEffect(Layer.empty)

// #1344: DagCommandCore.make builds the layer's lock table and Dag.layer calls it once. Once dag.ts is split the
// commands live in separate modules, so a module that built its own Core would take a lock nobody else waits on.
// `exclusive` holds the workflow's lock from outside the commands; a command of any kind must queue behind it.
describe("Dag.Service workflow lock is shared by every command", () => {
  lockIt.effect("queues commands of every kind behind a held workflow lock", () => {
    let held = false
    let reads = 0
    let readsWhileHeld = 0
    const config = JSON.stringify({ name: "lock-shared", nodes: [] })
    const env = lockTimeoutLayer(() =>
      Effect.sync(() => {
        reads += 1
        if (held) readsWhileHeld += 1
        return { id: "wf1", status: "running", config }
      }),
    )

    return Effect.gen(function* () {
      const dag = yield* Dag.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const holder = yield* dag
            .exclusive(
              "wf1",
              Effect.gen(function* () {
                held = true
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                held = false
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)

          const node = {
            id: "next",
            name: "next",
            worker_type: "build",
            depends_on: [],
            required: true,
            prompt_template: { inline: "next" },
          }
          // pause, cancel and extend end up in three different modules; each one's first step reads the workflow.
          const commands = yield* Effect.all([dag.pause("wf1"), dag.cancel("wf1"), dag.extend("wf1", [node])], {
            concurrency: "unbounded",
            discard: true,
          }).pipe(Effect.forkScoped)
          // A command that did not queue behind the lock reaches its first read as soon as the fibers run.
          yield* TestClock.adjust("50 millis")
          expect(readsWhileHeld).toBe(0)
          expect(reads).toBe(0)

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          yield* Fiber.join(commands)
          // Released, all three ran: the check above was not vacuous.
          expect(reads).toBeGreaterThanOrEqual(3)
          expect(readsWhileHeld).toBe(0)
        }),
      )
    }).pipe(Effect.provide(env))
  })
})

describe("Dag.Service workflow lock timeout (ADR-0004)", () => {
  it("fails with a TimeoutException when the critical section exceeds WORKFLOW_LOCK_TIMEOUT", async () => {
    const config = JSON.stringify({ name: "lock-timeout", nodes: [] })
    const env = lockTimeoutLayer(slowFirstGetWorkflow(config))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* dag.pause("wf1").pipe(Effect.forkScoped)
            // Advance virtual time past both the body sleep (40s) and the lock
            // timeout (30s) so the timeout race fires deterministically.
            yield* TestClock.adjust("45 seconds")
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const failure = Cause.findErrorOption(exit.cause)
              expect(Option.isSome(failure)).toBe(true)
              if (Option.isSome(failure)) expect(Cause.isTimeoutError(failure.value)).toBe(true)
            }
          }),
        )
      }).pipe(Effect.provide(env)) as Effect.Effect<never>,
    )
  })

  it("releases the lock on timeout so a subsequent command succeeds (watchdog self-continuation)", async () => {
    const config = JSON.stringify({ name: "lock-timeout", nodes: [] })
    const env = lockTimeoutLayer(slowFirstGetWorkflow(config))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        // First call: body exceeds the lock timeout -> times out -> lock released.
        const drained = yield* Effect.scoped(
          Effect.gen(function* () {
            const timedOut = yield* dag.pause("wf1").pipe(Effect.forkScoped)
            yield* TestClock.adjust("45 seconds")
            return yield* Fiber.await(timedOut)
          }),
        )
        expect(Exit.isFailure(drained)).toBe(true)
        // Second call: the lock is free again, so the command succeeds. This is
        // the precondition for watchdog self-continuation — a transient lock
        // timeout never permanently freezes the workflow.
        const retried = yield* dag.pause("wf1").pipe(Effect.exit)
        expect(Exit.isSuccess(retried)).toBe(true)
      }).pipe(Effect.provide(env)) as Effect.Effect<never>,
    )
  })

  it("exclusive turns the lock timeout into a defect instead of a typed failure", async () => {
    const env = lockTimeoutLayer(slowFirstGetWorkflow(JSON.stringify({ name: "lock-timeout", nodes: [] })))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        // An external critical section holds no witness, so its timeout cannot
        // surface as a typed error the caller never declared.
        const timedOut = yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* dag.exclusive("wf1", Effect.sleep("40 seconds")).pipe(Effect.forkScoped)
            yield* TestClock.adjust("45 seconds")
            return yield* Fiber.await(fiber)
          }),
        )
        expect(Exit.isFailure(timedOut)).toBe(true)
        if (Exit.isFailure(timedOut)) {
          expect(Cause.hasFails(timedOut.cause)).toBe(false)
          const defect = Cause.findDefect(timedOut.cause)
          expect(defect._tag).toBe("Success")
          if (defect._tag === "Success") expect(Cause.isTimeoutError(defect.success)).toBe(true)
        }
        // The lock is released with the timeout: the next section runs.
        expect(yield* dag.exclusive("wf1", Effect.succeed("again"))).toBe("again")
      }).pipe(Effect.provide(env)),
    )
  })
})
