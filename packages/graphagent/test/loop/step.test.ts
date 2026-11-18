// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@graphagent/llm"
import { LoopStep } from "@/loop/step"

const run = (events: ReadonlyArray<LLMEvent>) => {
  const state = LoopStep.collected()
  const failures = events.map((event) => LoopStep.add(state, event)).filter((failure) => failure !== undefined)
  return { state, failures }
}

const signed = { anthropic: { signature: "sig-1" } }

describe("analysis conversation steps (#1328)", () => {
  test("replays reasoning, text and tool calls in order with the provider metadata the events carried", () => {
    const { state } = run([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.reasoningStart({ id: "r0" }),
      LLMEvent.reasoningDelta({ id: "r0", text: "think " }),
      LLMEvent.reasoningDelta({ id: "r0", text: "harder" }),
      LLMEvent.reasoningEnd({ id: "r0", providerMetadata: signed }),
      LLMEvent.textStart({ id: "t0" }),
      LLMEvent.textDelta({ id: "t0", text: "Let me look." }),
      LLMEvent.textEnd({ id: "t0" }),
      LLMEvent.toolCall({
        id: "c1",
        name: "list_dir",
        input: { path: "." },
        providerMetadata: { openai: { itemId: "fc_1" } },
      }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    ])

    expect(LoopStep.assistant(state)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "think harder", providerOptions: signed },
        { type: "text", text: "Let me look." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "list_dir",
          input: { path: "." },
          providerOptions: { openai: { itemId: "fc_1" } },
        },
      ],
    })
  })

  test("a turn of reasoning alone is not replayed", () => {
    const { state } = run([
      LLMEvent.reasoningStart({ id: "r0" }),
      LLMEvent.reasoningDelta({ id: "r0", text: "hmm" }),
      LLMEvent.reasoningEnd({ id: "r0" }),
      LLMEvent.finish({ reason: "length" }),
    ])

    expect(LoopStep.assistant(state)).toBeUndefined()
    expect(state.finish).toBe("length")
  })

  test("a response with no content has no turn and no results", () => {
    const { state } = run([LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })])

    expect(LoopStep.assistant(state)).toBeUndefined()
    expect(LoopStep.results(state, new Map())).toBeUndefined()
    expect(LoopStep.calls(state)).toEqual([])
  })

  test("tool results follow the calls: recorded output first, then the stream's failure, then a notice", () => {
    const { state } = run([
      LLMEvent.toolCall({ id: "ok", name: "grep", input: {} }),
      LLMEvent.toolCall({ id: "rejected", name: "read_file", input: "{" }),
      LLMEvent.toolError({ id: "rejected", name: "read_file", message: "Invalid input" }),
      LLMEvent.toolCall({ id: "lost", name: "bash", input: {} }),
    ])

    expect(LoopStep.results(state, new Map([["ok", "found it"]]))).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "ok", toolName: "grep", output: { type: "text", value: "found it" } },
        {
          type: "tool-result",
          toolCallId: "rejected",
          toolName: "read_file",
          output: { type: "error-text", value: "Invalid input" },
        },
        {
          type: "tool-result",
          toolCallId: "lost",
          toolName: "bash",
          output: { type: "error-text", value: "The tool did not run: no result was recorded." },
        },
      ],
    })
  })

  test("a native tool failure arrives as an error result and is read like a tool error", () => {
    const { state } = run([
      LLMEvent.toolCall({ id: "c1", name: "bash", input: {} }),
      LLMEvent.toolResult({ id: "c1", name: "bash", result: { type: "error", value: "Invalid tool input: x" } }),
    ])

    expect(state.failures.get("c1")).toBe("Invalid tool input: x")
  })

  test("provider-hosted tool calls are not replayed", () => {
    const { state } = run([LLMEvent.toolCall({ id: "h1", name: "web_search", input: {}, providerExecuted: true })])

    expect(LoopStep.calls(state)).toEqual([])
    expect(LoopStep.assistant(state)).toBeUndefined()
  })

  test("usage comes from the finish event, falling back to the last step finish", () => {
    const stepOnly = run([
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 5, outputTokens: 2 } }),
    ])
    expect(stepOnly.state.usage).toEqual({ input: 5, output: 2, reasoning: 0 })

    const both = run([
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 5, outputTokens: 2 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 } }),
    ])
    expect(both.state.usage).toEqual({ input: 7, output: 3, reasoning: 1 })
  })

  test("a provider error event is handed back as a failure for the retry policy", () => {
    const { failures } = run([LLMEvent.providerError({ message: "overloaded", retryable: true })])

    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ type: "provider-error", message: "overloaded" })
  })

  test("text and reasoning deltas for an unseen block still start it", () => {
    const { state } = run([LLMEvent.textDelta({ id: "late", text: "hi" })])

    expect(LoopStep.assistant(state)).toEqual({ role: "assistant", content: [{ type: "text", text: "hi" }] })
  })
})
