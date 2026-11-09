// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { hideToolDetails, toolAttention } from "../../../src/routes/session/tool-attention"

test("persisted model validation failure remains visible with details hidden", () => {
  const state = {
    status: "completed",
    output: JSON.stringify({
      valid: false,
      errors: [{ code: "model.unavailable", message: "no model resolves for node worker" }],
    }),
  }
  expect(toolAttention("workflow", state)).toContain("model.unavailable")
  expect(hideToolDetails("workflow", state, false)).toBe(false)
})

test("structured blocked starts remain visible without generic output", () => {
  const state = { status: "completed", metadata: { blocked: true, diagnosticSummary: "model unavailable" } }
  expect(toolAttention("workflow", state)).toBe("model unavailable")
  expect(hideToolDetails("workflow", state, false)).toBe(false)
})

test("successful and unrelated output retain normal visibility", () => {
  for (const output of ['{"valid":true}', "plain output", "null"]) {
    const state = { status: "completed", output }
    expect(toolAttention("workflow", state)).toBeUndefined()
    expect(hideToolDetails("workflow", state, false)).toBe(true)
    expect(hideToolDetails("workflow", state, true)).toBe(false)
  }
  expect(toolAttention("bash", { status: "completed", output: '{"valid":false,"errors":[]}' })).toBeUndefined()
  expect(hideToolDetails("workflow", { status: "error" }, false)).toBe(false)
})
