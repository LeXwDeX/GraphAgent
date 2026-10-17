import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { GoalPrompts } from "@/goal/prompts"
import { GoalJudge } from "@/goal/judge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Database } from "@opencode-ai/core/database/database"
import { GoalStateTable } from "@opencode-ai/core/goal/sql"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Build the layer so EventV2Bridge.Service is SHARED between Goal's internals
// (which publish via it) and this test (which subscribes via it).
// `Layer.provideMerge` exposes the built EventV2Bridge in the output context
// AND feeds the same instance into Goal.layer — a plain `Layer.provide` would
// consume it internally and the test's `yield* EventV2Bridge.Service` would
// resolve to a different instance, missing every published event.
// Each test uses a unique SessionID so rows never collide across tests
// (goal_state.session_id is the primary key).
const testLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(testLayer)

type CapturedEvent = {
  type: string
  status?: string
  turnsUsed?: number
  subgoals?: ReadonlyArray<unknown>
}

const captureEvents = (events: EventV2Bridge.Service["Service"]) =>
  Effect.gen(function* () {
    const seen: CapturedEvent[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        // goal.updated carries { sessionID, goal: { status, turnsUsed, subgoals, ... } };
        // goal.cleared carries only { sessionID }.
        const goal = (
          event.data as { goal?: { status?: string; turnsUsed?: number; subgoals?: ReadonlyArray<unknown> } }
        ).goal
        seen.push({
          type: event.type,
          status: goal?.status,
          turnsUsed: goal?.turnsUsed,
          subgoals: goal?.subgoals,
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

// Returns the single goal.updated(done) event from a capture, failing the test
// loudly if there isn't exactly one (used by markDone / terminal-flow tests).
const doneUpdated = (events: ReadonlyArray<CapturedEvent>) => {
  const done = events.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
  expect(done.length).toBe(1)
  return done[0]
}

// Forks a synthetic "loop fiber" that blocks forever and records whether it has
// been interrupted. The Goal service's fiber map (`fibers`) is private inside
// its layer closure, so fiber-map behavior can only be observed through
// interruption side effects: register the tracked fiber, trigger the action
// under test, then read `holder.interrupted`.
//
// The `ready` deferred is awaited before returning so the child has STARTED and
// registered its onInterrupt finalizer before the caller touches the map —
// without it, an interrupt fired before the child scheduled could miss the
// finalizer and the test would race (see AGENTS.md "Synchronizing With
// Concurrent Work": wait on a published readiness signal, never Effect.sleep).
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

describe("Goal.updateAfterJudge — continue branch", () => {
  // §2.1 baseline: continue increments turns_used exactly once and publishes
  // goal.updated(active). This is the ONE branch that is correct pre-fix and
  // must stay correct after the bug fixes.
  it.live("continue verdict increments turns_used by exactly one and publishes goal.updated", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0 // drop the set() goal.updated(active)

      const result = yield* goal.updateAfterJudge(sessionID, "continue", "more steps", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })

      expect(result?.shouldContinue).toBe(true)
      const loaded = yield* goal.load(sessionID)
      expect(Number(loaded?.turns_used)).toBe(1)
      expect(loaded?.status).toBe("active")

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
      expect(updates[0].turnsUsed).toBe(1)
    }),
  )
})

describe("Goal.updateAfterJudge — atomic done transition", () => {
  // §2.2 — done is a STATE TRANSITION, not a continuation dispatch, so it must
  // NOT consume budget. Pre-fix this fails (code does +1); post-§3 it passes.
  it.live("done verdict does not increment turns_used (state transitions are budget-neutral)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship feature X", 10)
      const before = yield* goal.load(sessionID)
      const n = Number(before?.turns_used)

      const result = yield* goal.updateAfterJudge(sessionID, "done", "delivered", false, {
        goalID: before?.goal_id ?? "legacy",
        revision: before?.revision ?? 0,
      })

      expect(result?.state.status).toBe("done")
      expect(Number(result?.state.turns_used)).toBe(n)
      expect(yield* goal.load(sessionID)).toBeUndefined()
      const outcome = yield* goal.lastOutcome(sessionID)
      expect(outcome?.status).toBe("done")
      expect(outcome?.last_reason).toBe("delivered")
    }),
  )
})

describe("Goal.updateAfterJudge — done branch (terminal event contract)", () => {
  it.live("done verdict atomically removes the row and publishes the terminal sequence", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "ship feature X", 10)
      seen.length = 0

      yield* goal.updateAfterJudge(sessionID, "done", "delivered", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })

      const types = seen.map((e) => e.type)
      expect(types).toEqual([GoalEvent.Updated.type, GoalEvent.Cleared.type])
      doneUpdated(seen)
      const cleared = seen.filter((e) => e.type === GoalEvent.Cleared.type)
      expect(cleared.length).toBe(1)

      // row is gone after the terminal sequence
      const loaded = yield* goal.load(sessionID)
      expect(loaded).toBeUndefined()
    }),
  )
})

describe("Goal.updateAfterJudge — blocked branch", () => {
  it.live("blocked pauses the goal and never emits a successful done state", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "deploy production", 10)
      seen.length = 0

      const result = yield* goal.updateAfterJudge(sessionID, "blocked", "missing production credentials", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })

      expect(result?.state.status).toBe("paused")
      expect(result?.state.last_verdict).toBe("blocked")
      expect(result?.message).toContain("已阻塞")
      expect(seen.some((event) => event.status === "done")).toBe(false)
    }),
  )
})

describe("Goal transition authority — stale loop decisions", () => {
  it.live("concurrent pause and judge update always settle paused", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const state = yield* goal.set(sessionID, "ship feature X", 10)

      yield* Effect.all(
        [
          goal.pause(sessionID, "user-paused"),
          goal.updateAfterJudge(sessionID, "continue", "racing judge result", false, {
            goalID: state.goal_id ?? "legacy",
            revision: state.revision ?? 0,
          }),
        ],
        { concurrency: 2 },
      )

      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.live("concurrent clear and judge update never leave a resurrected row", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const state = yield* goal.set(sessionID, "ship feature X", 10)

      yield* Effect.all(
        [
          goal.clear(sessionID),
          goal.updateAfterJudge(sessionID, "continue", "racing judge result", false, {
            goalID: state.goal_id ?? "legacy",
            revision: state.revision ?? 0,
          }),
        ],
        { concurrency: 2 },
      )

      expect(yield* goal.load(sessionID)).toBeUndefined()
    }),
  )

  it.live("a judge result read before pause cannot reactivate the paused goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const before = yield* goal.set(sessionID, "ship feature X", 10)

      yield* goal.pause(sessionID, "user-paused")
      const stale = yield* goal.updateAfterJudge(sessionID, "continue", "stale judge result", false, {
        goalID: before.goal_id ?? "legacy",
        revision: before.revision ?? 0,
      })

      expect(stale).toBeUndefined()
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.live("a judge result from a cleared goal cannot mutate its replacement", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const before = yield* goal.set(sessionID, "old goal", 10)

      yield* goal.clear(sessionID)
      const replacement = yield* goal.set(sessionID, "new goal", 10)
      const stale = yield* goal.updateAfterJudge(sessionID, "continue", "old result", false, {
        goalID: before.goal_id ?? "legacy",
        revision: before.revision ?? 0,
      })

      expect(stale).toBeUndefined()
      const current = yield* goal.load(sessionID)
      expect(current?.goal_id).toBe(replacement.goal_id)
      expect(current?.turns_used).toBe(0)
    }),
  )
})

describe("Goal.markDone — turns_used is budget-neutral", () => {
  // §2.4 — user/agent-initiated completion on a goal that never ran a continue
  // dispatch. turns_used must stay at its current value (budget counts
  // continuation dispatches only). Pre-fix this fails (+1); post-§3 it passes.
  // The row is deleted by deleteAndPublishDone, so turns_used is read from the
  // published goal.updated(done) payload.
  it.live("markDone on a fresh active goal does not increment turns_used", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      const before = yield* goal.load(sessionID)
      seen.length = 0

      yield* goal.markDone(sessionID, "agent self-declared")

      const event = doneUpdated(seen)
      expect(event.turnsUsed).toBe(Number(before?.turns_used))
    }),
  )

  // §2.5 — agent self-declares completion mid-loop: a continue dispatch already
  // incremented turns_used (N → N+1); markDone must NOT add a second increment.
  // The reported count reflects only the continuation dispatch, not the
  // completion call (reasoner C1). Pre-fix this fails (double-count → N+2);
  // post-§3 it passes (N+1).
  it.live("markDone after a continue dispatch does not double-count", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "ship feature X", 10)
      // Simulate one continuation dispatch (the budget-consuming event).
      yield* goal.updateAfterJudge(sessionID, "continue", "more steps", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })
      const continued = yield* goal.load(sessionID)
      seen.length = 0

      yield* goal.markDone(sessionID, "agent self-declared")

      const event = doneUpdated(seen)
      // Only the continue increment; markDone adds nothing.
      expect(event.turnsUsed).toBe(Number(continued?.turns_used))
    }),
  )
})

// ---------------------------------------------------------------------------
// GOAL-FP-01-08: Goal.set must not leave the previous goal's id in the lease.
// The lease's owner() returns the FIRST id in the registration set, so a stale
// entry makes the new goal's claim be rejected (selected.id !== request.id)
// and the loop silently starves. Replacing a goal must unregister the previous
// id atomically with the new registration.
// ---------------------------------------------------------------------------

const setLeaseLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provideMerge(SessionAutomationLease.defaultLayer),
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

describe("Goal.set — replacing a goal unregisters the previous lease id (GOAL-FP-01-08)", () => {
  testEffect(setLeaseLayer).live("set on an existing goal leaves exactly the new goal id claimable", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()

      const first = yield* goal.set(sessionID, "goal A", 10)
      const second = yield* goal.set(sessionID, "goal B", 10)

      // Pre-fix: the lease still holds BOTH ids (register never removes the
      // previous one), so the stale id is claimable and the fresh one is not.
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: first.goal_id ?? "legacy" }))).toBe(true)
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "goal", id: second.goal_id ?? "legacy" }))).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// §5 — Expand state-machine coverage (lock the contract). All PASS against
// current post-bug-fix behavior; they exist to catch regressions when §6-§10
// land.
// ---------------------------------------------------------------------------

describe("Goal.set — saves active row + publishes goal.updated(active)", () => {
  // §5.1 — the entry point of the lifecycle. Locks the initial row shape and
  // the published event: status active, turns_used 0, empty subgoals.
  it.live("set persists an active row with turns_used 0 / subgoals [] and publishes goal.updated(active)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "build feature X", 10)

      expect(state.status).toBe("active")
      expect(state.turns_used).toBe(0)
      expect(state.subgoals).toEqual([])

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("active")
      expect(Number(loaded?.turns_used)).toBe(0)
      expect(loaded?.subgoals).toEqual([])

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
      expect(updates[0].turnsUsed).toBe(0)
      expect(updates[0].subgoals).toEqual([])
    }),
  )
})

describe("Goal.pause — active→paused, clears loop fiber, publishes goal.updated(paused)", () => {
  // §5.2 — pause must (a) transition to paused, (b) clear the loop fiber via
  // clearFiber (verified through the tracked fiber's interrupt side effect),
  // and (c) publish goal.updated(paused) carrying the reason.
  it.live("pause transitions to paused, interrupts the loop fiber, and publishes with the reason", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)
      seen.length = 0

      const result = yield* goal.pause(sessionID, "user-paused: checking in")

      expect(result?.status).toBe("paused")
      expect(result?.paused_reason).toBe("user-paused: checking in")
      // pause() calls clearFiber → Fiber.interrupt on the registered loop fiber
      expect(tracked.holder.interrupted).toBe(true)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("paused")

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("paused")
    }),
  )
})

describe("Goal.resume — preserves turns_used (no fresh budget), resets parse failures", () => {
  // §5.3 — CRITICAL regression guard: resume must NOT reset turns_used. A
  // paused goal that exhausted its budget would otherwise get a fresh full
  // budget on every resume, defeating max_turns as a runaway guard. Also
  // resets consecutive_parse_failures so a resumed goal gets a clean slate
  // for judge-parse-failure auto-pause.
  it.live("resume transitions paused→active, preserves turns_used, and resets consecutive_parse_failures", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "build feature X", 10)
      // One SUCCESSFUL continue judgment → turns_used=1 (real budget spent).
      const s1 = yield* goal.updateAfterJudge(sessionID, "continue", "real verdict", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })
      // Then one parse-failure judgment → cpf=1 while turns_used stays 1
      // (GOAL-03 budget-neutrality: a failed judge spends no turn).
      yield* goal.updateAfterJudge(sessionID, "continue", "more steps", true, {
        goalID: s1?.state.goal_id ?? "legacy",
        revision: s1?.state.revision ?? 0,
      })
      const beforePause = yield* goal.load(sessionID)
      expect(Number(beforePause?.turns_used)).toBe(1)
      expect(Number(beforePause?.consecutive_parse_failures)).toBe(1)
      // User-initiated pause preserves turns_used + cpf
      yield* goal.pause(sessionID, "user paused")
      seen.length = 0

      const result = yield* goal.resume(sessionID)

      expect(result?.status).toBe("active")
      // turns_used preserved — NOT reset to 0
      expect(Number(result?.turns_used)).toBe(Number(beforePause?.turns_used))
      // parse-failure counter reset on resume
      expect(Number(result?.consecutive_parse_failures)).toBe(0)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("active")
      expect(Number(loaded?.turns_used)).toBe(1)
      expect(Number(loaded?.consecutive_parse_failures)).toBe(0)

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
    }),
  )

  // §5.4 — budget-exhausted pause: resume flips to active but keeps turns_used
  // intact (== max_turns). The next judge iteration immediately re-pauses; the
  // dispatch layer surfaces a warning (goal.ts:506-509). This locks that resume
  // does NOT silently grant a fresh budget.
  it.live("resume on a budget-exhausted paused goal keeps turns_used at max (no budget reset)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      // max_turns=2: a second continue verdict trips the budget-pause branch
      const state = yield* goal.set(sessionID, "build feature X", 2)
      const step1 = yield* goal.updateAfterJudge(sessionID, "continue", "step 1", false, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      }) // turns_used 1
      yield* goal.updateAfterJudge(sessionID, "continue", "step 2", false, {
        goalID: step1?.state.goal_id ?? "legacy",
        revision: step1?.state.revision ?? 0,
      }) // turns_used 2 >= max → paused

      const paused = yield* goal.load(sessionID)
      expect(paused?.status).toBe("paused")
      expect(Number(paused?.turns_used)).toBe(2)

      const result = yield* goal.resume(sessionID)

      // Active again, but turns_used unchanged — immediately re-exhaustible.
      expect(result?.status).toBe("active")
      expect(Number(result?.turns_used)).toBe(2)
      expect(Number(result?.turns_used) >= Number(result?.max_turns)).toBe(true)
    }),
  )
})

describe("Goal.clear — deletes row, clears loop fiber, publishes goal.cleared", () => {
  // §5.5 — clear tears down everything: row deleted, loop fiber interrupted,
  // exactly one goal.cleared published, and NO goal.updated (clear is not a
  // state transition, it is removal).
  it.live("clear removes the row, interrupts the loop fiber, and publishes exactly one goal.cleared", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)
      seen.length = 0

      yield* goal.clear(sessionID)

      expect(tracked.holder.interrupted).toBe(true)
      const loaded = yield* goal.load(sessionID)
      expect(loaded).toBeUndefined()

      const cleared = seen.filter((e) => e.type === GoalEvent.Cleared.type)
      expect(cleared.length).toBe(1)
      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(0)
    }),
  )
})

describe("Goal.dispatch — clear/stop/done distinguish a no-op from a transition", () => {
  it.instance("clear and stop report no active goal and publish no event", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      for (const command of ["clear", "stop"]) {
        const sessionID = SessionID.descending()
        const result = yield* goal.dispatch(sessionID, command)
        expect(result).toEqual({ type: "message", text: "没有活跃的目标可以清除。" })
        expect(yield* goal.load(sessionID)).toBeUndefined()
      }
      expect(seen.filter((e) => e.type === GoalEvent.Updated.type || e.type === GoalEvent.Cleared.type)).toHaveLength(0)
    }),
  )

  it.instance("done reports no active goal and publishes no event", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const result = yield* goal.dispatch(sessionID, "done")

      expect(result).toEqual({ type: "message", text: "没有活跃的目标可以完成。" })
      expect(yield* goal.load(sessionID)).toBeUndefined()
      expect(seen.filter((e) => e.type === GoalEvent.Updated.type || e.type === GoalEvent.Cleared.type)).toHaveLength(0)
    }),
  )

  it.instance("clear, stop and done keep their success messages when a goal exists", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      for (const [command, text] of [
        ["clear", "目标已清除。"],
        ["stop", "目标已清除。"],
        ["done", "✓ 目标已标记为完成并清除。"],
      ] as const) {
        const sessionID = SessionID.descending()
        yield* goal.set(sessionID, "build feature X", 5)
        const result = yield* goal.dispatch(sessionID, command)
        expect(result).toEqual({ type: "message", text })
        expect(yield* goal.load(sessionID)).toBeUndefined()
      }
    }),
  )
})

describe("Goal.registerLoopFiber — interrupts the previous fiber before storing the new one", () => {
  // §5.6 — registering a new fiber for a session that already has one must
  // interrupt the old one first (prevents a leaked/orphaned loop fiber when a
  // new afterIdle run supersedes the prior). Verified by: (a) old fiber
  // interrupted, (b) new fiber intact, (c) a subsequent clearLoopFiber
  // interrupts the NEW fiber (proves it was actually stored).
  it.live("registering a new fiber interrupts the previously-registered fiber for the same session", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      const first = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, first.fiber)
      expect(first.holder.interrupted).toBe(false)

      const second = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, second.fiber)

      // previous fiber interrupted by the re-register
      expect(first.holder.interrupted).toBe(true)
      // new fiber is intact and is now the one stored in the map
      expect(second.holder.interrupted).toBe(false)
      // clearing now interrupts the NEW fiber, proving it was stored
      yield* goal.clearLoopFiber(sessionID)
      expect(second.holder.interrupted).toBe(true)
    }),
  )
})

describe("Goal fiber-safe terminal paths — do NOT touch the fiber map", () => {
  // §5.7 — deleteAndPublishDone and pauseAndPublish are called from INSIDE the
  // loop fiber itself (loop.ts done / shouldPreempt branches). They must NOT
  // manage the fiber map — doing so would self-interrupt before the terminal
  // / pause event reaches the bus (the event would never be published). This
  // locks the self-interrupt-hazard discipline: caller manages the fiber.
  it.live("deleteAndPublishDone leaves the registered loop fiber intact", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)

      yield* goal.deleteAndPublishDone(sessionID, "judge done")

      // fiber NOT interrupted — map untouched
      expect(tracked.holder.interrupted).toBe(false)
      // the map still holds it: clearing now interrupts the registered fiber
      yield* goal.clearLoopFiber(sessionID)
      expect(tracked.holder.interrupted).toBe(true)
    }),
  )

  it.live("pauseAndPublish leaves the registered loop fiber intact", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)

      yield* goal.pauseAndPublish(sessionID, "loop self-pause")

      // fiber NOT interrupted — map untouched
      expect(tracked.holder.interrupted).toBe(false)
      // the map still holds it: clearing now interrupts the registered fiber
      yield* goal.clearLoopFiber(sessionID)
      expect(tracked.holder.interrupted).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// §9 — Transport errors count toward pause budget (D5). Transport failures
// (timeout, network) now return parseFailed: true from the judge, feeding the
// same consecutive_parse_failures counter as parse failures. Three in a row
// triggers auto-pause; alternating transport/parse failures must NOT reset the
// counter (pre-fix transport returned parseFailed: false, which reset it to 0
// and let a flaky provider burn the full budget without ever pausing).
// ---------------------------------------------------------------------------

describe("Goal.updateAfterJudge — transport failures trigger auto-pause (D5)", () => {
  it.live("auto-pause preserves the actionable invalid-response category and resume resets the retry budget", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      let state = yield* goal.set(sessionID, "build feature X", 10)
      const invalid = GoalJudge.parseJudgeResponse("")

      let result: Effect.Success<ReturnType<typeof goal.updateAfterJudge>>
      for (let attempt = 0; attempt < GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES; attempt++) {
        result = yield* goal.updateAfterJudge(sessionID, invalid.verdict, invalid.reason, invalid.parseFailed, {
          goalID: state.goal_id ?? "legacy",
          revision: state.revision ?? 0,
        })
        if (result) state = result.state
      }

      expect(result?.shouldContinue).toBe(false)
      expect(result?.message).toContain("judge 返回空响应（0 字符）")
      expect(state.status).toBe("paused")
      expect(state.paused_reason).toContain("judge 返回空响应（0 字符）")
      expect(state.paused_reason).not.toContain("build feature X")

      const resumed = yield* goal.resume(sessionID)
      expect(resumed?.status).toBe("active")
      expect(resumed?.consecutive_parse_failures).toBe(0)
      expect(resumed?.last_reason).toBe(invalid.reason)
    }),
  )

  // §9.3a — three consecutive transport failures (parseFailed: true, simulating
  // what judge.ts now returns on timeout/network) must reach
  // MAX_CONSECUTIVE_PARSE_FAILURES (3) and auto-pause on the third.
  it.live("three consecutive transport failures auto-pause the goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0

      // Two transport failures — still active, counter climbing 1 → 2
      const r1 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 1", true, {
        goalID: state.goal_id ?? "legacy",
        revision: state.revision ?? 0,
      })
      const r2 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 2", true, {
        goalID: r1?.state.goal_id ?? "legacy",
        revision: r1?.state.revision ?? 0,
      })
      expect(r1?.shouldContinue).toBe(true)
      expect(r2?.shouldContinue).toBe(true)

      const midState = yield* goal.load(sessionID)
      expect(midState?.status).toBe("active")
      expect(Number(midState?.consecutive_parse_failures)).toBe(2)

      // Third transport failure — counter reaches 3 → auto-pause
      const r3 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 3", true, {
        goalID: r2?.state.goal_id ?? "legacy",
        revision: r2?.state.revision ?? 0,
      })
      expect(r3?.shouldContinue).toBe(false)

      const finalState = yield* goal.load(sessionID)
      expect(finalState?.status).toBe("paused")
      expect(Number(finalState?.consecutive_parse_failures)).toBeGreaterThanOrEqual(
        GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES,
      )

      const paused = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "paused")
      expect(paused.length).toBe(1)
    }),
  )

  // §9.3b — alternating transport + parse failures. Before §9, transport errors
  // returned parseFailed: false which reset consecutive_parse_failures to 0 on
  // every transport blip, so alternating transport/parse/transport never
  // reached the threshold. After §9, both failure modes set parseFailed: true,
  // so the counter climbs monotonically across the mix and pauses on the 3rd.
  it.live("alternating transport + parse failures still triggers auto-pause", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      const seeded = yield* goal.set(sessionID, "build feature X", 10)

      // transport-fail (parseFailed: true) → counter 1
      const first = yield* goal.updateAfterJudge(sessionID, "continue", "transport error", true, {
        goalID: seeded.goal_id ?? "legacy",
        revision: seeded.revision ?? 0,
      })
      let state = yield* goal.load(sessionID)
      expect(Number(state?.consecutive_parse_failures)).toBe(1)
      expect(state?.status).toBe("active")

      // parse-fail (parseFailed: true) → counter 2
      yield* goal.updateAfterJudge(sessionID, "continue", "无法解析", true, {
        goalID: first?.state.goal_id ?? "legacy",
        revision: first?.state.revision ?? 0,
      })
      state = yield* goal.load(sessionID)
      expect(Number(state?.consecutive_parse_failures)).toBe(2)
      expect(state?.status).toBe("active")

      // transport-fail (parseFailed: true) → counter 3 → PAUSE
      const r3 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error", true, {
        goalID: state?.goal_id ?? "legacy",
        revision: state?.revision ?? 0,
      })
      expect(r3?.shouldContinue).toBe(false)

      state = yield* goal.load(sessionID)
      expect(state?.status).toBe("paused")
    }),
  )

  // GOAL-03: a judge that never produced a verdict (transport error or
  // unparseable output) evaluated no turn — it must not consume one of the
  // user's max_turns and must not stamp last_judged_msg (the boundary was
  // never judged; a crash after this commit must re-judge the same boundary,
  // and that re-judgment — not this failed attempt — may consume the budget
  // slot). The parse-failure counter still climbs, so an unreliable judge
  // still auto-pauses after MAX_CONSECUTIVE_PARSE_FAILURES.
  it.live("a failed judge is budget-neutral: no turns_used increment, no last_judged_msg stamp", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const seeded = yield* goal.set(sessionID, "build feature X", 10)

      const failed = yield* goal.updateAfterJudge(
        sessionID,
        "continue",
        "judge transport error (timeout or network) — counting toward pause budget",
        true,
        { goalID: seeded.goal_id ?? "legacy", revision: seeded.revision ?? 0 },
        "msg_boundary_failed",
      )
      expect(failed?.shouldContinue).toBe(true)

      const state = yield* goal.load(sessionID)
      expect(Number(state?.turns_used)).toBe(0)
      expect(state?.last_judged_msg).toBeUndefined()
      expect(Number(state?.consecutive_parse_failures)).toBe(1)

      // A successful judge afterwards consumes exactly one budget slot and
      // stamps the boundary it actually judged.
      const ok = yield* goal.updateAfterJudge(
        sessionID,
        "continue",
        "real verdict",
        false,
        { goalID: state?.goal_id ?? "legacy", revision: state?.revision ?? 0 },
        "msg_boundary_real",
      )
      expect(ok?.shouldContinue).toBe(true)
      const after = yield* goal.load(sessionID)
      expect(Number(after?.turns_used)).toBe(1)
      expect(after?.last_judged_msg).toBe("msg_boundary_real")
      expect(Number(after?.consecutive_parse_failures)).toBe(0)
    }),
  )

  // Issue #691 regression chain — the exact user-reported sequence in ONE
  // flow: 3 invalid judge results auto-pause (counter-climb + GOAL-03 budget
  // neutrality), resume retains goal/subgoals/max_turns and the un-spent
  // turns_used, then the first valid judgment after resume counts (0 → 1).
  // §9.2/§5.3/§9.3c each cover only a fragment; this locks the full chain.
  it.live("3 invalid results pause, resume retains goal/subgoals/budget/turns_used, valid continue counts", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 5)
      const seeded = yield* goal.addSubgoal(sessionID, "ship module A")

      let expected = { goalID: seeded?.goal_id ?? "legacy", revision: seeded?.revision ?? 0 }
      let result: Effect.Success<ReturnType<typeof goal.updateAfterJudge>>
      for (let attempt = 0; attempt < GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES; attempt++) {
        result = yield* goal.updateAfterJudge(sessionID, "continue", `invalid response ${attempt}`, true, expected)
        expect(result?.shouldContinue).toBe(attempt < GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES - 1)
        if (result) expected = { goalID: result.state.goal_id ?? "legacy", revision: result.state.revision ?? 0 }
      }

      // Auto-paused on the 3rd failure; nothing spent, nothing lost.
      const paused = yield* goal.load(sessionID)
      expect(paused?.status).toBe("paused")
      expect(Number(paused?.turns_used)).toBe(0)
      expect(paused?.goal).toBe("build feature X")
      expect(paused?.subgoals).toEqual(["ship module A"])
      expect(Number(paused?.max_turns)).toBe(5)

      // Resume: active again with goal/subgoals/budget and turns_used intact.
      const resumed = yield* goal.resume(sessionID)
      expect(resumed?.status).toBe("active")
      expect(resumed?.goal).toBe("build feature X")
      expect(resumed?.subgoals).toEqual(["ship module A"])
      expect(Number(resumed?.max_turns)).toBe(5)
      expect(Number(resumed?.turns_used)).toBe(0)
      expect(Number(resumed?.consecutive_parse_failures)).toBe(0)

      // The first valid judgment after resume counts: turns_used 0 → 1.
      const ok = yield* goal.updateAfterJudge(sessionID, "continue", "real verdict", false, {
        goalID: resumed?.goal_id ?? "legacy",
        revision: resumed?.revision ?? 0,
      })
      expect(ok?.shouldContinue).toBe(true)
      expect(Number(ok?.state.turns_used)).toBe(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// §10 — Zombie-goal freshness guard (D6). When afterIdle detects an active goal
// with turns_used 0, no assistant message, and created_at older than
// FRESHNESS_THRESHOLD, it calls pauseAndPublish with a freshness reason. This
// tests that the pause transition (the mechanism the guard uses) publishes the
// paused event with the freshness reason — the guard's predicate logic itself
// is locked in loop.test.ts (isStaleZombie).
// ---------------------------------------------------------------------------

describe("Goal.pauseAndPublish — freshness-guard pause (D6)", () => {
  // §10.3 — the exact pause transition afterIdle's freshness guard performs:
  // pauseAndPublish with the freshness reason string. Verifies the goal flips
  // to paused, the reason is persisted, and goal.updated(paused) fires on the
  // bus so the TUI/SSE surfaces the orphaned goal instead of leaving it silent.
  it.live("freshness pause transitions active→paused and publishes with the reason", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0

      const reason = `initial kick produced no assistant response within ${GoalPrompts.FRESHNESS_THRESHOLD / 1000}s — likely provider error or model refusal. Use /goal resume to retry.`
      const result = yield* goal.pauseAndPublish(sessionID, reason)

      expect(result?.status).toBe("paused")
      expect(result?.paused_reason).toBe(reason)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("paused")
      expect(loaded?.paused_reason).toBe(reason)

      const paused = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "paused")
      expect(paused.length).toBe(1)
    }),
  )

  // §10.4 — a fresh goal (within threshold) does NOT hit the freshness guard.
  // pauseAndPublish with a freshness reason is never invoked; the goal stays
  // active. This is verified at the predicate level in loop.test.ts
  // (isStaleZombie returns false for fresh goals); here we confirm a fresh
  // goal row remains active and unpauseable by anything other than an explicit
  // pause call — the guard's absence is the expected behavior.
  it.live("fresh goal stays active (freshness guard does not fire)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      // A freshly-set goal: created_at is now, turns_used 0 — the exact state
      // the guard checks, but within the threshold so the predicate is false.
      yield* goal.set(sessionID, "build feature X", 10)

      const state = yield* goal.load(sessionID)
      expect(state?.status).toBe("active")
      expect(Number(state?.turns_used)).toBe(0)
      // created_at is recent (within the last second), well inside the threshold
      expect(Date.now() - Number(state?.created_at)).toBeLessThan(GoalPrompts.FRESHNESS_THRESHOLD)
    }),
  )
})

// ---------------------------------------------------------------------------
// §F1 — Terminal / pause sequences are uninterruptible (defense-in-depth).
// deleteAndPublishDone and pauseAndPublish are wrapped in Effect.uninterruptible
// so an interrupt landing mid-region can never split the load → publish →
// delete → publish contract. These tests fork each effect, prove the fiber has
// ENTERED the uninterruptible region via an observable entry signal, then
// interrupt and assert the remaining events still fired.
// ---------------------------------------------------------------------------

describe("Goal.deleteAndPublishDone — terminal sequence is uninterruptible (F1)", () => {
  // The rigorous interrupt-during-region proof. goal.updated(done) can only
  // fire once the region has started (loadState + publishGoal both ran), so
  // waiting for it guarantees the interrupt below lands INSIDE the region. If
  // the Effect.uninterruptible wrapper were removed, the interrupt could kill
  // the fiber between publish(done) and publish(cleared), and the cleared
  // assertion would fail.
  it.live("publishes goal.updated(done) and goal.cleared when the calling fiber is interrupted mid-region", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      seen.length = 0

      const fiber = yield* goal.deleteAndPublishDone(sessionID, "delivered").pipe(Effect.forkScoped)

      // Entry proof: goal.updated(done) published → region entered.
      yield* pollWithTimeout(
        Effect.sync(() =>
          seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "done") ? true : undefined,
        ),
        "deleteAndPublishDone never published goal.updated(done)",
      )

      // Interrupt mid-region. The region is uninterruptible, so deleteState +
      // publish(cleared) complete before the deferred interrupt terminates
      // the fiber.
      yield* Fiber.interrupt(fiber)

      const done = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
      expect(done.length).toBe(1)
      const cleared = seen.filter((e) => e.type === GoalEvent.Cleared.type)
      expect(cleared.length).toBe(1)

      // deleteState ran — row is gone.
      const loaded = yield* goal.load(sessionID)
      expect(loaded).toBeUndefined()
    }),
  )
})

describe("Goal.pauseAndPublish — pause transition is uninterruptible (F1)", () => {
  // Complementary to the deleteAndPublishDone test. pauseAndPublish publishes
  // only one event (goal.updated(paused)), so the entry signal is the DB row
  // flipping to paused (saveState completed = region entered). After that we
  // interrupt and assert publishGoal(paused) still fired. Combined with the
  // deleteAndPublishDone test (same Effect.uninterruptible pattern), this
  // locks the F1 uninterruptible wrapping on both fiber-safe paths.
  it.live("publishes goal.updated(paused) when the calling fiber is interrupted after the region starts", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0

      const fiber = yield* goal.pauseAndPublish(sessionID, "interrupted mid-pause").pipe(Effect.forkScoped)

      // Entry proof: saveState completed → row flipped to paused.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const st = yield* goal.load(sessionID)
          return st?.status === "paused" ? true : undefined
        }),
        "pauseAndPublish never persisted the paused row",
      )

      // Interrupt after the region started. The region is uninterruptible, so
      // publishGoal(paused) still runs before the fiber terminates.
      yield* Fiber.interrupt(fiber)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("paused")
      expect(loaded?.paused_reason).toBe("interrupted mid-pause")
      const paused = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "paused")
      expect(paused.length).toBe(1)
    }),
  )
})

// ── Goal.dispatch resume — busy guard (D5) ─────────────────────────
//
// `/goal resume` is a control command and bypasses the generic dispatch busy
// check. Without an explicit guard it would return `kick` on a busy session,
// prompting prompt.ts to start a second agent loop concurrently. The resume
// branch now checks sessionStatus first: busy → message (ask to /stop), goal
// stays paused; idle → kick as before (including the budget-exhaustion announce).
//
// SessionStatus is mocked (rather than the real defaultLayer) so the test can
// pin the busy/idle verdict Goal.dispatch observes without dragging in
// InstanceRef/InstanceState machinery. Goal.layer is provided the mock, so
// dispatch queries the same controllable instance.

const mockStatusLayer = (status: SessionStatus.Info) =>
  Layer.succeed(SessionStatus.Service, {
    get: () => Effect.succeed(status),
    set: () => Effect.void,
    list: () => Effect.succeed(new Map()),
  })

const resumeLayer = (status: SessionStatus.Info) =>
  Goal.layer.pipe(
    Layer.provide(mockStatusLayer(status)),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )

describe("Goal.dispatch resume — busy guard (D5)", () => {
  testEffect(resumeLayer({ type: "busy" })).live(
    "busy session: /goal resume returns a message and keeps the goal paused",
    () =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const sessionID = SessionID.descending()
        yield* goal.set(sessionID, "ship feature X", 10)
        yield* goal.pause(sessionID, "user-paused")

        const result = yield* goal.dispatch(sessionID, "resume")

        expect(result.type).toBe("message")
        const loaded = yield* goal.load(sessionID)
        expect(loaded?.status).toBe("paused")
      }),
  )

  testEffect(resumeLayer({ type: "idle" })).live(
    "idle session: /goal resume returns a kick and reactivates the goal",
    () =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const sessionID = SessionID.descending()
        yield* goal.set(sessionID, "ship feature X", 10)
        yield* goal.pause(sessionID, "user-paused")

        const result = yield* goal.dispatch(sessionID, "resume")

        expect(result.type).toBe("kick")
        const loaded = yield* goal.load(sessionID)
        expect(loaded?.status).toBe("active")
      }),
  )

  // Budget-exhausted resume still returns kick on idle (the existing announce
  // UX), but the busy guard must take precedence over the kick path.
  testEffect(resumeLayer({ type: "busy" })).live(
    "busy session: resume does not kick even when budget is exhausted",
    () =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const sessionID = SessionID.descending()
        // max_turns 1 → one continue exhausts the budget and auto-pauses.
        const state = yield* goal.set(sessionID, "ship feature X", 1)
        yield* goal.updateAfterJudge(sessionID, "continue", "more", false, {
          goalID: state.goal_id ?? "legacy",
          revision: state.revision ?? 0,
        })
        const paused = yield* goal.load(sessionID)
        expect(paused?.status).toBe("paused")

        const result = yield* goal.dispatch(sessionID, "resume")

        expect(result.type).toBe("message")
        const loaded = yield* goal.load(sessionID)
        expect(loaded?.status).toBe("paused")
      }),
  )
})

it.instance("Goal commands configure and extend a total turn budget", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const id = SessionID.descending()
    expect((yield* goal.dispatch(id, "--max-turns 3 write docs")).type).toBe("kick")
    const state = yield* goal.load(id)
    expect(state).toMatchObject({ goal: "write docs", max_turns: 3 })
    yield* goal.updateAfterJudge(id, "continue", "more", false, { goalID: state!.goal_id!, revision: state!.revision! })
    yield* goal.pause(id, "user-paused")
    expect((yield* goal.dispatch(id, "resume --max-turns 6")).type).toBe("kick")
    expect(yield* goal.load(id)).toMatchObject({ status: "active", max_turns: 6, turns_used: 1 })
  }),
)

for (const value of ["0", "-1", "1.5", "abc", "9007199254740992", ""]) {
  it.instance(`Goal rejects invalid budget ${JSON.stringify(value)} without creating state`, () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = SessionID.descending()
      expect((yield* goal.dispatch(id, `--max-turns ${value} write docs`)).type).toBe("message")
      expect(yield* goal.load(id)).toBeUndefined()
    }),
  )
}

it.instance("Goal invalid resume budgets preserve the entire paused state", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const id = SessionID.descending()
    const initial = yield* goal.set(id, "write docs", 3)
    yield* goal.updateAfterJudge(id, "continue", "more work", false, {
      goalID: initial.goal_id ?? "legacy",
      revision: initial.revision ?? 0,
    })
    const paused = yield* goal.pause(id, "user-paused")
    for (const argument of [
      "resume --max-turns 1",
      "resume --max-turns 0",
      "resume --max-turns abc",
      "resume --max-turns 5 extra",
      "resume --max-turns=5",
    ]) {
      expect((yield* goal.dispatch(id, argument)).type).toBe("message")
      expect(yield* goal.load(id)).toEqual(paused)
    }
  }),
)

// D-3 beyond the startup scan: an undecodable goal_state row (corruption or a
// newer payload schema) must stay removable through the product and must not
// kill the shared automation lease, whose Goal authority runs on every claim.
describe("Goal — undecodable goal_state row", () => {
  const corruptIt = testEffect(
    Goal.layer.pipe(
      Layer.provide(SessionStatus.defaultLayer),
      Layer.provideMerge(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provideMerge(SessionAutomationLease.defaultLayer),
    ),
  )
  const insertCorrupt = (sid: SessionID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(GoalStateTable).values({ session_id: sid, payload: "{corrupt", updated_at: Date.now() })
    })
  const rowExists = (sid: SessionID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db.select().from(GoalStateTable).where(eq(GoalStateTable.session_id, sid)).get()
      return row !== undefined
    })

  corruptIt.instance("/goal clear and /goal stop delete an undecodable row", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      for (const command of ["clear", "stop"]) {
        const sid = SessionID.descending()
        yield* insertCorrupt(sid)
        const result = yield* goal.dispatch(sid, command).pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(true)
        expect(yield* rowExists(sid)).toBe(false)
      }
    }),
  )

  corruptIt.instance("purgeSession deletes an undecodable row so session deletion leaves no orphan", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* insertCorrupt(sid)
      expect(Exit.isSuccess(yield* goal.purgeSession(sid).pipe(Effect.exit))).toBe(true)
      expect(yield* rowExists(sid)).toBe(false)
    }),
  )

  corruptIt.instance("the lease Goal authority treats an undecodable row as no active goal", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* insertCorrupt(sid)
      const dagClaim = yield* lease.claim(sid, { kind: "dag" }).pipe(Effect.exit)
      expect(Exit.isSuccess(dagClaim)).toBe(true)
      // Non-delete mutations still refuse to overwrite a row this build cannot read.
      expect(Exit.isSuccess(yield* goal.pauseAndPublish(sid, "x").pipe(Effect.exit))).toBe(false)
      expect(yield* rowExists(sid)).toBe(true)
    }),
  )
})
