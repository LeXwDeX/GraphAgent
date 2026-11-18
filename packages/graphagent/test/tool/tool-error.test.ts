// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ToolError } from "@/tool/tool-error"

describe("ToolError.render", () => {
  test("invalid_arguments names the tool, the detail and the next step", () => {
    expect(
      ToolError.render({ kind: "invalid_arguments", tool: "read", detail: '["filePath"] missing required field' }),
    ).toBe(
      'The read tool was called with invalid arguments: ["filePath"] missing required field. Fix them and call read again.',
    )
  })

  test("invalid_arguments does not double a trailing period", () => {
    expect(ToolError.render({ kind: "invalid_arguments", tool: "goal", detail: "Goal is already set." })).toBe(
      "The goal tool was called with invalid arguments: Goal is already set. Fix them and call goal again.",
    )
  })

  test("unknown_tool lists the available names", () => {
    expect(ToolError.render({ kind: "unknown_tool", requested: "no_such_tool", available: ["lookup", "read"] })).toBe(
      'Unknown tool "no_such_tool". Available tools: lookup, read. Use one of them.',
    )
  })

  test("unknown_tool says when nothing is available and cuts the requested name to 64 code points", () => {
    const requested = "😀".repeat(80)
    expect(ToolError.render({ kind: "unknown_tool", requested, available: [] })).toBe(
      `Unknown tool "${"😀".repeat(64)}". Available tools: (none). Use one of them.`,
    )
  })

  test("invalid_json names both possible causes without echoing the text", () => {
    expect(ToolError.render({ kind: "invalid_json", tool: "write", length: 5000 })).toBe(
      "The arguments for write are not valid JSON (5000 characters). If the output limit cut the call off, split the work into smaller write calls; otherwise resend one complete JSON object.",
    )
  })

  test("truncated_arguments reports where the output limit cut the call", () => {
    expect(ToolError.render({ kind: "truncated_arguments", tool: "write", length: 32000 })).toBe(
      "The arguments for write were cut off at character 32000 by the output limit, so the call did not run. Send smaller arguments or split the work into several write calls.",
    )
  })
})

describe("ToolError.oneOf", () => {
  test("quotes strings and keeps numbers and booleans bare", () => {
    expect(ToolError.oneOf(["text", "markdown"])).toBe('one of "text", "markdown"')
    expect(ToolError.oneOf([1, 2, true])).toBe("one of 1, 2, true")
  })

  test("lists 20 values as they are", () => {
    const values = Array.from({ length: 20 }, (_, index) => `v${index}`)
    expect(ToolError.oneOf(values)).toBe(`one of ${values.map((value) => `"${value}"`).join(", ")}`)
  })

  test("lists only the first 20 of 25 values and says how many exist", () => {
    const values = Array.from({ length: 25 }, (_, index) => `v${index}`)
    const text = ToolError.oneOf(values)
    expect(text).toBe(
      `one of ${values
        .slice(0, 20)
        .map((value) => `"${value}"`)
        .join(", ")}, ... (first 20 of 25)`,
    )
    expect(text).not.toContain('"v20"')
  })
})

describe("ToolError.nameList", () => {
  test("joins names and writes (none) for an empty list", () => {
    expect(ToolError.nameList(["a", "b"])).toBe("a, b")
    expect(ToolError.nameList([])).toBe("(none)")
  })

  test("lists 30 names as they are", () => {
    const names = Array.from({ length: 30 }, (_, index) => `t${index}`)
    expect(ToolError.nameList(names)).toBe(names.join(", "))
  })

  test("lists the first 30 of 31 names and gives the total", () => {
    const names = Array.from({ length: 31 }, (_, index) => `t${index}`)
    const text = ToolError.nameList(names)
    expect(text).toBe(`${names.slice(0, 30).join(", ")}, ... (31 in total)`)
    expect(text).not.toContain("t30")
  })

  test("cuts each name to 64 code points", () => {
    expect(ToolError.nameList(["😀".repeat(70), "x".repeat(70)])).toBe(`${"😀".repeat(64)}, ${"x".repeat(64)}`)
  })
})
