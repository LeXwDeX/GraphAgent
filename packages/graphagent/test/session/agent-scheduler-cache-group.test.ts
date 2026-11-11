// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Fiber, type Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { it } from "../lib/effect"

const GROUP = "cg_shared"

/** A scheduler over a fresh, test-local state object (never the process registry). */
const schedulerWith = () => {
  const state = AgentSchedulerState.makeState()
  return { state, scheduler: AgentScheduler.make(state, () => Effect.succeed(state.limits)) }
}

const cacheOptions = (overrides: { cacheGroup?: string; staggerSiblings?: boolean } = {}) => ({
  providerID: "provider",
  modelID: "model",
  ...overrides,
})

const childRequest = (
  scheduler: AgentScheduler.Interface,
  sessionID: string,
  options: { cacheGroup?: string; staggerSiblings?: boolean } = {},
) => scheduler.request({ lane: "child", sessionID, ...cacheOptions(options) })

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

/** Acquire and release in the background, recording the grant order. */
const acquireLater = (
  request: Effect.Effect<AgentScheduler.Permit, AgentScheduler.SchedulerTimeout, Scope.Scope>,
  order: string[],
  sessionID: string,
) =>
  request.pipe(
    Effect.tap(() => Effect.sync(() => order.push(sessionID))),
    Effect.flatMap((permit) => permit.release),
    Effect.forkScoped,
  )

describe("AgentScheduler cache groups (#1028)", () => {
  it.effect("holds a same-group sibling until the leader primes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler, state } = schedulerWith()
        const order: string[] = []
        const leader = yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const follower = yield* acquireLater(
          childRequest(scheduler, "follower", { cacheGroup: GROUP, staggerSiblings: true }),
          order,
          "follower",
        )
        yield* waitForQueued(scheduler, 1)
        expect(order).toEqual([])
        expect(state.cacheGroups.get(GROUP)).toEqual({ open: false, inflight: 1 })
        yield* scheduler.prime(GROUP)
        yield* Fiber.join(follower)
        expect(order).toEqual(["follower"])
        // The leader still holds its permit after the follower released.
        expect(state.requests.inflight).toBe(1)
        yield* leader.release
        expect(state.cacheGroups.size).toBe(0)
      }),
    ),
  )

  it.effect("opens the group after the stagger window without a first token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler } = schedulerWith()
        const order: string[] = []
        yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const follower = yield* acquireLater(
          childRequest(scheduler, "follower", { cacheGroup: GROUP, staggerSiblings: true }),
          order,
          "follower",
        )
        yield* waitForQueued(scheduler, 1)
        expect(order).toEqual([])
        yield* TestClock.adjust("3 seconds")
        yield* Fiber.join(follower)
        expect(order).toEqual(["follower"])
      }),
    ),
  )

  it.effect("starts a sibling immediately when staggering is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler } = schedulerWith()
        yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const sibling = yield* childRequest(scheduler, "sibling", { cacheGroup: GROUP, staggerSiblings: false })
        expect((yield* scheduler.capacity()).laneQueued.child).toBe(0)
        yield* sibling.release
      }),
    ),
  )

  it.effect("starts a request from a different group immediately", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler } = schedulerWith()
        yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const other = yield* childRequest(scheduler, "other", { cacheGroup: "cg_other", staggerSiblings: true })
        expect((yield* scheduler.capacity()).laneQueued.child).toBe(0)
        yield* other.release
      }),
    ),
  )

  it.effect("opens the group when the leader releases before priming", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler, state } = schedulerWith()
        const order: string[] = []
        const leader = yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const follower = yield* acquireLater(
          childRequest(scheduler, "follower", { cacheGroup: GROUP, staggerSiblings: true }),
          order,
          "follower",
        )
        yield* waitForQueued(scheduler, 1)
        yield* leader.release
        yield* Fiber.join(follower)
        expect(order).toEqual(["follower"])
        expect(state.cacheGroups.size).toBe(0)
      }),
    ),
  )

  it.effect("does not stagger a non-child lane sharing the cache group", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler } = schedulerWith()
        yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const interactive = yield* scheduler.request({
          lane: "interactive",
          sessionID: "interactive",
          ...cacheOptions({ cacheGroup: GROUP, staggerSiblings: true }),
        })
        expect((yield* scheduler.capacity()).laneQueued.child).toBe(0)
        yield* interactive.release
      }),
    ),
  )

  it.effect("forgets the group once every member released", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scheduler, state } = schedulerWith()
        const order: string[] = []
        const leader = yield* childRequest(scheduler, "leader", { cacheGroup: GROUP, staggerSiblings: true })
        const follower = yield* acquireLater(
          childRequest(scheduler, "follower", { cacheGroup: GROUP, staggerSiblings: true }),
          order,
          "follower",
        )
        yield* waitForQueued(scheduler, 1)
        yield* leader.release
        yield* Fiber.join(follower)
        expect(order).toEqual(["follower"])
        expect(state.cacheGroups.size).toBe(0)
        // The leader's window timer must not resurrect a deleted group.
        yield* TestClock.adjust("3 seconds")
        expect(state.cacheGroups.size).toBe(0)
      }),
    ),
  )
})
