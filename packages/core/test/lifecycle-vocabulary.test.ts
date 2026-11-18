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
// `queued` is the one lifecycle value the registry does not have: it is the wait of a task job's child run (#1407).
expectTypeOf<(typeof VOCABULARY.job.values)[number]>().toEqualTypeOf<BackgroundJob.Status | "queued">()
expectTypeOf<(typeof VOCABULARY.session.values)[number]>().toEqualTypeOf<SessionStatusEvent.Info["type"]>()
expectTypeOf<(typeof VOCABULARY.goal.values)[number]>().toEqualTypeOf<Schema.Schema.Type<typeof GoalStatus>>()

const sorted = (values: Iterable<string>) => [...values].sort()

describe("lifecycle vocabulary", () => {
  it("covers every wire domain exactly once", () => {
    expect(sorted(Object.keys(VOCABULARY))).toEqual(sorted(DOMAINS))
    expect(DOMAINS).toHaveLength(13)
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
    expect(VOCABULARY.job.values).toEqual(["queued", "running", "settling", "completed", "error", "cancelled"])
    expect(VOCABULARY.goal.values).toEqual(["active", "waiting", "paused", "done"])
    expect(VOCABULARY.pr_watch.values).toEqual([
      "watching",
      "delivering",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ])
    expect(VOCABULARY.reminder.values).toEqual(["scheduled", "due", "delivered", "cancelled"])
  })

  it("projects a queued job onto the pending phase and keeps it live", () => {
    // The wait for a slot has not started the work: pending, like a node that is queued (#1407).
    expect(phaseOf("job", "queued")).toBe("pending")
    expect(phaseOf("job", "running")).toBe("running")
    expect(VOCABULARY.job.terminal).toEqual(["completed", "error", "cancelled"])
    expect(isTerminalValue("job", "queued")).toBe(false)
    expect(isSettledValue("job", "queued")).toBe(false)
  })

  it("projects the reminder values onto the phases the Issue names", () => {
    // pending(scheduled) -> settling(due) -> succeeded(delivered) | cancelled (#1072).
    expect(phaseOf("reminder", "scheduled")).toBe("pending")
    expect(phaseOf("reminder", "due")).toBe("settling")
    expect(phaseOf("reminder", "delivered")).toBe("succeeded")
    expect(phaseOf("reminder", "cancelled")).toBe("cancelled")
    expect(VOCABULARY.reminder.terminal).toEqual(["delivered", "cancelled"])
    // Only a delivered reminder is settled: a cancelled one never reached the session.
    expect(isSettledValue("reminder", "delivered")).toBe(true)
    expect(isSettledValue("reminder", "cancelled")).toBe(false)
    expect(isTerminalValue("reminder", "due")).toBe(false)
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
    expect(authorityOf("job")).toBe("mixed")
    expect(authorityOf("goal")).toBe("durable")
    expect(authorityOf("workflow")).toBe("durable")
    expect(authorityOf("node")).toBe("durable")
    expect(authorityOf("mailbox")).toBe("durable")
    expect(authorityOf("inbox")).toBe("live")
    expect(authorityOf("hook")).toBe("mixed")
    expect(authorityOf("tool")).toBe("durable")
    expect(authorityOf("turn")).toBe("durable")
    expect(authorityOf("cancellation")).toBe("live")
    expect(authorityOf("pr_watch")).toBe("mixed")
    // The clock keeps nothing but its next wake-up time: the row is the record.
    expect(authorityOf("reminder")).toBe("durable")
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
