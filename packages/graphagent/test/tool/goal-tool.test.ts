// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { BackgroundJob } from "@graphagent/core/background-job"
import { stateOf, type StateRef } from "@graphagent/core/lifecycle/state"
import type { Domain } from "@graphagent/schema/lifecycle-status"
import { Agent } from "../../src/agent/agent"
import { Goal } from "../../src/goal/goal"
import { GoalState } from "../../src/goal/state"
import { Lifecycle } from "../../src/lifecycle/service"
import { PrWatchPoller } from "../../src/pr-watch/poller"
import { GoalTool } from "../../src/tool/goal"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
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

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason)) return reason.error
    if (Cause.isDieReason(reason)) return reason.defect
  }
  return undefined
}

const runningJob = (id: string): BackgroundJob.Info => ({
  id,
  type: "general",
  status: "running",
  started_at: 0,
  metadata: { sessionID: "ses_goal_tool" },
})

const watchInfo = (input: Partial<PrWatchPoller.WatchInfo> = {}): PrWatchPoller.WatchInfo => ({
  id: "watch_goal",
  url: "https://github.com/acme/widgets/pull/42",
  phase: "watching",
  head: "a",
  outcome: null,
  deadlineAt: Date.now() + 120_000,
  delivery: null,
  ...input,
})

const pollerLayer = (watches: ReadonlyArray<PrWatchPoller.WatchInfo>) =>
  Layer.succeed(
    PrWatchPoller.Service,
    PrWatchPoller.Service.of({
      register: () => Effect.die(new Error("register is not used by this test")),
      query: () => Effect.succeed(watches),
      cancel: () => Effect.succeed(undefined),
      retireSession: () => Effect.succeed(0),
      pollOnce: () => Effect.succeed(0),
      recoverOnce: () => Effect.succeed(0),
      init: () => Effect.void,
    }),
  )

const jobLayer = (jobs: ReadonlyArray<BackgroundJob.Info>) =>
  Layer.mock(BackgroundJob.Service, { list: () => Effect.sync(() => [...jobs]) })

const waitingState = (intent: GoalState.Intent): GoalState.Info =>
  new GoalState.Info({
    goal: activeGoal.goal,
    status: "waiting",
    turns_used: activeGoal.turns_used,
    max_turns: activeGoal.max_turns,
    created_at: activeGoal.created_at,
    last_turn_at: activeGoal.last_turn_at,
    consecutive_parse_failures: 0,
    subgoals: [],
    intent,
  })

describe("tool.goal — await intent validation (#1067/#1071)", () => {
  it.instance("rejects a missing or terminal watch without changing goal state", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      let intentCalls = 0
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: () =>
          Effect.sync(() => {
            intentCalls += 1
            return activeGoal
          }),
      })
      const cases = [
        { watches: [] as PrWatchPoller.WatchInfo[], detail: "no watch with the id or URL" },
        {
          watches: [watchInfo({ phase: "succeeded", outcome: "success" })],
          detail: "already ended (succeeded)",
        },
        {
          watches: [watchInfo({ phase: "delivering", outcome: "failure" })],
          detail: "already observed its outcome (failure)",
        },
      ]
      for (const entry of cases) {
        const exit = yield* tool
          .execute(
            { action: "intent", intent: "await", wait_source: "watch_pr", wait_id: "watch_goal" },
            ctx(),
          )
          .pipe(Effect.provide(Layer.merge(goalLayer, pollerLayer(entry.watches))), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const error = failureOf(exit)
        if (!(error instanceof Tool.InvalidArgumentsError))
          throw new Error(`expected InvalidArgumentsError, got ${String(error)}`)
        expect(error.message).toContain(entry.detail)
      }
      expect(intentCalls).toBe(0)
    }),
  )

  it.instance("accepts a background task owned through parentSessionId", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      let captured: GoalState.Intent | undefined
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: (_sessionID: SessionID, intent: GoalState.Intent) =>
          Effect.sync(() => {
            captured = intent
            return waitingState(intent)
          }),
      })
      // A background task records the child session as sessionId and the
      // caller as parentSessionId; the caller must still own the wait.
      const child: BackgroundJob.Info = {
        id: "ses_child",
        type: "general",
        status: "running",
        started_at: 0,
        metadata: { sessionID: "ses_child", parentSessionID: "ses_goal_tool" },
      }
      const jobs = Layer.mock(BackgroundJob.Service, { list: () => Effect.sync(() => [child]) })

      const result = yield* tool
        .execute({ action: "intent", intent: "await", wait_source: "background_job", wait_id: "ses_child" }, ctx())
        .pipe(Effect.provide(Layer.merge(goalLayer, jobs)))

      expect(captured?.kind).toBe("await")
      expect(captured?.kind === "await" ? captured.wait.ref : undefined).toEqual({ domain: "job", id: "ses_child" })
      expect(result.output).toContain("Waiting for: background_job:ses_child")
    }),
  )

  it.instance("derives the default await deadline from the watch's remaining time", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const deadlineAt = Date.now() + 120_000
      let captured: GoalState.Intent | undefined
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: (_sessionID: SessionID, intent: GoalState.Intent) =>
          Effect.sync(() => {
            captured = intent
            return waitingState(intent)
          }),
      })
      const poller = pollerLayer([watchInfo({ deadlineAt })])

      const result = yield* tool
        .execute(
          {
            action: "intent",
            intent: "await",
            wait_source: "watch_pr",
            // A watch_pr wait may name either the watch id or the watched URL.
            wait_id: "https://github.com/acme/widgets/pull/42",
          },
          ctx(),
        )
        .pipe(Effect.provide(Layer.merge(goalLayer, poller)))

      expect(result.output).toContain("Waiting for: watch_pr:")
      const wait = captured?.kind === "await" ? captured.wait : undefined
      expect(wait?.wait_id).toBe("https://github.com/acme/widgets/pull/42")
      // The resolved watch id, not the caller's URL spelling, is the identity.
      expect(wait?.ref).toEqual({ domain: "pr_watch", id: "watch_goal" })
      // The watch's own deadline plus the delivery margin, not the fixed 30 min.
      expect(wait?.deadline).toBeGreaterThanOrEqual(deadlineAt + 59_000)
      expect(wait?.deadline).toBeLessThanOrEqual(deadlineAt + 61_000)
    }),
  )

  it.instance("hints when an explicit deadline expires before the watch does", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      const before = Date.now()
      const deadlineAt = before + 120_000
      let captured: GoalState.Intent | undefined
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: (_sessionID: SessionID, intent: GoalState.Intent) =>
          Effect.sync(() => {
            captured = intent
            return waitingState(intent)
          }),
      })
      const poller = pollerLayer([watchInfo({ deadlineAt })])

      const result = yield* tool
        .execute(
          {
            action: "intent",
            intent: "await",
            wait_source: "watch_pr",
            wait_id: "watch_goal",
            deadline_ms: 10_000,
          },
          ctx(),
        )
        .pipe(Effect.provide(Layer.merge(goalLayer, poller)))

      expect(result.output).toContain("shorter than the watch's remaining")
      const wait = captured?.kind === "await" ? captured.wait : undefined
      expect(wait?.deadline).toBeGreaterThanOrEqual(before + 10_000)
      expect(wait?.deadline).toBeLessThanOrEqual(Date.now() + 10_000)
    }),
  )

  it.instance("rejects a background job the lifecycle contract reports as terminal", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      let intentCalls = 0
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: () =>
          Effect.sync(() => {
            intentCalls += 1
            return activeGoal
          }),
      })
      // The registry still lists the job as running; the contract disagrees.
      const jobs = jobLayer([runningJob("job_running")])
      const lifecycle = Layer.mock(Lifecycle.Service, {
        get: <D extends Domain>(target: StateRef<D>) =>
          Effect.succeed(Option.some(stateOf({ ref: target, value: "completed", source: "live" }))),
      })

      const exit = yield* tool
        .execute(
          { action: "intent", intent: "await", wait_source: "background_job", wait_id: "job_running" },
          ctx(),
        )
        .pipe(Effect.provide(Layer.mergeAll(goalLayer, jobs, lifecycle)), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = failureOf(exit)
      if (!(error instanceof Tool.InvalidArgumentsError))
        throw new Error(`expected InvalidArgumentsError, got ${String(error)}`)
      expect(error.message).toContain("terminal")
      expect(intentCalls).toBe(0)
    }),
  )

  it.instance("accepts watch_pr without the poller service in a headless runtime", () =>
    Effect.gen(function* () {
      const info = yield* GoalTool
      const tool = yield* info.init()
      let captured: GoalState.Intent | undefined
      const goalLayer = Layer.mock(Goal.Service, {
        setIntent: (_sessionID: SessionID, intent: GoalState.Intent) =>
          Effect.sync(() => {
            captured = intent
            return waitingState(intent)
          }),
      })

      yield* tool
        .execute(
          { action: "intent", intent: "await", wait_source: "watch_pr", wait_id: "watch_missing" },
          ctx(),
        )
        .pipe(Effect.provide(goalLayer))

      // No validation target: the declaration is accepted and matches by the
      // source plus the caller's spelling, exactly like the pre-#1071 degrade.
      expect(captured?.kind).toBe("await")
      expect(captured?.kind === "await" ? captured.wait.ref : undefined).toBeUndefined()
    }),
  )
})

function markDoneNeverCalled(output: string) {
  return !output.includes("Goal completed")
}
