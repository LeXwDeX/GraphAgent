// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import {
  type NodeStatus,
  type WorkflowStatus,
  getValidNextNodeStatuses,
  getValidNextWorkflowStatuses,
} from "@graphagent/core/dag/core/types"
import { checkTransition, TURN_TRANSITION_TABLE, type TransitionTable } from "@graphagent/core/lifecycle/transition"
import { VOCABULARY, valuesOf } from "@graphagent/core/lifecycle/vocabulary"

const isWorkflowStatus = (value: string): value is WorkflowStatus => valuesOf("workflow").includes(value)
const isNodeStatus = (value: string): value is NodeStatus => valuesOf("node").includes(value)

// One-line adapters over the DAG state machine prove its tables are reusable
// as TransitionTable sources. They stay in the test: production code must not
// import the DAG rules into the lifecycle vocabulary (#1069 P1).
const dagWorkflowTable: TransitionTable = {
  domain: "workflow",
  next: (from) => (from === null ? ["pending"] : isWorkflowStatus(from) ? getValidNextWorkflowStatuses(from) : []),
}

const dagNodeTable: TransitionTable = {
  domain: "node",
  next: (from) => (from === null ? ["pending"] : isNodeStatus(from) ? getValidNextNodeStatuses(from) : []),
}

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
