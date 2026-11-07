import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { GoalLoop } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { GoalPrompts } from "@/goal/prompts"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

type Msg = Parameters<typeof GoalLoop.shouldPreempt>[0][number]

const mk = (role: "user" | "assistant", created: number): Msg => ({
  info: { role, time: { created } },
})

describe("shouldPreempt", () => {
  // §1.7 — last user message newer than last assistant → preempt (true)
  test("user message newer than last assistant returns true", () => {
    const msgs = [mk("assistant", 100), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(true)
  })

  // §1.8 — last assistant newer → no preempt (false)
  test("assistant message newer than last user returns false", () => {
    const msgs = [mk("user", 100), mk("assistant", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  // §1.9 — missing user OR assistant → defensive false
  test("missing user message returns false", () => {
    const msgs = [mk("assistant", 100), mk("assistant", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  test("missing assistant message returns false", () => {
    const msgs = [mk("user", 100), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  test("empty message list returns false", () => {
    expect(GoalLoop.shouldPreempt([])).toBe(false)
  })

  // strict `>` comparison: equal timestamps are NOT a preempt
  test("equal timestamps return false (strict greater-than)", () => {
    const msgs = [mk("assistant", 200), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  // tracks the MAXIMUM timestamp per role across interleaved messages
  test("uses the most recent timestamp per role regardless of order", () => {
    const msgs = [
      mk("assistant", 500),
      mk("user", 100),
      mk("assistant", 200),
      mk("user", 600),
    ]
    // lastUserAt = 600, lastAsstAt = 500 → preempt
    expect(GoalLoop.shouldPreempt(msgs)).toBe(true)
  })

  // messages missing `time.created` are skipped (defensive)
  test("messages missing created timestamp are skipped", () => {
    const msgs = [
      { info: { role: "assistant", time: { created: 100 } } },
      { info: { role: "user", time: {} } },
    ] as ReadonlyArray<Msg>
    // no valid user timestamp → false
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })
})

describe("isStaleZombie — freshness guard predicate (D6)", () => {
  // Helper: builds a goal-state-shaped object for the predicate. created_at is
  // expressed relative to a fixed `now` to keep tests deterministic.
  const state = (overrides: Partial<{ status: string; turns_used: number; created_at: number }> = {}) => ({
    status: "active",
    turns_used: 0,
    created_at: 0,
    ...overrides,
  })
  const NOW = 1_000_000

  // §10.3 — the fire condition: active, turns_used 0, older than the threshold,
  // and no assistant message. This is exactly the orphan state afterIdle must
  // convert into a visible pause.
  test("stale active goal with zero turns and no assistant → true", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(true)
  })

  // §10.4 — fresh goal: created within the threshold. Must NOT pause even with
  // no assistant message — the initial kick may just be slow, not failed.
  test("fresh active goal (within threshold) → false", () => {
    const s = state({ created_at: NOW - 1000 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Exactly at the threshold is NOT stale (strict >).
  test("goal exactly at threshold boundary → false (strict greater-than)", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Has an assistant message → not orphaned, the initial kick succeeded.
  test("stale goal but assistant message exists → false", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, true, NOW)).toBe(false)
  })

  // Already ran continuations → turns_used > 0, not a zombie.
  test("stale goal but turns_used > 0 → false", () => {
    const s = state({ turns_used: 3, created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Not active (paused/done) → predicate short-circuits; pauseAndPublish would
  // be a no-op anyway, but the guard must not fire.
  test("paused goal → false", () => {
    const s = state({ status: "paused", created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })
})

// ── clearLoopFiberIf — fiber-map lifecycle contract (D4) ───────────
//
// GoalLoop now (a) does NOT fork/register a fiber for sessions without an
// active goal, and (b) self-cleans each afterIdle fiber from the Goal fibers
// Map via clearLoopFiberIf when it completes. The Map is private to Goal's
// layer closure, so behavior is observed through interruption side effects
// (the trackedFiber pattern from goal.test.ts).
//
// The three cases below pin the identity contract of clearLoopFiberIf — the
// property that keeps a naturally-completing OLD fiber from evicting a
// freshly-registered NEW fiber (which would silently stall the goal loop).

const fiberTestLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)
const fiberIt = testEffect(fiberTestLayer)

// Forks a synthetic loop fiber that blocks forever and records whether it was
// interrupted, awaiting a readiness signal first so the caller knows the
// onInterrupt finalizer is installed (see AGENTS.md "Synchronizing With
// Concurrent Work").
const trackedFiber = () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const holder = { interrupted: false }
    const fiber = yield* Effect.gen(function* () {
      yield* Deferred.succeed(ready, undefined)
      yield* Effect.never
    }).pipe(
      Effect.onInterrupt(() => Effect.sync(() => (holder.interrupted = true))),
      Effect.forkChild,
    )
    yield* Deferred.await(ready)
    return { fiber, holder }
  })

describe("Goal.clearLoopFiberIf — identity-scoped self-clean (D4)", () => {
  // §D4.1 — clearLoopFiberIf removes the entry on identity match and, unlike
  // clearLoopFiber, MUST NOT interrupt the fiber (it has already finished).
  fiberIt.live("removes the entry on identity match without interrupting", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const { fiber: f1, holder: h1 } = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, f1)
      yield* goal.clearLoopFiberIf(sessionID, f1)

      expect(h1.interrupted).toBe(false)
      // Entry was removed: a second registration finds nothing to interrupt, so
      // f1 stays uninterrupted. (If the entry had survived, registerLoopFiber
      // would interrupt f1 and flip h1.interrupted to true.)
      const { fiber: f2 } = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, f2)
      expect(h1.interrupted).toBe(false)
    }),
  )

  // §D4.2 — a non-matching fiber identity is a no-op; the registered fiber
  // stays in the Map and remains interruptible by a subsequent clearLoopFiber.
  fiberIt.live("non-matching fiber identity leaves the entry intact", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const { fiber: f1, holder: h1 } = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, f1)

      const { fiber: f2 } = yield* trackedFiber()
      yield* goal.clearLoopFiberIf(sessionID, f2)

      // f1 is still registered → clearLoopFiber interrupts it.
      yield* goal.clearLoopFiber(sessionID)
      expect(h1.interrupted).toBe(true)
    }),
  )

  // §D4.3 (scenario 3) — the case the identity check exists to protect: an old
  // afterIdle fiber completes after a newer idle event has already registered a
  // fresh fiber. The old fiber's clearLoopFiberIf MUST NOT evict the new one.
  fiberIt.live("old fiber self-clean does not evict a newer registration", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const { fiber: f1, holder: h1 } = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, f1)

      // A newer idle event registers f2, interrupting f1 (registerLoopFiber
      // semantics). The Map now holds f2.
      const { fiber: f2, holder: h2 } = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, f2)
      expect(h1.interrupted).toBe(true)

      // The old f1's self-clean fires with f1's identity — must NOT remove f2.
      yield* goal.clearLoopFiberIf(sessionID, f1)

      // f2 survived → clearLoopFiber interrupts it, proving it was still
      // registered. Without the identity check this would have evicted f2 and
      // h2.interrupted would stay false (silent goal-loop stall).
      yield* goal.clearLoopFiber(sessionID)
      expect(h2.interrupted).toBe(true)
    }),
  )
})
