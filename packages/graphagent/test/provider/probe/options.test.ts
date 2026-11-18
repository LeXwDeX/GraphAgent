// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { ProbeOptions } from "@/provider/probe/options"
import { ProviderTest } from "../../fake/provider"

// An OpenAI-compatible model under the given provider, with the options its configuration carries.
function compatible(providerID: string, extra: { reasoning?: boolean; options?: Record<string, unknown> } = {}) {
  const base = ProviderTest.model()
  const id = ModelV2.ID.make("qwen-plus")
  return ProviderTest.model({
    id,
    providerID: ProviderV2.ID.make(providerID),
    api: { id, url: "https://api.example.com/v1", npm: "@ai-sdk/openai-compatible" },
    capabilities: { ...base.capabilities, reasoning: extra.reasoning ?? false },
    options: extra.options ?? {},
  })
}

describe("ProbeOptions.resolve", () => {
  test("a reasoning model on alibaba-cn carries the thinking switch the engine adds for it", () => {
    const options = ProbeOptions.resolve({ model: compatible("alibaba-cn", { reasoning: true }), providerOptions: {} })
    expect(options).toEqual({ "alibaba-cn": { enable_thinking: true } })
  })

  test("a model's configured options are sent under the provider's key", () => {
    const model = compatible("relay", { options: { enable_thinking: true, thinking: { type: "enabled" } } })
    expect(ProbeOptions.resolve({ model, providerOptions: {} })).toEqual({
      relay: { enable_thinking: true, thinking: { type: "enabled" } },
    })
  })

  test("the configured options are merged over the engine's own, deeply", () => {
    const model = compatible("alibaba-cn", {
      reasoning: true,
      options: { enable_thinking: false, extra_body: { a: 1 } },
    })
    expect(ProbeOptions.resolve({ model, providerOptions: {} })).toEqual({
      "alibaba-cn": { enable_thinking: false, extra_body: { a: 1 } },
    })
  })

  test("nothing configured and nothing derived is an empty set under the provider's key", () => {
    expect(ProbeOptions.resolve({ model: compatible("relay"), providerOptions: {} })).toEqual({ relay: {} })
  })

  test("setCacheKey on the provider adds the cache key, from a fixed probe session", () => {
    const options = ProbeOptions.resolve({ model: compatible("relay"), providerOptions: { setCacheKey: true } })
    expect(options).toEqual({ relay: { prompt_cache_key: "probe" } })
  })

  test("the key is the provider name up to the first dot, the one the SDK reads", () => {
    const model = compatible("wafer.ai", { options: { enable_thinking: true } })
    expect(ProbeOptions.resolve({ model, providerOptions: {} })).toEqual({ wafer: { enable_thinking: true } })
  })

  test("the model's own options are left as they were, and every call returns a fresh object", () => {
    const model = compatible("alibaba-cn", { reasoning: true, options: { extra_body: { a: 1 } } })
    const first = ProbeOptions.resolve({ model, providerOptions: {} })
    const second = ProbeOptions.resolve({ model, providerOptions: {} })
    expect(model.options).toEqual({ extra_body: { a: 1 } })
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})
