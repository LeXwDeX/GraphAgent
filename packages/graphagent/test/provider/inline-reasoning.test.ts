// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { ProviderV2 } from "@graphagent/core/provider"
import { streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { INLINE_REASONING_TAGS, inlineReasoningTag, wrapInlineReasoning } from "@/provider/inline-reasoning"

const model = (providerID: string, apiID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  api: { id: apiID, url: "", npm: "@ai-sdk/openai-compatible" },
})

const table = [{ providerID: "custom", apiID: "local-think", tag: "think" }]

const finish: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
}

/** A model that streams `text` as one text block, the way an endpoint with inline reasoning does. */
const answering = (text: string): LanguageModelV3 =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "text-1" })
          controller.enqueue({ type: "text-delta", id: "text-1", delta: text })
          controller.enqueue({ type: "text-end", id: "text-1" })
          controller.enqueue(finish)
          controller.close()
        },
      }),
    }),
  })

async function collect(language: LanguageModelV3) {
  const result = streamText({ model: language, prompt: "hello" })
  let reasoning = ""
  let answer = ""
  for await (const part of result.fullStream) {
    if (part.type === "reasoning-delta") reasoning += part.text
    if (part.type === "text-delta") answer += part.text
  }
  return { reasoning, answer }
}

describe("inline reasoning tags", () => {
  test("the built-in table is empty, so no model is matched by default", () => {
    expect(INLINE_REASONING_TAGS).toEqual([])
    expect(inlineReasoningTag(model("custom", "local-think"))).toBeUndefined()
  })

  test("matches provider and api id exactly, never by a substring of the name", () => {
    expect(inlineReasoningTag(model("custom", "local-think"), table)).toBe("think")
    expect(inlineReasoningTag(model("custom", "local-think-2"), table)).toBeUndefined()
    expect(inlineReasoningTag(model("custom", "think"), table)).toBeUndefined()
    expect(inlineReasoningTag(model("other", "local-think"), table)).toBeUndefined()
  })

  test("a model without a tag is returned untouched", () => {
    const language = answering("x")
    expect(wrapInlineReasoning(language, undefined)).toBe(language)
  })

  test("keeps <think> in the text when no model declares the tag", async () => {
    const tag = inlineReasoningTag(model("custom", "local-think"))
    expect(await collect(wrapInlineReasoning(answering("<think>a</think>b"), tag))).toEqual({
      reasoning: "",
      answer: "<think>a</think>b",
    })
  })

  test("splits <think> into reasoning and text for a model that declares the tag", async () => {
    const tag = inlineReasoningTag(model("custom", "local-think"), table)
    expect(await collect(wrapInlineReasoning(answering("<think>a</think>b"), tag))).toEqual({
      reasoning: "a",
      answer: "b",
    })
  })
})
