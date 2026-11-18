// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { HookToolStop, withHookFailure } from "@/hook/trigger-result"
import { Question } from "@/question"
import { ToolInputRejectedError } from "@/session/llm/ai-sdk"
import { classifyToolError, endedMetadata } from "@/session/tool-outcome"
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

describe("endedMetadata", () => {
  test("keeps what a running call reported and adds how it ended", () => {
    const running = { status: "running", input: {}, metadata: { sessionID: "ses_child" }, time: { start: 1 } } as const
    expect(endedMetadata(running, "aborted")).toEqual({ sessionID: "ses_child", outcome: "aborted" })
    expect(endedMetadata(running, "execution_error")).toEqual({ sessionID: "ses_child", outcome: "execution_error" })
  })

  test("a running call that reported nothing, or a pending one, has only the outcome", () => {
    expect(endedMetadata({ status: "running", input: {}, time: { start: 1 } }, "aborted")).toEqual({
      outcome: "aborted",
    })
    expect(endedMetadata({ status: "pending", input: {}, raw: "" }, "denied")).toEqual({ outcome: "denied" })
  })

  test("the outcome it records wins over one the call already carried", () => {
    const running = { status: "running", input: {}, metadata: { outcome: "ok" }, time: { start: 1 } } as const
    expect(endedMetadata(running, "aborted")).toEqual({ outcome: "aborted" })
  })
})

describe("classifyToolError along the cause chain", () => {
  const invalid = () => new Tool.InvalidArgumentsError({ tool: "edit", detail: "bad" })
  const wrap = (error: unknown) => new Error("wrapped", { cause: error })

  test("a hook that adds feedback to a failure wraps the original error, whose class still decides", () => {
    const wrapped = withHookFailure(invalid(), { additionalContexts: ["Check the schema"], systemMessages: [] })
    expect(wrapped).not.toBeInstanceOf(Tool.InvalidArgumentsError)
    expect(classifyToolError(wrapped)).toBe("validation_error")
  })

  test("a hook that stops the turn on a failure wraps it in HookToolStop, and the original error still decides", () => {
    const stopped = withHookFailure(invalid(), {
      additionalContexts: [],
      systemMessages: [],
      preventContinuation: true,
      stopReason: "stop here",
    })
    expect(stopped).toBeInstanceOf(HookToolStop)
    expect(classifyToolError(stopped)).toBe("validation_error")
  })

  test("refusals and aborts are found under a wrapper as well", () => {
    expect(classifyToolError(wrap(new PermissionV1.RejectedError()))).toBe("denied")
    expect(classifyToolError(wrap(new Question.RejectedError()))).toBe("denied")
    expect(classifyToolError(wrap(new DOMException("Aborted", "AbortError")))).toBe("aborted")
    expect(classifyToolError(wrap(new ToolInputRejectedError("input rejected")))).toBe("validation_error")
  })

  test("wrappers inside wrappers are followed", () => {
    const hooked = withHookFailure(invalid(), { additionalContexts: ["Check the schema"], systemMessages: [] })
    expect(classifyToolError(wrap(wrap(hooked)))).toBe("validation_error")
  })

  test("the outermost recognised class decides", () => {
    expect(classifyToolError(new Tool.InvalidArgumentsError({ tool: "edit", detail: "bad" }))).toBe("validation_error")
    const refusal = new PermissionV1.RejectedError()
    Object.assign(refusal, { cause: invalid() })
    expect(classifyToolError(refusal)).toBe("denied")
  })

  test("a chain without a recognised class, or whose cause is not an error, is an execution error", () => {
    expect(classifyToolError(wrap(wrap(new Error("boom"))))).toBe("execution_error")
    expect(classifyToolError(new Error("boom", { cause: "text" }))).toBe("execution_error")
    expect(classifyToolError(new Error("boom", { cause: undefined }))).toBe("execution_error")
  })

  test("a chain that loops back on itself ends", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    Object.assign(a, { cause: b })
    expect(classifyToolError(a)).toBe("execution_error")
    Object.assign(b, { name: "AbortError" })
    expect(classifyToolError(a)).toBe("aborted")
  })

  test("only the first five errors of a chain are examined", () => {
    const wrappers = (count: number) => {
      let error: unknown = invalid()
      for (let index = 0; index < count; index++) error = wrap(error)
      return error
    }
    expect(classifyToolError(wrappers(4))).toBe("validation_error")
    expect(classifyToolError(wrappers(5))).toBe("execution_error")
  })
})
