// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ToolBudget } from "@graphagent/core/session/tool-budget"

describe("ToolBudget", () => {
  test("uses the shared default and rejects invalid limits", () => {
    expect(ToolBudget.resolveMaxToolCalls()).toBe(ToolBudget.DEFAULT_MAX_TOOL_CALLS)
    expect(ToolBudget.DEFAULT_MAX_TOOL_CALLS).toBe(0)
    expect(ToolBudget.create().remaining).toBe(Infinity)
    expect(ToolBudget.create(7).max).toBe(7)
    expect(ToolBudget.resolveMaxToolCalls(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    for (const max of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ToolBudget.resolveMaxToolCalls(max)).toThrow(RangeError)
      expect(() => ToolBudget.create(max)).toThrow(RangeError)
    }
  })

  test("allows more than the former limit with absent or explicit zero limits", () => {
    for (const value of [undefined, 0]) {
      const budget = ToolBudget.create(value)
      expect(budget.max).toBe(0)
      for (let call = 0; call < 75; call++) expect(budget.tryReserve()).toBe(true)
      expect(budget.used).toBe(75)
      expect(budget.remaining).toBe(Infinity)
      expect(budget.exhausted).toBe(false)
    }
  })

  test("uses the configured limit in shared exhaustion messages", () => {
    expect(ToolBudget.exhaustedMessage(7)).toBe("Maximum tool calls (7) reached for this user input.")
    expect(ToolBudget.renderExhaustedPrompt(7)).toBe(
      "Maximum tool calls (7) reached for this user input. Tools are disabled until the next user input. Respond with text summarizing completed work, remaining work, and next steps.",
    )
  })

  test("admits exactly the limit across concurrent executor attempts", async () => {
    const budget = ToolBudget.create(3)
    let executions = 0
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        await Promise.resolve()
        if (!budget.tryReserve()) return false
        await Promise.resolve()
        executions += 1
        return true
      }),
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(executions).toBe(3)
    expect(budget.used).toBe(3)
    expect(budget.remaining).toBe(0)
    expect(budget.exhausted).toBe(true)
    expect(budget.tryReserve()).toBe(false)
    expect(budget.used).toBe(3)
  })

  test("retains consumed slots after failed execution and isolates runs", async () => {
    const budget = ToolBudget.create(1)
    const execute = async () => {
      if (!budget.tryReserve()) return "blocked"
      throw new Error("permission denied")
    }
    await expect(execute()).rejects.toThrow("permission denied")
    expect(await execute()).toBe("blocked")
    expect(budget.used).toBe(1)
    const nextRun = ToolBudget.create(1)
    expect(nextRun.tryReserve()).toBe(true)
    expect(budget.remaining).toBe(0)
  })
})
