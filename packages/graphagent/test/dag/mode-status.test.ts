// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DagModeStatus } from "@/dag/mode-status"

describe("DAG mode availability", () => {
  const facts = {
    workflowToolDisabled: false,
    startDenied: false,
    modelToolCalling: true,
    hasWorker: true,
  } as const

  test("reports available only when every condition passes", () => {
    expect(DagModeStatus.unavailableReason(facts)).toBeNull()
  })

  test("reports workflow_tool_disabled before the deny rule it produces", () => {
    expect(DagModeStatus.unavailableReason({ ...facts, workflowToolDisabled: true })).toBe("workflow_tool_disabled")
    // tools.workflow=false is converted into a deny rule, so both flags are set.
    expect(DagModeStatus.unavailableReason({ ...facts, workflowToolDisabled: true, startDenied: true })).toBe(
      "workflow_tool_disabled",
    )
  })

  test("reports start_denied when the workflow tool is denied", () => {
    expect(DagModeStatus.unavailableReason({ ...facts, startDenied: true })).toBe("start_denied")
    expect(DagModeStatus.unavailableReason({ ...facts, startDenied: true, modelToolCalling: false })).toBe(
      "start_denied",
    )
  })

  test("reports model_no_tool_calling when the resolved model cannot call tools", () => {
    expect(DagModeStatus.unavailableReason({ ...facts, modelToolCalling: false })).toBe("model_no_tool_calling")
  })

  test("reports no_worker when no model resolves or no worker agent exists", () => {
    expect(DagModeStatus.unavailableReason({ ...facts, modelToolCalling: undefined })).toBe("no_worker")
    expect(DagModeStatus.unavailableReason({ ...facts, hasWorker: false })).toBe("no_worker")
  })
})

describe("DAG mode budget accounting", () => {
  test("counts input, cache write, output and reasoning, and reports cache read separately", () => {
    const usage = DagModeStatus.sumUsage([
      { input: 100, output: 20, reasoning: 3, cache: { read: 40, write: 5 } },
      { input: 1, output: 2, reasoning: 0, cache: { read: 7, write: 0 } },
    ])
    expect(usage).toEqual({
      used: 100 + 5 + 20 + 3 + 1 + 0 + 2 + 0,
      usedCacheRead: 47,
    })
  })

  test("an empty ledger is all zero", () => {
    expect(DagModeStatus.sumUsage([])).toEqual({ used: 0, usedCacheRead: 0 })
  })
})

describe("DAG mode status schema", () => {
  const status = {
    mode: "on" as const,
    defaultMode: "off" as const,
    availability: "available" as const,
    unavailableReason: null,
    budget: { tokens: 1000, used: 250, usedCacheRead: 90, warnRatio: 0.8 },
    limits: {
      concurrency: 12,
      configuredConcurrency: null,
      maxTotalNodes: 100,
      configuredMaxTotalNodes: null,
      running: 2,
    },
    quality: null,
  }

  test("decodes the fixed Issue §9 shape", () => {
    expect(Schema.decodeUnknownSync(DagModeStatus.Status)(status)).toEqual(status)
  })

  // #1290: every limit comes as the value in force and the value configured.
  test("carries each limit as the value in force and the configured value, null while unset", () => {
    const configured = { ...status.limits, concurrency: 14, configuredConcurrency: 30, configuredMaxTotalNodes: 40 }
    expect(Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, limits: configured }).limits).toEqual(configured)
    const { configuredConcurrency: _concurrency, ...withoutConcurrency } = status.limits
    expect(() => Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, limits: withoutConcurrency })).toThrow()
    const { configuredMaxTotalNodes: _nodes, ...withoutNodes } = status.limits
    expect(() => Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, limits: withoutNodes })).toThrow()
  })

  // #1027 D6b: the session read carries the same quality a workflow summary does.
  test("decodes a combined review quality and rejects a malformed one", () => {
    const quality = {
      reviewBound: true,
      reviews: 2,
      raised: 7,
      fixed: 5,
      refuted: 2,
      stillOpen: 0,
      skepticRefutations: 1,
      rounds: 2,
      quietRounds: 1,
      completeness: { covered: 3, total: 3, unlisted: 0 },
    }
    expect(Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, quality }).quality).toEqual(quality)
    expect(() =>
      Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, quality: { ...quality, raised: -1 } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(DagModeStatus.Status)({ ...status, quality: { reviews: 1 } })).toThrow()
  })

  test("decodes every unavailable reason and rejects unknown ones", () => {
    for (const reason of ["start_denied", "workflow_tool_disabled", "model_no_tool_calling", "no_worker"] as const) {
      expect(
        Schema.decodeUnknownSync(DagModeStatus.Status)({
          ...status,
          availability: "unavailable",
          unavailableReason: reason,
        }).unavailableReason,
      ).toBe(reason)
    }
    expect(() =>
      Schema.decodeUnknownSync(DagModeStatus.Status)({
        ...status,
        availability: "unavailable",
        unavailableReason: "other",
      }),
    ).toThrow()
  })
})
