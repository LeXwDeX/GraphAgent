// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Question } from "@/question"
import { ToolInputRejectedError } from "@/session/llm/ai-sdk"
import { classifyToolError } from "@/session/tool-outcome"
import { Tool } from "@/tool/tool"

describe("classifyToolError", () => {
  test("arguments the schema or the SDK rejected are validation errors", () => {
    expect(classifyToolError(new Tool.InvalidArgumentsError({ tool: "edit", detail: "bad" }))).toBe("validation_error")
    expect(classifyToolError(new ToolInputRejectedError("input rejected"))).toBe("validation_error")
  })

  test("permission and question refusals are denials", () => {
    expect(classifyToolError(new PermissionV1.RejectedError())).toBe("denied")
    expect(classifyToolError(new PermissionV1.CorrectedError({ feedback: "use another path" }))).toBe("denied")
    expect(classifyToolError(new PermissionV1.DeniedError({ ruleset: [] }))).toBe("denied")
    expect(classifyToolError(new Question.RejectedError())).toBe("denied")
  })

  test("an abort is aborted, however it was raised", () => {
    const named = new Error("The operation was aborted")
    named.name = "AbortError"
    expect(classifyToolError(named)).toBe("aborted")
    expect(classifyToolError(new DOMException("Aborted", "AbortError"))).toBe("aborted")
  })

  test("any other error is an execution error", () => {
    expect(classifyToolError(new Error("boom"))).toBe("execution_error")
    expect(classifyToolError(new TypeError("bad"))).toBe("execution_error")
  })

  test("values that are not errors are execution errors", () => {
    expect(classifyToolError("boom")).toBe("execution_error")
    expect(classifyToolError(undefined)).toBe("execution_error")
    expect(classifyToolError(null)).toBe("execution_error")
    expect(classifyToolError({ message: "x" })).toBe("execution_error")
    expect(classifyToolError({ name: "toString" })).toBe("execution_error")
  })

  test("a plain object with a known tag is classified by the tag", () => {
    expect(classifyToolError({ _tag: "PermissionRejectedError" })).toBe("denied")
    expect(classifyToolError({ name: "ToolInvalidArgumentsError" })).toBe("validation_error")
  })
})
