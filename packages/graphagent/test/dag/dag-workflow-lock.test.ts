import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"

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
    Dag.layer.pipe(Layer.provide(events), Layer.provide(store)),
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
    const layer = Dag.layer.pipe(Layer.provide(events), Layer.provide(store))

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

        yield* Effect.all(
          [dag.extend("wf1", [node("first")]), dag.extend("wf1", [node("second")])],
          { concurrency: "unbounded" },
        )

        expect(maxActiveReads).toBe(1)
      }).pipe(Effect.provide(layer)) as Effect.Effect<never>,
    )
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
})
