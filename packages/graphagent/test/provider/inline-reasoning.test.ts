// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { resolveProfile } from "@graphagent/core/model-profile"
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

describe("inline reasoning tags follow the model profile", () => {
  /** A model whose configuration declares `inline_tag`; without `inlineTag` the configuration declares none. */
  const profiled = (providerID: string, apiID: string, inlineTag?: string) => ({
    ...model(providerID, apiID),
    profile: resolveProfile({
      providerID,
      apiID,
      npm: "@ai-sdk/openai-compatible",
      config: inlineTag === undefined ? undefined : { profile: { reasoning_mode: { inline_tag: inlineTag } } },
    }),
  })

  test("the tag the profile declares is returned without a table", () => {
    expect(inlineReasoningTag(profiled("custom", "local-think", "think"))).toBe("think")
    expect(inlineReasoningTag(profiled("anything", "any-model", "reasoning"))).toBe("reasoning")
  })

  test("splits <think> into reasoning and text for a model whose profile declares the tag", async () => {
    const tag = inlineReasoningTag(profiled("custom", "local-think", "think"))
    expect(await collect(wrapInlineReasoning(answering("<think>a</think>b"), tag))).toEqual({
      reasoning: "a",
      answer: "b",
    })
  })

  test("the profile is read before the table, and the table still serves a profile without a tag", () => {
    expect(inlineReasoningTag(profiled("custom", "local-think", "reasoning"), table)).toBe("reasoning")
    expect(inlineReasoningTag(profiled("custom", "local-think"), table)).toBe("think")
    expect(inlineReasoningTag(profiled("custom", "other-model"), table)).toBeUndefined()
    expect(inlineReasoningTag(profiled("custom", "local-think"))).toBeUndefined()
  })

  test("an empty tag in the profile counts as none", () => {
    expect(inlineReasoningTag(profiled("custom", "local-think", ""))).toBeUndefined()
    expect(inlineReasoningTag(profiled("custom", "local-think", ""), table)).toBe("think")
  })
})

describe("inline reasoning tags follow the built-in profile rules", () => {
  /** A model without a profile of its own: the tag comes from the built-in rules for its package and API id. */
  const reached = (apiID: string, npm = "@ai-sdk/openai-compatible", providerID = "relay") => ({
    providerID: ProviderV2.ID.make(providerID),
    api: { id: apiID, url: "", npm },
  })

  test("a Qwen, DeepSeek or GLM model on an OpenAI-compatible endpoint gets think", () => {
    for (const id of ["qwen3-235b-a22b", "Qwen/Qwen3-8B", "deepseek-r1", "DeepSeek-V3.1", "glm-4.5", "GLM-4.6"]) {
      expect({ id, tag: inlineReasoningTag(reached(id)) }).toEqual({ id, tag: "think" })
    }
  })

  test("a model no rule names, and a model of another package, gets none", () => {
    expect(inlineReasoningTag(reached("local-think", undefined, "custom"))).toBeUndefined()
    expect(inlineReasoningTag(reached("gpt-5"))).toBeUndefined()
    expect(inlineReasoningTag(reached("qwen3-max", "@ai-sdk/openai"))).toBeUndefined()
    expect(inlineReasoningTag(reached("deepseek-r1", "@ai-sdk/anthropic"))).toBeUndefined()
  })

  test("splits <think> out of the text of a model a rule names, and leaves the text of any other alone", async () => {
    const named = inlineReasoningTag(reached("qwen3-max"))
    expect(await collect(wrapInlineReasoning(answering("<think>a</think>b"), named))).toEqual({
      reasoning: "a",
      answer: "b",
    })
    const unnamed = inlineReasoningTag(reached("gpt-5"))
    expect(await collect(wrapInlineReasoning(answering("<think>a</think>b"), unnamed))).toEqual({
      reasoning: "",
      answer: "<think>a</think>b",
    })
  })

  test("a configured inline_tag wins over the rule, and an empty one switches it off", () => {
    const configured = (inlineTag: string) => ({
      ...reached("qwen3-max"),
      profile: resolveProfile({
        providerID: "relay",
        apiID: "qwen3-max",
        npm: "@ai-sdk/openai-compatible",
        config: { profile: { reasoning_mode: { inline_tag: inlineTag } } },
      }),
    })
    expect(inlineReasoningTag(configured("reasoning"))).toBe("reasoning")
    expect(inlineReasoningTag(configured(""))).toBeUndefined()
  })
})
