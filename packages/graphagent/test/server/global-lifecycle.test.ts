import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { logLines } from "effect/testing/TestConsole"
import { InstanceStore } from "@/project/instance-store"
import { GlobalLifecycle } from "@/server/global-lifecycle"
import { GlobalBus } from "@/bus/global"
import { it } from "../lib/effect"

function collectDisposed() {
  const events: string[] = []
  const handler = (event: { payload?: { type?: string } }) => {
    if (event.payload?.type === "global.disposed") events.push(event.payload.type)
  }
  GlobalBus.on("event", handler)
  return { events, stop: () => GlobalBus.off("event", handler) }
}

const wedgedStoreLayer = Layer.mock(InstanceStore.Service, {
  disposeAll: () => Effect.never,
})

// DAG-04 (#316): the production shutdown disposal was uninterruptible AND
// had no timeout — a wedged instance could hang the whole path forever (the
// httpapi exerciser already guards its cleanup steps with a 10s bounded
// guard; production had no equivalent). The dispose step is now bounded; a
// HANG is always abandoned (timeout → Option.none, never an error — the
// HttpApi dispose endpoint's error contract stays untouched), the Disposed
// event always lands, and genuine disposal failures still propagate for
// callers that do not swallow.
describe("GlobalLifecycle bounded disposal (DAG-04)", () => {
  it.effect("a wedged disposeAll is abandoned at the bounded timeout and the Disposed event still lands (swallow)", () =>
    Effect.acquireUseRelease(
      Effect.sync(collectDisposed),
      (collector) =>
        Effect.gen(function* () {
          const fiber = yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(
            Effect.forkScoped,
          )
          yield* TestClock.adjust("11 seconds")
          yield* Fiber.await(fiber)
          expect(collector.events).toEqual(["global.disposed"])
          expect(JSON.stringify(yield* logLines)).toContain("global disposal timed out")
        }).pipe(Effect.provide(wedgedStoreLayer)),
      (collector) => Effect.sync(collector.stop),
    ),
  )

  it.effect("a wedged disposeAll never hangs the non-swallow caller either", () =>
    Effect.acquireUseRelease(
      Effect.sync(collectDisposed),
      (collector) =>
        Effect.gen(function* () {
          const fiber = yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed().pipe(Effect.forkScoped)
          yield* TestClock.adjust("11 seconds")
          const exit = yield* Fiber.await(fiber)
          // A hang is abandonment, not failure — the caller completes and the
          // Disposed event lands (pre-fix this path hung forever).
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(collector.events).toEqual(["global.disposed"])
        }).pipe(Effect.provide(wedgedStoreLayer)),
      (collector) => Effect.sync(collector.stop),
    ),
  )

  it.effect("a genuine disposeAll failure still propagates when not swallowing", () =>
    Effect.gen(function* () {
      const failing = Layer.mock(InstanceStore.Service, {
        disposeAll: () => Effect.die(new Error("injected disposal defect")),
      })
      const fiber = yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed().pipe(
        Effect.provide(failing),
        Effect.forkScoped,
      )
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("a healthy disposeAll completes without touching the timeout", () =>
    Effect.acquireUseRelease(
      Effect.sync(collectDisposed),
      (collector) =>
        Effect.gen(function* () {
          let disposed = 0
          const healthy = Layer.mock(InstanceStore.Service, {
            disposeAll: () =>
              Effect.sync(() => {
                disposed += 1
              }),
          })
          yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed().pipe(Effect.provide(healthy))
          expect(disposed).toBe(1)
          expect(collector.events).toEqual(["global.disposed"])
        }),
      (collector) => Effect.sync(collector.stop),
    ),
  )
})
