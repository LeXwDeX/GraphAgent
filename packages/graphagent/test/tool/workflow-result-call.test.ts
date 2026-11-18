// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowParameters } from "@/tool/workflow"
import { workflowResultCall } from "@/tool/workflow/result-call"

describe("workflowResultCall", () => {
  test("writes the call the way the model sends it", () => {
    expect(workflowResultCall("dag_abc", "node-1")).toBe(
      'workflow({"params":{"action":"inspect","operation":"result","workflow_id":"dag_abc","node_id":"node-1"}})',
    )
  })

  test("escapes ids so the call stays one valid JSON object", () => {
    const call = workflowResultCall('dag"x', 'a\\b"c')
    const args: unknown = JSON.parse(call.slice("workflow(".length, -1))
    expect(args).toEqual({
      params: { action: "inspect", operation: "result", workflow_id: 'dag"x', node_id: 'a\\b"c' },
    })
  })

  test("is accepted by the workflow tool's parameters, so the text names a real call", () => {
    const call = workflowResultCall("dag_abc", "node-1")
    const args: unknown = JSON.parse(call.slice("workflow(".length, -1))
    expect(Schema.decodeUnknownResult(WorkflowParameters)(args)._tag).toBe("Success")
  })
})
