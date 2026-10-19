import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { GoalTool } from "@/tool/goal"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Goal.defaultLayer,
    SessionStatus.defaultLayer,
    SessionAutomationLease.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
  ),
)

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    callID: "goal-control",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("model goal controls", () => {
  it.instance("tool creates literal goal text during a busy turn and keeps ESC protection", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const tool = yield* (yield* GoalTool).init()
      const sid = SessionID.descending()
      yield* status.set(sid, { type: "busy" })
      const result = yield* tool.execute({ action: "create", text: "pause" }, context(sid))
      expect(result.output).toContain("Status: active")
      const state = yield* goal.load(sid)
      expect(state?.goal).toBe("pause")
      expect(state?.max_turns).toBe(20)
      expect(yield* status.get(sid)).toEqual({ type: "busy" })
      expect(yield* goal.isTurnDriven(sid)).toBe(true)
      yield* goal.pauseForUserCancel(sid, "user stopped")
      expect((yield* goal.load(sid))?.status).toBe("paused")
    }),
  )

  it.instance("concurrent creates have one winner and cannot replace a paused goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      const results = yield* Effect.all(
        [
          goal.controlDuringTurn(sid, { action: "create", text: "first" }),
          goal.controlDuringTurn(sid, { action: "create", text: "second" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result.changed)).toHaveLength(1)
      const original = yield* goal.load(sid)
      yield* goal.controlDuringTurn(sid, { action: "pause", reason: "wait" })
      const rejected = yield* goal.controlDuringTurn(sid, { action: "create", text: "replacement" })
      expect(rejected.changed).toBe(false)
      expect((yield* goal.load(sid))?.goal_id).toBe(original?.goal_id)
    }),
  )

  it.instance("invalid tool arguments never create or change state", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const tool = yield* (yield* GoalTool).init()
      const sid = SessionID.descending()
      for (const max_turns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = yield* tool
          .execute({ action: "create", text: "work", max_turns }, context(sid))
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("invalid arguments")
        expect(yield* goal.load(sid)).toBeUndefined()
      }
      for (const text of [undefined, "   "]) {
        const result = yield* tool.execute({ action: "create", text }, context(sid))
        expect(result.output).toContain("text is required")
        expect(yield* goal.load(sid)).toBeUndefined()
      }
      yield* tool.execute({ action: "create", text: "work" }, context(sid))
      const original = yield* goal.load(sid)
      const result = yield* tool.execute({ action: "pause", reason: " " }, context(sid))
      expect(result.output).toContain("reason is required")
      expect(yield* goal.load(sid)).toEqual(original)
    }),
  )

  it.instance("pause returns inside the registered loop fiber and releases ownership", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const lease = yield* SessionAutomationLease.Service
      const tool = yield* (yield* GoalTool).init()
      const sid = SessionID.descending()
      yield* tool.execute({ action: "create", text: "work" }, context(sid))
      const state = yield* goal.load(sid)
      const owner = { kind: "goal" as const, id: state?.goal_id ?? "legacy" }
      expect(Option.isSome(yield* lease.claim(sid, owner))).toBe(true)
      const ready = yield* Deferred.make<void>()
      const fiber = yield* Effect.gen(function* () {
        yield* Deferred.await(ready)
        return yield* tool.execute({ action: "pause", reason: "need credentials" }, context(sid))
      }).pipe(Effect.forkChild)
      yield* goal.registerLoopFiber(sid, fiber)
      yield* Deferred.succeed(ready, undefined)
      const result = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
      expect(result.output).toContain("Status: paused")
      expect((yield* goal.load(sid))?.paused_reason).toBe("need credentials")
      expect(Option.isNone(yield* lease.claim(sid, owner))).toBe(true)
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
      yield* goal.clearLoopFiberIf(sid, fiber)
    }),
  )

  it.instance("resume preserves identity, subgoals and consumed budget and rejects exhausted retries", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const tool = yield* (yield* GoalTool).init()
      const sid = SessionID.descending()
      yield* tool.execute({ action: "create", text: "work", max_turns: 1 }, context(sid))
      yield* goal.addSubgoal(sid, "verify")
      const original = yield* goal.load(sid)
      yield* goal.updateAfterJudge(sid, "continue", "more work", false, {
        goalID: original?.goal_id ?? "legacy",
        revision: original?.revision ?? 0,
      })
      const exhausted = yield* goal.load(sid)
      expect(exhausted?.status).toBe("paused")
      for (const max_turns of [undefined, 1]) {
        const result = yield* tool.execute({ action: "resume", max_turns }, context(sid))
        expect(result.output).toContain("Cannot resume")
        expect(yield* goal.load(sid)).toEqual(exhausted)
      }
      for (const max_turns of [0, 1.5]) {
        const result = yield* tool.execute({ action: "resume", max_turns }, context(sid)).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("invalid arguments")
        expect(yield* goal.load(sid)).toEqual(exhausted)
      }
      const result = yield* tool.execute({ action: "resume", max_turns: 3 }, context(sid))
      expect(result.output).toContain("Status: active")
      const resumed = yield* goal.load(sid)
      expect(resumed?.goal_id).toBe(original?.goal_id)
      expect(resumed?.subgoals).toEqual(["verify"])
      expect(resumed?.turns_used).toBe(1)
      expect(resumed?.max_turns).toBe(3)
      expect(yield* goal.isTurnDriven(sid)).toBe(true)
      yield* tool.execute({ action: "pause", reason: "wait" }, context(sid))
      yield* tool.execute({ action: "resume" }, context(sid))
      expect((yield* goal.load(sid))?.turns_used).toBe(1)
      expect((yield* goal.load(sid))?.max_turns).toBe(3)
    }),
  )

  it.instance("missing or incompatible state returns truthful no-ops", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const tool = yield* (yield* GoalTool).init()
      const sid = SessionID.descending()
      for (const action of ["resume", "pause"] as const) {
        const result = yield* tool.execute({ action, reason: "wait" }, context(sid))
        expect(result.output).toContain("No state change was applied")
        expect(yield* goal.load(sid)).toBeUndefined()
      }
      yield* tool.execute({ action: "create", text: "work" }, context(sid))
      const original = yield* goal.load(sid)
      const result = yield* tool.execute({ action: "resume" }, context(sid))
      expect(result.output).toContain("No paused goal")
      expect(yield* goal.load(sid)).toEqual(original)
    }),
  )
})
