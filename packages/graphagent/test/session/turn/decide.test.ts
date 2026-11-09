// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { NamedError } from "@graphagent/core/util/error"
import { SessionV1 } from "@graphagent/core/v1/session"
import { AUTO_COMPACTION_LIMIT, Decide } from "@/session/turn/decide"
import { State, type TurnState } from "@/session/turn/state"

/**
 * Pure decision-layer tests for Issue #1019 PR7.
 *
 * These tests construct no Effect Layer, no InstanceState, and no runtime:
 * every input is a plain object. Each row of turn-state-migration.md maps to at
 * least one test below (see script/turn-flag-migration-table.ts for the map).
 */

const aborted = () => new SessionV1.AbortedError({ message: "cancelled by user" }).toObject()
const contentFilter = () => new SessionV1.ContentFilterError({ message: "blocked by provider" }).toObject()
const structuredMissing = () => new SessionV1.StructuredOutputError({ message: "missing", retries: 0 }).toObject()
const outputLength = () => new SessionV1.OutputLengthError({}).toObject()
const apiError = () =>
  new SessionV1.APIError({ message: "rate limited", isRetryable: true, statusCode: 429 }).toObject()
const unknownError = () => new NamedError.Unknown({ message: "boom" }).toObject()

function state(overrides: Partial<TurnState> = {}): TurnState {
  const base = State.initial({ stopCap: 3 })
  return {
    ...base,
    ...overrides,
    stop: { ...base.stop, ...overrides.stop },
  }
}

function signals(overrides: Partial<Decide.Signals> = {}): Decide.Signals {
  return {
    stopHook: "not_run",
    stepInputPending: false,
    stepInputChecked: true,
    ownerDefersStop: false,
    stopPolicy: { event: "Stop", enabled: true },
    budgetExhausted: false,
    pendingLocalTools: false,
    assistantFinished: true,
    userBeforeAssistant: true,
    assistantFinish: "stop",
    ...overrides,
  }
}

const ran = (blocked: boolean, preventContinuation = false): Decide.HookStopDecision => ({
  blocked,
  preventContinuation,
})

describe("TurnState reducers", () => {
  test("State.incrementStep starts at zero and advances", () => {
    let current = State.initial({ stopCap: 3 })
    expect(current.step).toBe(0)
    current = State.incrementStep(current)
    expect(current.step).toBe(1)
    expect(State.incrementStep(current).step).toBe(2)
  })

  test("State.setStructured/clearStructured", () => {
    let current = State.initial({ stopCap: 3 })
    current = State.setStructured(current, { ok: true })
    expect(current.structured).toEqual({ ok: true })
    expect(State.clearStructured(current).structured).toBeUndefined()
  })

  test("State.afterAttempt records the error only on a break", () => {
    let current = State.initial({ stopCap: 3 })
    current = State.afterAttempt(current, { broke: true, error: contentFilter() })
    expect(current.stopped).toBe(true)
    expect(current.error).toEqual(contentFilter())
    const continued = State.afterAttempt(current, { broke: false, error: undefined })
    expect(continued.stopped).toBe(false)
    expect(continued.error).toEqual(contentFilter())
  })

  test("State.markStopped and State.clearStopped", () => {
    const stopped = State.markStopped(State.initial({ stopCap: 3 }))
    expect(stopped.stopped).toBe(true)
    expect(State.clearStopped(stopped).stopped).toBe(false)
  })

  test("State.blockAgentInput is idempotent", () => {
    const blocked = State.blockAgentInput(State.initial({ stopCap: 3 }))
    expect(blocked.agentInput).toBe("blocked")
    expect(State.blockAgentInput(blocked)).toBe(blocked)
  })

  test("State.clearBoundaryApproval only clears a pending approval", () => {
    const approved = State.continueFromQueuedInput(State.initial({ stopCap: 3 }))
    expect(approved.agentInput).toBe("boundary_approved")
    expect(State.clearBoundaryApproval(approved).agentInput).toBe("open")
    const open = State.initial({ stopCap: 3 })
    expect(State.clearBoundaryApproval(open)).toBe(open)
  })

  test("State.continueFromStopBlock arms stop_hook_active and the continuation", () => {
    const continued = State.continueFromStopBlock(State.initial({ stopCap: 3 }))
    expect(continued.continuing).toBe("stop_block")
    expect(continued.stop.active).toBe(true)
    expect(continued.stop.continuations).toBe(1)
    expect(State.resetStopContinuations(continued).stop.continuations).toBe(0)
  })

  test("State.continueFromQueuedInput approves the boundary and clears stopped", () => {
    const continued = State.continueFromQueuedInput(State.markStopped(State.initial({ stopCap: 3 })))
    expect(continued.agentInput).toBe("boundary_approved")
    expect(continued.stopped).toBe(false)
  })

  test("State.beginStep consumes the one-shot continuation", () => {
    const continued = State.continueFromStopBlock(State.markStopped(State.initial({ stopCap: 3 })))
    const stepped = State.beginStep(continued)
    expect(stepped.continuing).toBeUndefined()
    expect(stepped.stopped).toBe(false)
  })

  test("State.recordAutoCompaction and State.resetAutoCompactions", () => {
    let current = State.initial({ stopCap: 3 })
    current = State.recordAutoCompaction(State.recordAutoCompaction(current))
    expect(current.compactions).toBe(2)
    expect(State.resetAutoCompactions(current).compactions).toBe(0)
    const zero = State.initial({ stopCap: 3 })
    expect(State.resetAutoCompactions(zero)).toBe(zero)
  })

  test("State.initial injects the Stop continuation cap", () => {
    expect(State.initial({ stopCap: 8 }).stop.cap).toBe(8)
    expect(State.initial({ stopCap: 1 }).stop.cap).toBe(1)
  })
})

describe("decide: completion gate", () => {
  test("an ongoing turn steps without running Stop hooks", () => {
    const transition = Decide.decide(state(), signals({ assistantFinish: "tool-calls", assistantFinished: false }))
    expect(transition).toEqual({ kind: "step" })
  })

  test("pending local tools keep the turn open", () => {
    expect(Decide.decide(state(), signals({ pendingLocalTools: true }))).toEqual({ kind: "step" })
  })

  test("a user message after the assistant keeps the turn open", () => {
    expect(Decide.decide(state(), signals({ userBeforeAssistant: false }))).toEqual({ kind: "step" })
  })

  test("a stopped turn is a completion candidate even without a finish reason", () => {
    const transition = Decide.decide(
      State.markStopped(state()),
      signals({ assistantFinished: false, assistantFinish: undefined }),
    )
    expect(transition).toEqual({ kind: "run_stop_hooks", event: "Stop" })
  })
})

describe("decide: Stop hooks", () => {
  test("Stop not run requests RunStopHooks", () => {
    expect(Decide.decide(state(), signals())).toEqual({ kind: "run_stop_hooks", event: "Stop" })
  })

  test("RunStopHooks carries the policy event", () => {
    expect(Decide.decide(state(), signals({ stopPolicy: { event: "SubagentStop", enabled: true } }))).toEqual({
      kind: "run_stop_hooks",
      event: "SubagentStop",
    })
    expect(Decide.decide(state(), signals({ stopPolicy: { event: "StopFailure", enabled: true } }))).toEqual({
      kind: "run_stop_hooks",
      event: "StopFailure",
    })
  })

  test("owner defers Stop hooks", () => {
    const transition = Decide.decide(
      state(),
      signals({ ownerDefersStop: true, stepInputChecked: true, stepInputPending: false }),
    )
    expect(transition).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("disabled Stop hooks fall through to the post-hook decision", () => {
    const transition = Decide.decide(state(), signals({ stopPolicy: { event: "Stop", enabled: false } }))
    expect(transition).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("Stop block within the cap continues", () => {
    const current = state()
    const transition = Decide.decide(current, signals({ stopHook: ran(true) }))
    expect(transition).toEqual({ kind: "continue", source: "stop_block" })
    const applied = State.continueFromStopBlock(current)
    expect(applied.stop.active).toBe(true)
    expect(applied.stop.continuations).toBe(1)
    expect(applied.continuing).toBe("stop_block")
  })

  test("Stop block at the cap exits", () => {
    const transition = Decide.decide(
      state({ stop: { active: false, continuations: 3, cap: 3 } }),
      signals({ stopHook: ran(true) }),
    )
    expect(transition).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("injected cap is respected", () => {
    const capped = state({ stop: { active: false, continuations: 0, cap: 1 } })
    expect(Decide.decide(capped, signals({ stopHook: ran(true) }))).toEqual({
      kind: "continue",
      source: "stop_block",
    })
    // The granted continuation runs one step; the next completed decision is
    // evaluated with the incremented counter at the injected cap.
    const once = State.continueFromStopBlock(capped)
    expect(Decide.decide(once, signals())).toEqual({ kind: "step" })
    const exhausted = state({ stop: { active: true, continuations: 1, cap: 1 } })
    expect(Decide.decide(exhausted, signals({ stopHook: ran(true) }))).toEqual({
      kind: "finish",
      outcome: { type: "completed" },
    })
  })

  test("continue:false prevents a Stop continuation", () => {
    const transition = Decide.decide(state(), signals({ stopHook: ran(true, true) }))
    expect(transition).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("a granted continuation produces one Step and is cleared", () => {
    const continued = State.continueFromStopBlock(State.markStopped(state()))
    expect(Decide.decide(continued, signals())).toEqual({ kind: "step" })
    expect(State.beginStep(continued).continuing).toBeUndefined()
  })

  test("a granted continuation is not consumed for blocked input", () => {
    const continued = State.blockAgentInput(State.continueFromStopBlock(State.markStopped(state())))
    expect(Decide.decide(continued, signals())).toEqual({ kind: "run_stop_hooks", event: "Stop" })
    expect(Decide.decide(continued, signals({ stopHook: ran(true) }))).toEqual({
      kind: "finish",
      outcome: { type: "completed" },
    })
  })
})

describe("decide: queued input", () => {
  test("queued input continues only after an authoritative check", () => {
    const unchecked = signals({ stopHook: ran(false), stepInputChecked: false, stepInputPending: true })
    expect(Decide.decide(state(), unchecked)).toEqual({ kind: "check_step_input" })
    const checked = signals({ stopHook: ran(false), stepInputChecked: true, stepInputPending: true })
    expect(Decide.decide(state(), checked)).toEqual({ kind: "continue", source: "queued_input" })
    const empty = signals({ stopHook: ran(false), stepInputChecked: true, stepInputPending: false })
    expect(Decide.decide(state(), empty)).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("a blocked Stop hook outranks queued input", () => {
    const transition = Decide.decide(
      state(),
      signals({ stopHook: ran(true), stepInputChecked: true, stepInputPending: true }),
    )
    expect(transition).toEqual({ kind: "continue", source: "stop_block" })
  })

  test("preventContinuation skips queued input", () => {
    const transition = Decide.decide(
      state(),
      signals({ stopHook: ran(false, true), stepInputChecked: true, stepInputPending: true }),
    )
    expect(transition).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("shouldFreezeAgentInput allows boundary_approved", () => {
    const open = state()
    expect(Decide.shouldFreezeAgentInput(open, false)).toBe(true)
    expect(Decide.shouldFreezeAgentInput(open, true)).toBe(false)
    const approved = State.continueFromQueuedInput(open)
    expect(Decide.shouldFreezeAgentInput(approved, true)).toBe(true)
    const continuing = State.continueFromStopBlock(State.markStopped(open))
    expect(Decide.shouldFreezeAgentInput(continuing, true)).toBe(true)
    expect(Decide.shouldFreezeAgentInput(State.blockAgentInput(open), false)).toBe(false)
  })
})

describe("decide: agent input ownership", () => {
  test("blocked agent input runs Stop hooks but cannot continue", () => {
    const blocked = State.blockAgentInput(state())
    expect(Decide.decide(blocked, signals())).toEqual({ kind: "run_stop_hooks", event: "Stop" })
    expect(
      Decide.decide(blocked, signals({ stopHook: ran(false), stepInputChecked: true, stepInputPending: true })),
    ).toEqual({ kind: "finish", outcome: { type: "completed" } })
  })

  test("blocked agent input never continues", () => {
    expect(Decide.decide(State.blockAgentInput(state()), signals({ stopHook: ran(true) }))).toEqual({
      kind: "finish",
      outcome: { type: "completed" },
    })
  })
})

describe("decide: outcomes", () => {
  test("normal completion outcome", () => {
    expect(Decide.decide(state(), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "completed" },
    })
  })

  test("structured missing -> structured_missing outcome", () => {
    expect(Decide.decide(state({ error: structuredMissing() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "structured_missing" },
    })
  })

  test("content-filter outcome", () => {
    expect(Decide.decide(state({ error: contentFilter() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "content_filter" },
    })
  })

  test("budget exhausted outcome", () => {
    expect(
      Decide.decide(state(), signals({ stopHook: ran(false), stepInputChecked: true, budgetExhausted: true })),
    ).toEqual({ kind: "finish", outcome: { type: "tool_budget_exhausted" } })
  })

  test("length outcome", () => {
    expect(
      Decide.decide(state(), signals({ stopHook: ran(false), assistantFinish: "length", stepInputChecked: true })),
    ).toEqual({ kind: "finish", outcome: { type: "length" } })
    expect(Decide.decide(state({ error: outputLength() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "length" },
    })
  })

  test("error outcome", () => {
    expect(Decide.decide(state({ error: apiError() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "error", code: "APIError", retryable: true },
    })
    expect(Decide.decide(state({ error: unknownError() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "error", code: "UnknownError", retryable: false },
    })
  })

  test("a turn error blocks Stop continuation", () => {
    expect(Decide.decide(state({ error: contentFilter() }), signals({ stopHook: ran(true) }))).toEqual({
      kind: "finish",
      outcome: { type: "content_filter" },
    })
  })

  test("cancelled outcome", () => {
    expect(Decide.decide(state({ error: aborted() }), signals({ stopHook: ran(false) }))).toEqual({
      kind: "finish",
      outcome: { type: "cancelled", reason: "cancelled by user" },
    })
  })
})

describe("decideOverflow", () => {
  test("first automatic compaction is allowed", () => {
    const transition = Decide.decideOverflow(state(), { overflow: true })
    expect(transition).toEqual({ kind: "compact" })
    expect(State.recordAutoCompaction(state()).compactions).toBe(1)
  })

  test("fourth automatic compaction is refused", () => {
    const third = state({ compactions: AUTO_COMPACTION_LIMIT })
    expect(Decide.decideOverflow(third, { overflow: true })).toEqual({
      kind: "finish",
      outcome: { type: "context_overflow" },
    })
  })

  test("no overflow keeps the step counter reset", () => {
    expect(Decide.decideOverflow(state({ compactions: 2 }), { overflow: false })).toEqual({ kind: "step" })
    expect(State.resetAutoCompactions(state({ compactions: 2 })).compactions).toBe(0)
  })
})

describe("purity", () => {
  test("decide does not mutate its inputs", () => {
    const current = state({ stop: { active: false, continuations: 1, cap: 3 } })
    const input = signals({ stopHook: ran(true) })
    const stateBefore = JSON.stringify(current)
    const signalsBefore = JSON.stringify(input)
    Decide.decide(current, input)
    expect(JSON.stringify(current)).toBe(stateBefore)
    expect(JSON.stringify(input)).toBe(signalsBefore)
  })
})
