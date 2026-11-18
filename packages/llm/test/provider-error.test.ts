// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { isContextOverflow, isContextOverflowFailure } from "../src/provider-error"
import { LLMEvent, Usage } from "../src/schema"

describe("isContextOverflow", () => {
  test("classifies repeated input-token-count prefix runs quickly", () => {
    // Kept ahead of the phrase tests: the old unbounded ".*" patterns scanned
    // this input quadratically (measured 539ms at 312KB, 8.6s at this 1.25MB
    // size); classification must stay fast and the unterminated run must not
    // match.
    const message = ("input token count " + "x".repeat(60)).repeat(16_000)
    const start = performance.now()
    expect(isContextOverflow(message)).toBe(false)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test("classifies repeated input-length prefix runs quickly", () => {
    const message = ("input length " + "y".repeat(60)).repeat(16_000)
    const start = performance.now()
    expect(isContextOverflow(message)).toBe(false)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test("detects known provider overflow phrases", () => {
    expect(isContextOverflow("prompt is too long")).toBe(true)
    expect(isContextOverflow("input is too long for requested model")).toBe(true)
    expect(isContextOverflow("This request exceeds the context window limit")).toBe(true)
    expect(isContextOverflow("input token count 99999 exceeds the maximum allowed")).toBe(true)
    expect(isContextOverflow("input length 123 exceeds context length")).toBe(true)
    expect(isContextOverflow("maximum context length is 8192 tokens")).toBe(true)
    expect(isContextOverflow("please reduce the length of the messages")).toBe(true)
    expect(isContextOverflow("context_length_exceeded")).toBe(true)
    expect(isContextOverflow("Request entity too large")).toBe(true)
  })

  test("detects empty-body 400 and 413 status forms", () => {
    expect(isContextOverflow("400 (no body)")).toBe(true)
    expect(isContextOverflow("413 status code (no body)")).toBe(true)
    expect(isContextOverflow("400")).toBe(false)
  })

  test("rejects unrelated provider errors", () => {
    expect(isContextOverflow("rate limit exceeded, please retry later")).toBe(false)
    expect(isContextOverflow("internal server error")).toBe(false)
    expect(isContextOverflow("invalid api key provided")).toBe(false)
    expect(isContextOverflow("connection reset by peer")).toBe(false)
    expect(isContextOverflow("input length is fine")).toBe(false)
    expect(isContextOverflow("the model is currently overloaded")).toBe(false)
  })

  test("classifies a multi-kilobyte message whose head contains an overflow phrase", () => {
    // The phrase must sit inside the inspected message head; phrases beyond it
    // are intentionally not classified.
    const message = "x".repeat(1500) + "maximum context length is 8192 tokens" + "x".repeat(60_000)
    const start = performance.now()
    expect(isContextOverflow(message)).toBe(true)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe("provider-error event usage", () => {
  test("keeps its context-overflow classification when it carries the usage billed for the cut-off response", () => {
    const event = LLMEvent.providerError({
      message: "Provider finish_reason: model_context_window_exceeded",
      classification: "context-overflow",
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    // A plain usage object is lifted to a Usage; the schema check behind the classification needs the instance.
    expect(event.usage).toBeInstanceOf(Usage)
    expect(event.usage?.inputTokens).toBe(10)
    expect(isContextOverflowFailure(event)).toBe(true)
  })

  test("takes an existing Usage as is", () => {
    const usage = new Usage({ inputTokens: 1 })
    expect(LLMEvent.providerError({ message: "boom", usage }).usage).toBe(usage)
  })

  test("has no usage key when none was reported", () => {
    const event = LLMEvent.providerError({ message: "boom", retryable: true })
    expect("usage" in event).toBe(false)
    expect(isContextOverflowFailure(event)).toBe(false)
  })
})
