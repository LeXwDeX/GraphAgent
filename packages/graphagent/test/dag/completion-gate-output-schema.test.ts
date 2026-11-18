// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Dag, type WorkflowConfig } from "@/dag/dag"
import { DagCompletionGate } from "@/dag/completion-gate"

// #1344: `schemaAllowsString` is private to the completion gate. It decides
// whether a completed node's string output is data (the schema accepts a
// string) or a JSON document to inspect for a failing verdict. These cases
// reach it through `requiredCompletionGaps`: the same output string yields no
// gap when the schema accepts strings and a verdict gap when it does not.
const failingJson = '{"verdict":"FAIL"}'

const gateNode = {
  id: "gate",
  name: "gate",
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: "gate" },
}

function gaps(outputSchema: Record<string, unknown>) {
  const config: WorkflowConfig = { name: "completion-gate", nodes: [{ ...gateNode, output_schema: outputSchema }] }
  return DagCompletionGate.requiredCompletionGaps(config, [
    { id: "gate", status: "completed", required: true, output: failingJson, errorReason: null },
  ])
}

describe("completion gate string-output detection", () => {
  const keepsStringAsData: Record<string, Record<string, unknown>> = {
    "a type list that includes string": { type: ["null", "string"] },
    "an anyOf variant that is a string": { anyOf: [{ type: "object" }, { type: "string" }] },
    "a oneOf variant that is a string": { oneOf: [{ type: "number" }, { type: "string" }] },
    "a string nested inside a variant": { anyOf: [{ oneOf: [{ type: ["integer", "string"] }] }] },
    "a later key after an anyOf with no string": { anyOf: [{ type: "object" }], oneOf: [{ type: "string" }] },
  }

  for (const [name, schema] of Object.entries(keepsStringAsData)) {
    it(`keeps string output as data for ${name}`, () => {
      expect(gaps(schema)).toEqual([])
    })
  }

  const parsesString: Record<string, Record<string, unknown>> = {
    "an anyOf whose variants are not strings": { anyOf: [{ type: "object" }, { type: "number" }] },
    "a oneOf whose variants are not strings": { oneOf: [{ type: "object" }, { type: ["null", "boolean"] }] },
    "an anyOf holding non-record variants": { anyOf: ["string", 7, null] },
    "an anyOf that is not an array": { anyOf: { type: "string" } },
    "a schema with no type": {},
  }

  for (const [name, schema] of Object.entries(parsesString)) {
    it(`parses string output for ${name}`, () => {
      expect(gaps(schema)).toEqual(["gate (verdict FAIL)"])
    })
  }
})

describe("completion gate facade", () => {
  it("dag.ts re-exports the gate's own bindings", () => {
    // control.ts matches these errors with `instanceof`, so the facade must hand
    // out the same class objects, not copies.
    expect(Dag.ReviewGateError).toBe(DagCompletionGate.ReviewGateError)
    expect(Dag.CompletionGateError).toBe(DagCompletionGate.CompletionGateError)
    expect(Dag.requiredCompletionGaps).toBe(DagCompletionGate.requiredCompletionGaps)
  })
})
