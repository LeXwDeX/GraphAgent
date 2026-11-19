// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LoopHost } from "@/loop/host"
import { LoopDecision } from "@/loop/decision"
import { LoopState } from "@/loop/state"
import { StopCondition } from "@/session/stop-condition"
import { intent, progress } from "./fixture"

const boundary = (overrides: Partial<LoopHost.Boundary> = {}): LoopHost.Boundary => ({
  message: "msg_2",
  endedAt: 1_000,
  turn: { type: "completed" },
  humanTurn: false,
  userRejected: false,
  ...overrides,
})

const state = (overrides: Partial<LoopState.Info> = {}) => LoopState.advance(LoopState.initial({ prompt: "Goal." }), overrides)

const wait = (overrides: Partial<LoopState.Wait> = {}): LoopState.Wait => ({
  source: "background_job",
  wait_id: "job_1",
  ref: { domain: "job", id: "job_1" },
  deadline: 1_000,
  max_wakes: 1,
  wakes: 0,
  reviewed: false,
  ...overrides,
})

describe("LoopDecision failure chain", () => {
  const recovery: LoopState.Recovery = { attempts: 1, reset: 0, probes: 0, boundary: "msg_1" }

  test("a turn that worked since the failure ends the chain; the same boundary again does not", () => {
    expect(LoopDecision.chainOf(undefined, boundary())).toEqual(LoopDecision.ZERO_CHAIN)
    expect(LoopDecision.chainOf(recovery, boundary({ message: "msg_2" }))).toEqual(LoopDecision.ZERO_CHAIN)
    expect(LoopDecision.chainOf(recovery, boundary({ message: "msg_1" }))).toEqual({ attempts: 1, reset: 0, probes: 0 })
  })

  test("a turn that failed or was cut short does not end it", () => {
    for (const turn of [
      { type: "error", code: "APIError", retryable: true },
      { type: "interrupted" },
      { type: "cancelled", reason: undefined },
    ] as const) {
      expect(LoopDecision.chainOf(recovery, boundary({ turn }))).toEqual({ attempts: 1, reset: 0, probes: 0 })
    }
  })

  test("each rung of the ladder adds to its own count and anchors the chain at the failed boundary", () => {
    const chain = { attempts: 1, reset: 0, probes: 0 }
    const at = boundary({ message: "msg_7" })
    expect(LoopDecision.recoveryAfter(chain, { type: "retry" }, at, 50, "round")).toEqual({
      attempts: 2,
      reset: 0,
      probes: 0,
      boundary: "msg_7",
      step: "round",
    })
    expect(LoopDecision.recoveryAfter(chain, { type: "reset" }, at, 50, "round")).toEqual({
      attempts: 1,
      reset: 1,
      probes: 0,
      boundary: "msg_7",
      step: "round",
    })
    expect(LoopDecision.recoveryAfter(chain, { type: "probe", after_ms: 60_000 }, at, 50, "round")).toEqual({
      attempts: 1,
      reset: 0,
      probes: 1,
      probe_at: 60_050,
      boundary: "msg_7",
      step: "round",
    })
    const left = LoopDecision.recoveryAfter(chain, { type: "retry" }, boundary({ message: undefined }), 0, "round")
    expect(left.boundary).toBe("")
  })

  test("records the step that failed, whichever rung of the ladder it is", () => {
    const chain = { attempts: 2, reset: 0, probes: 0 }
    const at = boundary({ message: "msg_7" })
    for (const action of [{ type: "retry" }, { type: "reset" }, { type: "probe", after_ms: 60_000 }] as const) {
      expect(LoopDecision.recoveryAfter(chain, action, at, 0, "analysis").step).toBe("analysis")
      expect(LoopDecision.recoveryAfter(chain, action, at, 0, "round").step).toBe("round")
    }
  })
})

describe("LoopDecision probe step", () => {
  const planned = (step: LoopState.Recovery["step"], at = "msg_5"): LoopState.Recovery => ({
    attempts: 2,
    reset: 0,
    probes: 1,
    probe_at: 10,
    boundary: at,
    ...(step !== undefined ? { step } : {}),
  })
  const failedTurn = { type: "error", code: "APIError", retryable: false } as const

  test("is the recorded one at the boundary it was recorded at, whatever that boundary's turn looks like", () => {
    // A loop resumed at a boundary whose turn ended on an error analyses it first: the analysis is what failed.
    expect(LoopDecision.stepOf(planned("analysis"), boundary({ message: "msg_5", turn: failedTurn }))).toBe("analysis")
    expect(LoopDecision.stepOf(planned("analysis"), boundary({ message: "msg_5" }))).toBe("analysis")
    expect(LoopDecision.stepOf(planned("round"), boundary({ message: "msg_5", turn: failedTurn }))).toBe("round")
    expect(LoopDecision.stepOf(planned("round"), boundary({ message: "msg_5" }))).toBe("round")
  })

  test("is read off the boundary at any other one: an error or no message is a round, anything else is analysed", () => {
    const interrupted = { type: "interrupted" } as const
    for (const step of ["round", "analysis"] as const) {
      const recovery = planned(step)
      expect(LoopDecision.stepOf(recovery, boundary({ message: "msg_6", turn: failedTurn }))).toBe("round")
      expect(LoopDecision.stepOf(recovery, boundary({ message: undefined, turn: interrupted }))).toBe("round")
      expect(LoopDecision.stepOf(recovery, boundary({ message: "msg_6", turn: interrupted }))).toBe("analysis")
    }
  })

  test("is read off the boundary for a chain that recorded none, also at the boundary it is anchored at", () => {
    expect(LoopDecision.stepOf(planned(undefined), boundary({ message: "msg_5", turn: failedTurn }))).toBe("round")
    expect(LoopDecision.stepOf(planned(undefined), boundary({ message: "msg_5" }))).toBe("analysis")
  })

  test("a round that left no message is anchored at the empty key, and is a round", () => {
    expect(LoopDecision.stepOf(planned("round", ""), boundary({ message: undefined }))).toBe("round")
  })
})

describe("LoopDecision older boundaries", () => {
  const origin = { message_id: "msg_5", created_at: 10_000 }

  test("a closing message that is not newer than the loop's first message is an older boundary", () => {
    expect(LoopDecision.precedesLoop(origin, boundary({ message: "msg_4" }))).toBe(true)
    expect(LoopDecision.precedesLoop(origin, boundary({ message: "msg_5" }))).toBe(true)
    expect(LoopDecision.precedesLoop(origin, boundary({ message: "msg_6" }))).toBe(false)
  })

  test("a turn that left no message is told by when it ended: before the loop began it is older, from then on it is the loop's", () => {
    expect(LoopDecision.precedesLoop(origin, boundary({ message: undefined, endedAt: 9_999 }))).toBe(true)
    expect(LoopDecision.precedesLoop(origin, boundary({ message: undefined, endedAt: 10_000 }))).toBe(false)
    expect(LoopDecision.precedesLoop(origin, boundary({ message: undefined, endedAt: 20_000 }))).toBe(false)
  })

  test("a migrated loop has no first message and holds no boundary back", () => {
    const migrated = { created_at: 10_000 }
    expect(LoopDecision.precedesLoop(migrated, boundary({ message: "msg_1" }))).toBe(false)
    expect(LoopDecision.precedesLoop(migrated, boundary({ message: undefined, endedAt: 1 }))).toBe(false)
  })
})

describe("LoopDecision boundary identity", () => {
  test("is the closing message, so two turns that ended one after the other are two boundaries", () => {
    const of = (message: string) => LoopDecision.identityOf(boundary({ message }))
    expect(of("msg_2")).toBe("msg_2")
    expect(of("msg_2")).not.toBe(of("msg_3"))
  })

  test("is told by when it ended for a turn that left no message, and never mistaken for a message", () => {
    const left = (endedAt: number) => LoopDecision.identityOf(boundary({ message: undefined, endedAt }))
    expect(left(5)).toBe(left(5))
    expect(left(5)).not.toBe(left(6))
    expect(left(5)).not.toBe(LoopDecision.identityOf(boundary({ message: "msg_5", endedAt: 5 })))
  })
})

describe("LoopDecision counted rounds", () => {
  test("the first analysis after a round counts, unless a human turn ended it", () => {
    expect(LoopDecision.followsCountedRound({ round: 2 }, 1, boundary())).toBe(true)
    expect(LoopDecision.followsCountedRound({ round: 2 }, 1, boundary({ humanTurn: true }))).toBe(false)
  })

  test("an analysis of a round already analysed does not count again", () => {
    expect(LoopDecision.followsCountedRound({ round: 2 }, 2, boundary())).toBe(false)
  })

  test("round 1 is the user's own turn and still counts", () => {
    expect(LoopDecision.followsCountedRound({ round: 1 }, 0, boundary({ humanTurn: true }))).toBe(true)
    expect(LoopDecision.followsCountedRound({ round: 2 }, 0, boundary({ humanTurn: true }))).toBe(false)
  })

  test("the streak grows without progress, resets with it, and stays when the round did not count", () => {
    expect(LoopDecision.streakAfter(1, true, false)).toBe(2)
    expect(LoopDecision.streakAfter(2, true, true)).toBe(0)
    expect(LoopDecision.streakAfter(2, false, false)).toBeUndefined()
  })
})

describe("LoopDecision waits", () => {
  test("a wake matches the registered source and one of its identities", () => {
    expect(LoopDecision.wakeMatches(wait(), { source: "background_job", ids: ["job_1"] })).toBe(true)
    expect(LoopDecision.wakeMatches(wait(), { source: "background_job", ids: ["job_2"] })).toBe(false)
    // A job reference is woken by either source; a watch reference by the watch source only.
    expect(LoopDecision.wakeMatches(wait(), { source: "watch_pr", ids: ["job_1"] })).toBe(true)
    const watch = wait({ source: "watch_pr", wait_id: "w1", ref: { domain: "pr_watch", id: "w1" } })
    expect(LoopDecision.wakeMatches(watch, { source: "background_job", ids: ["w1"] })).toBe(false)
    expect(LoopDecision.wakeMatches(watch, { source: "watch_pr", ids: ["x", "w1"] })).toBe(true)
    // Without a reference the source must match.
    const plain = wait({ source: "timer", wait_id: "t1", ref: undefined })
    expect(LoopDecision.wakeMatches(plain, { source: "timer", ids: ["t1"] })).toBe(true)
    expect(LoopDecision.wakeMatches(plain, { source: "hook", ids: ["t1"] })).toBe(false)
  })

  test("a wait ends by deadline, by its wakes, or with its object, and says which", () => {
    const alive = { alive: true } as const
    expect(LoopDecision.waitingOf(wait(), 999, alive)).toEqual({
      waiting: { alive: true, expired: false, reviewed: false },
      reason: "",
    })
    expect(LoopDecision.waitingOf(wait(), 1_000, alive).waiting.expired).toBe(true)
    expect(LoopDecision.waitingOf(wait(), 1_000, alive).reason).toBe("Waiting for background_job:job_1 timed out.")
    expect(LoopDecision.waitingOf(wait({ wakes: 1 }), 0, alive).reason).toContain("used up its wakes")
    const gone = LoopDecision.waitingOf(wait(), 0, { alive: false, reason: "The job was lost." })
    expect(gone).toEqual({ waiting: { alive: false, expired: true, reviewed: false }, reason: "The job was lost." })
    expect(LoopDecision.waitingOf(wait({ reviewed: true }), 0, alive).waiting.reviewed).toBe(true)
  })
})

describe("LoopDecision input", () => {
  const facts = (overrides: Partial<LoopDecision.Facts> = {}): LoopDecision.Facts => ({
    state: state({ declaration: { kind: "await" } }),
    boundary: boundary({ humanTurn: true, userRejected: true, hookStop: { message: "no" } }),
    humans: 2,
    runningWaitable: false,
    chain: LoopDecision.ZERO_CHAIN,
    masked: false,
    ...overrides,
  })

  test("carries the boundary's signals and the counts", () => {
    const input = LoopDecision.inputOf(facts())
    expect(input).toMatchObject({
      human_turn: true,
      user_rejected: true,
      hook_stop: { message: "no" },
      turn: { type: "completed" },
      declaration: "await",
      new_human_message: true,
      round: 1,
      max_rounds: 20,
      no_progress_streak: 0,
    })
  })

  test("after a resume carries only the analysis and the counts", () => {
    const input = LoopDecision.inputOf(facts({ masked: true, analysis: { type: "continue", advanced: true } }))
    expect(input.turn).toBeUndefined()
    expect(input.user_rejected).toBeUndefined()
    expect(input.hook_stop).toBeUndefined()
    expect(input.declaration).toBeUndefined()
    expect(input.human_turn).toBe(false)
    expect(input.analysis).toEqual({ type: "continue", advanced: true })
    expect(input.new_human_message).toBe(true)
  })

  test("reads the review round from the wait", () => {
    const reviewed = state({ wait: wait({ reviewed: true }) })
    expect(LoopDecision.inputOf(facts({ state: reviewed })).review_round).toBe(true)
    expect(LoopDecision.inputOf(facts()).review_round).toBe(false)
  })

  test("a user action or an archive has none of the boundary's signals", () => {
    const input = LoopDecision.actionInput(state(), { user_action: "stop" })
    expect(StopCondition.evaluate(input)).toEqual({ type: "stop", reason: "user_stopped" })
    expect(StopCondition.evaluate(LoopDecision.actionInput(state(), { archived: true }))).toEqual({
      type: "stop",
      reason: "session_archived",
    })
  })
})

describe("LoopDecision analysis", () => {
  test("maps every verdict, and refuses a verdict that stops on a message without naming it", () => {
    expect(LoopDecision.toAnalysis("continue", false, undefined)).toEqual({ type: "continue", advanced: false })
    expect(LoopDecision.toAnalysis("done", true, undefined)).toEqual({ type: "done" })
    expect(LoopDecision.toAnalysis("blocked", true, undefined)).toEqual({ type: "blocked" })
    expect(LoopDecision.toAnalysis("goal_changed", true, "m1")).toEqual({ type: "goal_changed", basis_message_id: "m1" })
    expect(LoopDecision.toAnalysis("user_stop", true, "m1")).toEqual({ type: "user_stop", basis_message_id: "m1" })
    expect(LoopDecision.toAnalysis("goal_changed", true, undefined)).toBeUndefined()
    expect(LoopDecision.toAnalysis("user_stop", true, undefined)).toBeUndefined()
  })

  test("describes what the agent declared, naming the object it waits for", () => {
    expect(LoopDecision.declarationOf(state())).toBeUndefined()
    expect(LoopDecision.declarationOf(state({ declaration: { kind: "done", evidence: "12 tests pass" } }))).toEqual({
      kind: "done",
      text: "12 tests pass",
    })
    expect(LoopDecision.declarationOf(state({ declaration: { kind: "blocked", reason: "needs a key" } }))).toEqual({
      kind: "blocked",
      text: "needs a key",
    })
    expect(LoopDecision.declarationOf(state({ declaration: { kind: "await" }, wait: wait({ payload: "CI run 7" }) }))).toEqual({
      kind: "await",
      text: "background_job:job_1 (CI run 7)",
    })
  })

  test("has no prior before the first analysis, and lists the earlier analyses after it", () => {
    expect(LoopDecision.priorOf(state(), [])).toBeUndefined()
    const analysed = state({
      origin: { ...state().origin, analysis: intent(), analysis_at: 1 },
      intent: intent(),
      progress: progress(),
    })
    const row = (verdict: string, reason: string, prompt: string | null): LoopState.AnalysisRow => ({
      loop_id: "loop",
      seq: 1,
      session_id: "ses",
      round: 1,
      boundary: "msg_1",
      verdict,
      reason,
      intent_revision: 1,
      change_summary: null,
      change_basis_message_id: null,
      prompt,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      elapsed_ms: 0,
      created_at: 0,
    })
    const prior = LoopDecision.priorOf(analysed, [row("continue", "one", "p1"), row("garbage", "x", null), row("blocked", "two", null)])
    expect(prior?.prompt).toBeUndefined()
    expect(prior?.recent).toEqual([
      { verdict: "continue", reason: "one" },
      { verdict: "blocked", reason: "two" },
    ])
    expect(LoopDecision.priorOf(analysed, [row("continue", "one", "p1")])?.prompt).toBe("p1")
  })
})
