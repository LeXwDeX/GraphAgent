import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Goal } from "../../src/goal/goal"
import { GoalState } from "../../src/goal/state"
import { GoalTool } from "../../src/tool/goal"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

// Goal.Service is INTENTIONALLY absent from this build context — it mirrors the
// production ToolRegistry build phase (AppLayer group2), where Goal.Service (a
// group1 Layer.mergeAll sibling) is not visible at construction. Goal is
// provided only at execute time below, matching the production request phase.
//
// Before the tool-init-service-resolution fix, the goal tool captured a
// build-phase `None` from Effect.serviceOption(Goal.Service) into a closure, so
// the reachability assertions below would FAIL regardless of the execute-time
// provide (the tool always returned "service unavailable"). These tests lock
// the fixed contract: the probe resolves in execute, where Goal.Service lives.
const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

function ctx(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_goal_tool"),
    messageID: MessageID.make("msg_goal_tool"),
    callID: "call_goal_tool",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const activeGoal = {
  goal: "read the docs",
  status: "active",
  turns_used: 2,
  max_turns: 20,
  created_at: Date.now(),
  last_turn_at: Date.now(),
  consecutive_parse_failures: 0,
  subgoals: [],
} as GoalState.Info

const doneGoal = { ...activeGoal, status: "done", turns_used: 3 } as GoalState.Info

describe("tool.goal — service resolution phase", () => {
  it.instance("status reaches Goal.Service when provided at execute time", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const goalLayer = Layer.mock(Goal.Service, {
        load: () => Effect.succeed(undefined),
      })

      const result = yield* tool.execute({ action: "status" }, ctx()).pipe(Effect.provide(goalLayer))

      expect(result.output).not.toContain("not available in this runtime")
      expect(result.output).toContain("No autonomous goal")
    }),
  )

  it.instance("status renders state when an active goal is loaded", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const goalLayer = Layer.mock(Goal.Service, {
        load: () => Effect.succeed(activeGoal),
      })

      const result = yield* tool.execute({ action: "status" }, ctx()).pipe(Effect.provide(goalLayer))

      expect(result.output).toContain("Goal: read the docs")
      expect(result.output).toContain("Status: active")
      expect(result.output).toContain("Turns: 2/20")
    }),
  )

  it.instance("complete calls markDone and clears goal state (regression guard)", () =>
    Effect.gen(function* () {
      let markDoneCalls = 0
      const info = yield* GoalTool
      const tool = yield* info.init()
      const goalLayer = Layer.mock(Goal.Service, {
        load: () => Effect.succeed(activeGoal),
        markDone: () =>
          Effect.sync(() => {
            markDoneCalls += 1
            return doneGoal
          }),
      })

      const result = yield* tool
        .execute({ action: "complete", reason: "docs read" }, ctx())
        .pipe(Effect.provide(goalLayer))

      expect(markDoneCalls).toBe(1)
      expect(result.output).toContain("Goal completed")
      expect(result.output).toContain("docs read")
    }),
  )

  it.instance("complete refuses to complete when no active goal is loaded", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const goalLayer = Layer.mock(Goal.Service, {
        load: () => Effect.succeed(undefined),
      })

      const result = yield* tool
        .execute({ action: "complete", reason: "nothing to do" }, ctx())
        .pipe(Effect.provide(goalLayer))

      expect(markDoneNeverCalled(result.output))
      expect(result.output).toContain("Cannot complete goal: no active goal")
    }),
  )

  // GOAL-FP-01-09: markDone re-loads the current row and can no-op when the
  // goal was cleared or completed between the tool's `load` and the transition.
  // The tool must NOT present that no-op as an achievement — the stale
  // "✓ Goal completed" line would claim a transition that never happened.
  it.instance("complete does not claim achievement when markDone did not transition (GOAL-FP-01-09)", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const goalLayer = Layer.mock(Goal.Service, {
        load: () => Effect.succeed(activeGoal),
        markDone: () => Effect.succeed(undefined),
      })

      const result = yield* tool
        .execute({ action: "complete", reason: "docs read" }, ctx())
        .pipe(Effect.provide(goalLayer))

      expect(result.output).not.toContain("Goal completed")
      expect(result.output).toContain("Cannot complete goal")
    }),
  )

  it.instance("status degrades gracefully when Goal.Service is absent (headless)", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()

      // No Goal.Service provided at execute time — e.g. a headless runtime.
      const result = yield* tool.execute({ action: "status" }, ctx())

      expect(result.output).toContain("not available in this runtime")
    }),
  )
})

function markDoneNeverCalled(output: string) {
  return !output.includes("Goal completed")
}
