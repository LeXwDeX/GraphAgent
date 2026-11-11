// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "bun:test"
import { BackgroundJob } from "@graphagent/core/background-job"
import { type NodeStatus, type WorkflowStatus } from "@graphagent/core/dag/core/types"
import {
  authorityOf,
  isSettledOutcome,
  isSettledValue,
  isTerminalValue,
  phaseOf,
  turnOutcomePhase,
  VOCABULARY,
} from "@graphagent/core/lifecycle/vocabulary"
import { DOMAINS, PHASES } from "@graphagent/schema/lifecycle-status"
import {
  NODE_TERMINAL_STATUS_VALUES,
  NODE_STATUS_VALUES,
  WORKFLOW_TERMINAL_STATUS_VALUES,
  WORKFLOW_STATUS_VALUES,
} from "@graphagent/schema/dag-status"
import { GoalStatus } from "@graphagent/schema/session-goal"
import { SessionStatusEvent } from "@graphagent/schema/session-status-event"
import { Schema } from "effect"

// Bidirectional type check: the vocabulary values and the owning union are identical.
expectTypeOf<(typeof VOCABULARY.workflow.values)[number]>().toEqualTypeOf<WorkflowStatus>()
expectTypeOf<(typeof VOCABULARY.node.values)[number]>().toEqualTypeOf<NodeStatus>()
expectTypeOf<(typeof VOCABULARY.job.values)[number]>().toEqualTypeOf<BackgroundJob.Status>()
expectTypeOf<(typeof VOCABULARY.session.values)[number]>().toEqualTypeOf<SessionStatusEvent.Info["type"]>()
expectTypeOf<(typeof VOCABULARY.goal.values)[number]>().toEqualTypeOf<Schema.Schema.Type<typeof GoalStatus>>()

const sorted = (values: Iterable<string>) => [...values].sort()

describe("lifecycle vocabulary", () => {
  it("covers every wire domain exactly once", () => {
    expect(sorted(Object.keys(VOCABULARY))).toEqual(sorted(DOMAINS))
    expect(DOMAINS).toHaveLength(11)
  })

  it("maps every value to a phase except turn.ended, which the outcome decides", () => {
    for (const domain of DOMAINS) {
      for (const value of VOCABULARY[domain].values) {
        if (domain === "turn" && value === "ended") {
          expect(phaseOf(domain, value)).toBeUndefined()
          continue
        }
        expect(phaseOf(domain, value), `${domain}/${value}`).toBeDefined()
      }
    }
  })

  it("derives every phase from the shared wire enum", () => {
    for (const domain of DOMAINS) {
      for (const value of VOCABULARY[domain].values) {
        const phase = phaseOf(domain, value)
        if (phase !== undefined) expect(PHASES).toContain(phase)
      }
      for (const outcome of Object.values(VOCABULARY.turn.outcomes ?? {})) expect(PHASES).toContain(outcome.phase)
    }
  })

  it("keeps DAG values byte-identical to the shared dag-status source", () => {
    expect(VOCABULARY.workflow.values).toEqual(WORKFLOW_STATUS_VALUES)
    expect(VOCABULARY.node.values).toEqual(NODE_STATUS_VALUES)
    expect(VOCABULARY.workflow.terminal).toEqual(WORKFLOW_TERMINAL_STATUS_VALUES)
    expect(VOCABULARY.node.terminal).toEqual(NODE_TERMINAL_STATUS_VALUES)
  })

  it("keeps the other domain values identical to their owning vocabularies", () => {
    expect(VOCABULARY.session.values).toEqual(["idle", "retry", "busy"])
    expect(VOCABULARY.job.values).toEqual(["running", "completed", "error", "cancelled"])
    expect(VOCABULARY.goal.values).toEqual(["active", "waiting", "paused", "done"])
  })

  it("splits terminal from settled: settled means terminal and successfully quiet", () => {
    expect(isTerminalValue("node", "failed")).toBe(true)
    expect(isSettledValue("node", "failed")).toBe(false)
    expect(isSettledValue("node", "skipped")).toBe(true)
    expect(isSettledValue("workflow", "cancelled")).toBe(false)
    expect(isSettledValue("session", "idle")).toBe(false)
    expect(isTerminalValue("turn", "ended")).toBe(true)
    expect(isSettledValue("turn", "ended")).toBe(false)
  })

  it("keeps the source authority per domain", () => {
    expect(authorityOf("session")).toBe("live")
    expect(authorityOf("job")).toBe("live")
    expect(authorityOf("goal")).toBe("durable")
    expect(authorityOf("workflow")).toBe("durable")
    expect(authorityOf("node")).toBe("durable")
    expect(authorityOf("mailbox")).toBe("durable")
    expect(authorityOf("inbox")).toBe("live")
    expect(authorityOf("hook")).toBe("mixed")
    expect(authorityOf("tool")).toBe("durable")
    expect(authorityOf("turn")).toBe("durable")
    expect(authorityOf("cancellation")).toBe("live")
  })

  it("maps the ten turn outcomes and settles only completed", () => {
    expect(Object.keys(VOCABULARY.turn.outcomes ?? {})).toHaveLength(10)
    expect(turnOutcomePhase("completed")).toBe("succeeded")
    expect(turnOutcomePhase("blocked")).toBe("skipped")
    expect(turnOutcomePhase("cancelled")).toBe("cancelled")
    expect(turnOutcomePhase("interrupted")).toBe("cancelled")
    for (const outcome of [
      "length",
      "tool_budget_exhausted",
      "structured_missing",
      "content_filter",
      "error",
      "context_overflow",
    ])
      expect(turnOutcomePhase(outcome), outcome).toBe("failed")
    expect(isSettledOutcome("completed")).toBe(true)
    for (const outcome of [
      "length",
      "tool_budget_exhausted",
      "structured_missing",
      "content_filter",
      "error",
      "cancelled",
      "context_overflow",
      "blocked",
      "interrupted",
    ])
      expect(isSettledOutcome(outcome), outcome).toBe(false)
  })

  it("returns undefined for values outside a domain", () => {
    expect(phaseOf("goal", "running")).toBeUndefined()
    expect(turnOutcomePhase("unknown")).toBeUndefined()
    expect(isSettledOutcome("unknown")).toBe(false)
  })
})
