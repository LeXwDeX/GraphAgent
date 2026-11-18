// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { NODE_TRANSITION_TABLE, WORKFLOW_TRANSITION_TABLE } from "@graphagent/core/lifecycle/dag"
import {
  checkTransition,
  GOAL_TRANSITION_TABLE,
  JOB_TRANSITION_TABLE,
  PR_WATCH_TRANSITION_TABLE,
  REMINDER_TRANSITION_TABLE,
  TURN_TRANSITION_TABLE,
  type TransitionTable,
} from "@graphagent/core/lifecycle/transition"
import { VOCABULARY } from "@graphagent/core/lifecycle/vocabulary"

// The production bridge (#1069 P8) is the only adapter over the DAG state
// machine; asserts below pin that it exposes exactly the DAG's own edges.
const dagWorkflowTable: TransitionTable = WORKFLOW_TRANSITION_TABLE
const dagNodeTable: TransitionTable = NODE_TRANSITION_TABLE

describe("turn transitions", () => {
  it("allows creation into running", () => {
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: null, to: "running" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
  })

  it("allows running -> ended only with an explicit phase", () => {
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "running", to: "ended", phase: "succeeded" })).toEqual({
      kind: "allowed",
      phase: "succeeded",
    })
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "running", to: "ended" })).toEqual({
      kind: "unknown-to",
      value: "ended",
    })
  })

  it("reports a repeated value as duplicate before checking the table", () => {
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "running", to: "running" })).toEqual({
      kind: "duplicate",
    })
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "ended", to: "ended" })).toEqual({
      kind: "duplicate",
    })
  })

  it("rejects a disallowed target and lists what the table admits", () => {
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "running", to: "pending" })).toEqual({
      kind: "invalid",
      allowed: ["ended"],
    })
  })

  it("treats a value outside the domain vocabulary as unknown from", () => {
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "paused", to: "ended", phase: "failed" })).toEqual({
      kind: "unknown-from",
      value: "paused",
    })
  })

  it("treats the terminal turn value as admitting nothing", () => {
    expect(TURN_TRANSITION_TABLE.next("ended")).toEqual([])
    expect(checkTransition(TURN_TRANSITION_TABLE, { expect: "ended", to: "running" })).toEqual({
      kind: "invalid",
      allowed: [],
    })
  })
})

describe("DAG tables as lifecycle tables", () => {
  it("admits the DAG workflow transitions and derives their phases", () => {
    expect(checkTransition(dagWorkflowTable, { expect: null, to: "pending" })).toEqual({
      kind: "allowed",
      phase: "pending",
    })
    expect(checkTransition(dagWorkflowTable, { expect: "running", to: "paused" })).toEqual({
      kind: "allowed",
      phase: "paused",
    })
    expect(checkTransition(dagWorkflowTable, { expect: "stepping", to: "completed" })).toEqual({
      kind: "allowed",
      phase: "succeeded",
    })
  })

  it("admits the DAG node transitions and maps aborted to cancelled", () => {
    expect(checkTransition(dagNodeTable, { expect: "pending", to: "queued" })).toEqual({
      kind: "allowed",
      phase: "pending",
    })
    expect(checkTransition(dagNodeTable, { expect: "running", to: "aborted" })).toEqual({
      kind: "allowed",
      phase: "cancelled",
    })
  })

  it("keeps every terminal DAG value consistent with an empty next()", () => {
    for (const value of VOCABULARY.workflow.terminal)
      expect(dagWorkflowTable.next(value), `workflow ${value}`).toEqual([])
    for (const value of VOCABULARY.node.terminal) expect(dagNodeTable.next(value), `node ${value}`).toEqual([])
  })

  it("rejects transitions out of a terminal DAG value", () => {
    expect(checkTransition(dagWorkflowTable, { expect: "completed", to: "running" })).toEqual({
      kind: "invalid",
      allowed: [],
    })
    expect(checkTransition(dagNodeTable, { expect: "skipped", to: "running" })).toEqual({
      kind: "invalid",
      allowed: [],
    })
  })
})

describe("goal transitions", () => {
  it("admits creation, waiting, pause and resume", () => {
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: null, to: "active" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "active", to: "waiting" })).toEqual({
      kind: "allowed",
      phase: "waiting",
    })
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "waiting", to: "active" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "active", to: "paused" })).toEqual({
      kind: "allowed",
      phase: "paused",
    })
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "waiting", to: "paused" })).toEqual({
      kind: "allowed",
      phase: "paused",
    })
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "paused", to: "active" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
  })

  it("keeps done out of the live table and terminal", () => {
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "active", to: "done" })).toEqual({
      kind: "invalid",
      allowed: ["waiting", "paused"],
    })
    expect(GOAL_TRANSITION_TABLE.next("done")).toEqual([])
  })

  it("reports a repeated status as duplicate", () => {
    expect(checkTransition(GOAL_TRANSITION_TABLE, { expect: "active", to: "active" })).toEqual({ kind: "duplicate" })
  })
})

describe("pr_watch transitions", () => {
  it("creates into watching and moves through delivering to a delivery result", () => {
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: null, to: "watching" })).toEqual({
      kind: "allowed",
      phase: "waiting",
    })
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: "watching", to: "delivering" })).toEqual({
      kind: "allowed",
      phase: "settling",
    })
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: "delivering", to: "succeeded" })).toEqual({
      kind: "allowed",
      phase: "succeeded",
    })
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: "delivering", to: "failed" })).toEqual({
      kind: "allowed",
      phase: "failed",
    })
  })

  it("lets every live value stop as cancelled or expired", () => {
    for (const from of ["watching", "delivering"])
      for (const to of ["cancelled", "expired"])
        expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: from, to }), `${from} -> ${to}`).toMatchObject({
          kind: "allowed",
        })
  })

  it("does not skip delivery and leaves terminal values empty", () => {
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: "watching", to: "succeeded" })).toEqual({
      kind: "invalid",
      allowed: ["delivering", "cancelled", "expired"],
    })
    for (const terminal of VOCABULARY.pr_watch.terminal)
      expect(PR_WATCH_TRANSITION_TABLE.next(terminal), terminal).toEqual([])
  })

  it("reports a repeated status as duplicate", () => {
    expect(checkTransition(PR_WATCH_TRANSITION_TABLE, { expect: "watching", to: "watching" })).toEqual({
      kind: "duplicate",
    })
  })
})

describe("reminder transitions", () => {
  it("creates into scheduled and walks pending -> settling -> succeeded", () => {
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: null, to: "scheduled" })).toEqual({
      kind: "allowed",
      phase: "pending",
    })
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: "scheduled", to: "due" })).toEqual({
      kind: "allowed",
      phase: "settling",
    })
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: "due", to: "delivered" })).toEqual({
      kind: "allowed",
      phase: "succeeded",
    })
  })

  it("lets a repeating reminder return to scheduled after delivery", () => {
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: "due", to: "scheduled" })).toEqual({
      kind: "allowed",
      phase: "pending",
    })
  })

  it("lets either live value be cancelled", () => {
    for (const from of ["scheduled", "due"])
      expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: from, to: "cancelled" }), from).toEqual({
        kind: "allowed",
        phase: "cancelled",
      })
  })

  it("does not deliver a reminder that never came due and leaves terminal values empty", () => {
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: "scheduled", to: "delivered" })).toEqual({
      kind: "invalid",
      allowed: ["due", "cancelled"],
    })
    for (const terminal of VOCABULARY.reminder.terminal)
      expect(REMINDER_TRANSITION_TABLE.next(terminal), terminal).toEqual([])
  })

  it("reports a repeated status as duplicate", () => {
    expect(checkTransition(REMINDER_TRANSITION_TABLE, { expect: "due", to: "due" })).toEqual({ kind: "duplicate" })
  })
})

describe("job transitions", () => {
  it("admits creation and the optional settling phase", () => {
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: null, to: "running" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "running", to: "settling" })).toEqual({
      kind: "allowed",
      phase: "settling",
    })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "running", to: "completed" })).toEqual({
      kind: "allowed",
      phase: "succeeded",
    })
  })

  it("starts a job queued and moves it to running once its run holds a slot (#1407)", () => {
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: null, to: "queued" })).toEqual({
      kind: "allowed",
      phase: "pending",
    })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "queued", to: "running" })).toEqual({
      kind: "allowed",
      phase: "running",
    })
    // A queued job can end before it ever ran, and never goes back to the queue.
    for (const to of ["completed", "error", "cancelled"])
      expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "queued", to })).toMatchObject({ kind: "allowed" })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "running", to: "queued" })).toEqual({
      kind: "invalid",
      allowed: ["settling", "completed", "error", "cancelled"],
    })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "queued", to: "queued" })).toEqual({ kind: "duplicate" })
  })

  it("settles only into terminal states and leaves terminal values empty", () => {
    for (const to of ["completed", "error", "cancelled"])
      expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "settling", to })).toMatchObject({ kind: "allowed" })
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "settling", to: "running" })).toEqual({
      kind: "invalid",
      allowed: ["completed", "error", "cancelled"],
    })
    for (const terminal of VOCABULARY.job.terminal) expect(JOB_TRANSITION_TABLE.next(terminal)).toEqual([])
  })

  it("reports a repeated status as duplicate", () => {
    expect(checkTransition(JOB_TRANSITION_TABLE, { expect: "settling", to: "settling" })).toEqual({
      kind: "duplicate",
    })
  })
})
