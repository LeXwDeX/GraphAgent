// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { NODE_TRANSITION_TABLE, WORKFLOW_TRANSITION_TABLE } from "@graphagent/core/lifecycle/dag"
import {
  checkTransition,
  JOB_TRANSITION_TABLE,
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
