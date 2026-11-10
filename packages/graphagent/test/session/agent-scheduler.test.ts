// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Fiber, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AgentScheduler } from "@/session/agent-scheduler"
import { DEFAULT_LIMITS, type SchedulerLimits } from "@/session/agent-scheduler-state"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { it } from "../lib/effect"

const limits = (overrides: Partial<SchedulerLimits> = {}): SchedulerLimits => ({
  ...DEFAULT_LIMITS,
  ...overrides,
})

/** A scheduler over a fresh, test-local state object (never the process registry). */
const schedulerWith = (value: SchedulerLimits = DEFAULT_LIMITS) => {
  const state = AgentSchedulerState.makeState(value)
  return AgentScheduler.make(state, () => Effect.succeed(value))
}

const request = (
  scheduler: AgentScheduler.Interface,
  lane: AgentSchedulerState.Lane,
  sessionID: string,
  providerID = "provider",
  modelID = "model",
) => scheduler.request({ lane, providerID, modelID, sessionID })

/** Yield until the scheduler reports `count` queued model waiters (bounded). */
const waitForQueued = (scheduler: AgentScheduler.Interface, count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const snapshot = yield* scheduler.capacity()
      const queued = Object.values(snapshot.laneQueued).reduce((sum, value) => sum + value, 0)
      if (queued >= count) return
      yield* Effect.yieldNow
    }
    throw new Error(`expected ${count} queued model waiters`)
  })

/** Yield a bounded number of times so forked fibers reach their first wait. */
const settle = Effect.yieldNow.pipe(
  Effect.andThen(Effect.yieldNow),
  Effect.andThen(Effect.yieldNow),
  Effect.andThen(Effect.yieldNow),
  Effect.andThen(Effect.yieldNow),
)

/** Acquire then immediately release, recording the session ID in grant order. */
const acquireAndRelease = (
  scheduler: AgentScheduler.Interface,
  lane: AgentSchedulerState.Lane,
  sessionID: string,
  order: string[],
) =>
  request(scheduler, lane, sessionID).pipe(
    Effect.tap(() => Effect.sync(() => order.push(sessionID))),
    Effect.flatMap((permit) => permit.release),
  )

describe("AgentScheduler request permits", () => {
  it.effect("a queued interactive request outranks an older background waiter (#1021)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 1 }))
        const order: string[] = []
        const held = yield* request(scheduler, "interactive", "held")
        const background = yield* acquireAndRelease(scheduler, "background", "background", order).pipe(
          Effect.forkScoped,
        )
        yield* waitForQueued(scheduler, 1)
        const interactive = yield* acquireAndRelease(scheduler, "interactive", "interactive", order).pipe(
          Effect.forkScoped,
        )
        yield* waitForQueued(scheduler, 2)
        yield* held.release
        yield* Fiber.join(background)
        yield* Fiber.join(interactive)
        expect(order).toEqual(["interactive", "background"])
      }),
    ),
  )

  it.effect("waiters in the same lane are served FIFO", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 1 }))
        const order: string[] = []
        const held = yield* request(scheduler, "interactive", "held")
        const first = yield* acquireAndRelease(scheduler, "background", "first", order).pipe(Effect.forkScoped)
        yield* waitForQueued(scheduler, 1)
        const second = yield* acquireAndRelease(scheduler, "background", "second", order).pipe(Effect.forkScoped)
        yield* waitForQueued(scheduler, 2)
        yield* held.release
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(order).toEqual(["first", "second"])
      }),
    ),
  )

  it.effect("a second side request is refused while the reserved side permit is held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith()
        const first = yield* scheduler.tryRequest({
          lane: "side",
          providerID: "provider",
          modelID: "model",
          sessionID: "a",
        })
        expect(Option.isSome(first)).toBe(true)
        const second = yield* scheduler.tryRequest({
          lane: "side",
          providerID: "provider",
          modelID: "model",
          sessionID: "b",
        })
        expect(Option.isNone(second)).toBe(true)
        // Interactive headroom is independent of the side lane.
        const interactive = yield* scheduler.tryRequest({
          lane: "interactive",
          providerID: "provider",
          modelID: "model",
          sessionID: "c",
        })
        expect(Option.isSome(interactive)).toBe(true)
      }),
    ),
  )

  it.effect("non-interactive lanes stop at the global-minus-two headroom", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 4 }))
        const one = yield* scheduler.tryRequest({ lane: "background", providerID: "p", modelID: "m", sessionID: "1" })
        const two = yield* scheduler.tryRequest({ lane: "background", providerID: "p", modelID: "m", sessionID: "2" })
        expect([Option.isSome(one), Option.isSome(two)]).toEqual([true, true])
        const three = yield* scheduler.tryRequest({ lane: "child", providerID: "p", modelID: "m", sessionID: "3" })
        expect(Option.isNone(three)).toBe(true)
        // Interactive is exempt from the headroom check.
        const interactive = yield* scheduler.tryRequest({
          lane: "interactive",
          providerID: "p",
          modelID: "m",
          sessionID: "4",
        })
        expect(Option.isSome(interactive)).toBe(true)
      }),
    ),
  )

  it.effect("a rate-limit penalty refuses child and background only, and expires with the clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 4 }))
        yield* scheduler.penalize("provider", "model", 5_000)
        const child = yield* scheduler.tryRequest({
          lane: "child",
          providerID: "provider",
          modelID: "model",
          sessionID: "c",
        })
        const background = yield* scheduler.tryRequest({
          lane: "background",
          providerID: "provider",
          modelID: "model",
          sessionID: "b",
        })
        expect([Option.isNone(child), Option.isNone(background)]).toEqual([true, true])
        const interactive = yield* scheduler.tryRequest({
          lane: "interactive",
          providerID: "provider",
          modelID: "model",
          sessionID: "i",
        })
        expect(Option.isSome(interactive)).toBe(true)
        yield* TestClock.adjust(Duration.millis(5_000))
        const after = yield* scheduler.tryRequest({
          lane: "child",
          providerID: "provider",
          modelID: "model",
          sessionID: "c2",
        })
        expect(Option.isSome(after)).toBe(true)
      }),
    ),
  )

  it.effect("a queued request recovers when the penalty expires without any release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 4 }))
        const held = yield* request(scheduler, "interactive", "held")
        yield* scheduler.penalize("provider", "model", 3_000)
        const order: string[] = []
        const waiting = yield* acquireAndRelease(scheduler, "background", "waiting", order).pipe(Effect.forkScoped)
        yield* waitForQueued(scheduler, 1)
        expect(order).toEqual([])
        // The 1s poll wakes the waiter; by 3s the penalty has elapsed even
        // though nothing released a permit.
        yield* TestClock.adjust(Duration.millis(3_000))
        yield* settle
        yield* Fiber.join(waiting)
        expect(order).toEqual(["waiting"])
        yield* held.release
      }),
    ),
  )

  it.effect("a bounded wait surfaces SchedulerTimeout and gives the waiter back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 1 }))
        const held = yield* request(scheduler, "interactive", "held")
        const waiting = yield* Effect.scoped(
          scheduler
            .request(
              { lane: "interactive", providerID: "provider", modelID: "model", sessionID: "waiting" },
              { timeoutMs: 2_000 },
            )
            .pipe(Effect.map((permit) => permit.release)),
        ).pipe(Effect.forkScoped)
        yield* waitForQueued(scheduler, 1)
        yield* TestClock.adjust(Duration.millis(2_000))
        const outcome = yield* Fiber.await(waiting)
        expect(Exit.isFailure(outcome)).toBe(true)
        const snapshot = yield* scheduler.capacity()
        expect(snapshot.laneQueued.interactive).toBe(0)
        yield* held.release
      }),
    ),
  )

  it.effect("release is idempotent and does not steal capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 1 }))
        const held = yield* request(scheduler, "interactive", "held")
        yield* held.release
        yield* held.release
        expect((yield* scheduler.capacity()).requests.inflight).toBe(0)
        // A double release frees the slot once, so exactly one of the two
        // following attempts can be admitted.
        const first = yield* scheduler.tryRequest({
          lane: "interactive",
          providerID: "provider",
          modelID: "model",
          sessionID: "first",
        })
        const second = yield* scheduler.tryRequest({
          lane: "interactive",
          providerID: "provider",
          modelID: "model",
          sessionID: "second",
        })
        expect([Option.isSome(first), Option.isNone(second)]).toEqual([true, true])
        expect((yield* scheduler.capacity()).requests.inflight).toBe(1)
        if (Option.isSome(first)) yield* first.value.release
        expect((yield* scheduler.capacity()).requests.inflight).toBe(0)
      }),
    ),
  )

  it.effect("interrupting a queued request removes its waiter immediately", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ global: 1 }))
        const held = yield* request(scheduler, "interactive", "held")
        const waiting = yield* Effect.scoped(request(scheduler, "background", "waiting")).pipe(Effect.forkScoped)
        yield* waitForQueued(scheduler, 1)
        yield* Fiber.interrupt(waiting)
        const snapshot = yield* scheduler.capacity()
        expect(snapshot.laneQueued.background).toBe(0)
        yield* held.release
        const available = yield* scheduler.tryRequest({
          lane: "background",
          providerID: "provider",
          modelID: "model",
          sessionID: "next",
        })
        expect(Option.isSome(available)).toBe(true)
      }),
    ),
  )
})

describe("AgentScheduler child slots", () => {
  const workflow = (id = "wf-1") => ({ kind: "workflow" as const, workflowID: id })
  const task = (id = "parent") => ({ kind: "task" as const, parentSessionID: id })

  it.effect("workflow concurrency is truncated to the pool left after the task reserve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 4, taskReserve: 1, dagConcurrency: 12 }))
        const a = yield* scheduler.childSlot(workflow(), 10)
        const b = yield* scheduler.childSlot(workflow(), 10)
        const c = yield* scheduler.childSlot(workflow(), 10)
        const snapshot = yield* scheduler.capacity(workflow())
        expect(snapshot.limit).toEqual({ key: workflow(), used: 3, cap: 3 })
        // A fourth node of the same workflow queues behind the truncated cap.
        const fourth = yield* scheduler.childSlot(workflow(), 10).pipe(Effect.forkScoped)
        yield* settle
        expect((yield* scheduler.capacity()).children.running).toBe(3)
        yield* a.release
        yield* Fiber.join(fourth)
        expect((yield* scheduler.capacity()).children.running).toBe(3)
        yield* b.release
        yield* c.release
      }),
    ),
  )

  it.effect("task slots are capped per parent and ignore the DAG-wide layer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 8, taskReserve: 2, dagConcurrency: 2 }))
        const taskA = yield* scheduler.childSlot(task("parent-a"), 2)
        const taskB = yield* scheduler.childSlot(task("parent-a"), 2)
        const third = yield* scheduler.childSlot(task("parent-a"), 2).pipe(Effect.forkScoped)
        yield* settle
        expect((yield* scheduler.capacity(task("parent-a"))).limit).toEqual({
          key: task("parent-a"),
          used: 2,
          cap: 2,
        })
        // Filling the DAG layer does not block a task run on another parent.
        const dagA = yield* scheduler.childSlot(workflow("wf-a"), 5)
        const dagB = yield* scheduler.childSlot(workflow("wf-b"), 5)
        const blockedDag = yield* scheduler.childSlot(workflow("wf-c"), 5).pipe(Effect.forkScoped)
        yield* settle
        // A task run on another parent is admitted while both DAG slots are
        // taken and the third workflow is still queued.
        const taskC = yield* scheduler.childSlot(task("parent-b"), 2)
        expect((yield* scheduler.capacity()).children.running).toBe(5)
        yield* taskA.release
        yield* Fiber.join(third)
        yield* taskB.release
        yield* dagA.release
        yield* dagB.release
        yield* Fiber.join(blockedDag)
      }),
    ),
  )

  it.effect("a running task does not shrink the DAG child-run pool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 6, taskReserve: 1, dagConcurrency: 12 }))
        const taskPermit = yield* scheduler.childSlot(task("parent-a"), 1)
        // workflowPool = childGlobal - taskReserve = 5; the running task must
        // not consume one of those slots in addition to its own reserve.
        const flows = []
        for (let index = 0; index < 5; index++) flows.push(yield* scheduler.childSlot(workflow("wf-1"), 5))
        expect((yield* scheduler.capacity()).children.running).toBe(6)
        for (const permit of flows) yield* permit.release
        yield* taskPermit.release
        expect((yield* scheduler.capacity()).children.running).toBe(0)
      }),
    ),
  )

  it.effect("grants rotate between root sessions with FIFO inside one root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 1, taskReserve: 1 }))
        const order: string[] = []
        const held = yield* scheduler.childSlot(workflow("wf-1"), 1, { rootSessionID: "root-a" })
        const record = (id: string) =>
          scheduler.childSlot(workflow("wf-1"), 1, { rootSessionID: id }).pipe(
            Effect.tap(() => Effect.sync(() => order.push(id))),
            Effect.flatMap((permit) => permit.release),
          )
        const a2 = yield* record("root-a").pipe(Effect.forkScoped)
        yield* settle
        const b1 = yield* record("root-b").pipe(Effect.forkScoped)
        yield* settle
        yield* held.release
        yield* Fiber.join(a2)
        yield* Fiber.join(b1)
        expect(order).toEqual(["root-b", "root-a"])
      }),
    ),
  )

  it.effect("a paused workflow can release and reacquire its slot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 1, taskReserve: 1 }))
        const first = yield* scheduler.childSlot(workflow(), 1)
        yield* first.release
        expect((yield* scheduler.capacity(workflow())).limit).toEqual({ key: workflow(), used: 0, cap: 1 })
        const resumed = yield* scheduler.childSlot(workflow(), 2)
        expect((yield* scheduler.capacity(workflow())).limit).toEqual({ key: workflow(), used: 1, cap: 1 })
        yield* resumed.release
      }),
    ),
  )

  it.effect("childGlobal=1 still admits a task while a workflow slot is free", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 1, taskReserve: 1 }))
        const taskPermit = yield* scheduler.childSlot(task(), 1)
        const blocked = yield* scheduler.childSlot(workflow(), 1).pipe(Effect.forkScoped)
        yield* settle
        expect((yield* scheduler.capacity()).children.running).toBe(1)
        yield* taskPermit.release
        yield* Fiber.join(blocked)
        expect((yield* scheduler.capacity()).children.running).toBe(1)
      }),
    ),
  )

  it.effect("release is idempotent for child slots too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduler = schedulerWith(limits({ childGlobal: 2, taskReserve: 1 }))
        const held = yield* scheduler.childSlot(workflow(), 2)
        yield* held.release
        yield* held.release
        expect((yield* scheduler.capacity()).children.running).toBe(0)
      }),
    ),
  )
})

describe("AgentScheduler limits", () => {
  it.effect("limits() re-reads configuration instead of exposing the seeded snapshot", () =>
    Effect.gen(function* () {
      let current = limits({ global: 3 })
      const state = AgentSchedulerState.makeState(current)
      const scheduler = AgentScheduler.make(state, () => Effect.succeed(current))
      expect((yield* scheduler.limits()).global).toBe(3)
      current = limits({ global: 7 })
      expect((yield* scheduler.limits()).global).toBe(7)
    }),
  )
})
