import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session as SessionNs } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { testEffect } from "../lib/effect"

// Deterministic resolved-model fixtures matching the runtime ProviderCost shape that
// custom/configured models resolve to (Issue 764). Base rates 10/50 per million,
// general context tier (300k) 30/90, legacy over-200k rates 20/75.
const resolvedCost = {
  input: 10,
  output: 50,
  cache: { read: 1, write: 2 },
  tiers: [{ input: 30, output: 90, cache: { read: 4, write: 8 }, tier: { type: "context", size: 300_000 } }],
  experimentalOver200K: { input: 20, output: 75, cache: { read: 3, write: 6 } },
}

const baseOnlyCost = {
  input: 10,
  output: 50,
  cache: { read: 1, write: 2 },
}

const model = (cost: unknown) =>
  ({
    id: "long-context-model",
    providerID: "catalog-provider",
    name: "Long Context Model",
    limit: { context: 200_000, output: 64_000 },
    cost,
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  }) as never

const usage = (overrides: Record<string, number>) =>
  Usage.from({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides,
  })

describe("session.getUsage long-context pricing for resolved custom models", () => {
  test("threshold is normalized request inputTokens, not limit.context", () => {
    // The fixture's limit.context is 200_000; only inputTokens drives tier selection.
    const below = SessionNs.getUsage({ model: model(resolvedCost), usage: usage({ inputTokens: 199_999 }) })
    expect(below.tokens.input).toBe(199_999)
    expect(below.cost).toBeCloseTo((199_999 * 10) / 1_000_000, 8)

    const at = SessionNs.getUsage({ model: model(resolvedCost), usage: usage({ inputTokens: 200_000 }) })
    expect(at.cost).toBeCloseTo(2, 8)

    const above = SessionNs.getUsage({ model: model(resolvedCost), usage: usage({ inputTokens: 200_001 }) })
    expect(above.cost).toBeCloseTo((200_001 * 20) / 1_000_000, 8)
  })

  test("220k input and 10k output cost 5.15 at long-context rates instead of 2.70", () => {
    const result = SessionNs.getUsage({
      model: model(resolvedCost),
      usage: usage({ inputTokens: 220_000, outputTokens: 10_000, totalTokens: 230_000 }),
    })
    expect(result.tokens.input).toBe(220_000)
    expect(result.tokens.output).toBe(10_000)
    expect(result.cost).toBeCloseTo(5.15, 8)
  })

  test("cached input counts toward the threshold and cache/reasoning tokens are billed once", () => {
    const result = SessionNs.getUsage({
      model: model(resolvedCost),
      usage: usage({
        inputTokens: 220_000,
        outputTokens: 10_000,
        cacheReadInputTokens: 150_000,
        cacheWriteInputTokens: 20_000,
        reasoningTokens: 4_000,
        totalTokens: 230_000,
      }),
    })
    expect(result.tokens.input).toBe(50_000)
    expect(result.tokens.output).toBe(6_000)
    expect(result.tokens.reasoning).toBe(4_000)
    expect(result.tokens.cache).toEqual({ read: 150_000, write: 20_000 })
    // 50_000*20 + 6_000*75 + 4_000*75 (reasoning at output rate) + 150_000*3 + 20_000*6 = 2.32
    expect(result.cost).toBeCloseTo(2.32, 8)
  })

  test("general context tier wins over legacy over-200k rates when it matches", () => {
    const result = SessionNs.getUsage({
      model: model(resolvedCost),
      usage: usage({ inputTokens: 350_000, outputTokens: 10_000, totalTokens: 360_000 }),
    })
    expect(result.cost).toBeCloseTo((350_000 * 30 + 10_000 * 90) / 1_000_000, 8)
  })

  test("missing long-context pricing keeps base-rate behavior above the threshold", () => {
    const result = SessionNs.getUsage({
      model: model(baseOnlyCost),
      usage: usage({ inputTokens: 200_001, outputTokens: 10_000, totalTokens: 210_001 }),
    })
    expect(result.cost).toBeCloseTo((200_001 * 10 + 10_000 * 50) / 1_000_000, 8)
  })
})

// Issue 780: configured general context tiers must survive real Config -> Provider loading
// and drive Session.getUsage with arbitrary thresholds (e.g. 272k), not only the legacy 200k rate.
const tieredConfig = {
  provider: {
    "tiered-custom": {
      name: "Tiered Custom",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { apiKey: "test-key" },
      models: {
        tiered: {
          name: "Tiered",
          tool_call: true,
          limit: { context: 1_000_000, output: 64_000 },
          cost: {
            input: 10,
            output: 50,
            cache_read: 1,
            cache_write: 2,
            // Intentionally unordered: the highest matching threshold must win.
            tiers: [
              {
                input: 60,
                output: 180,
                cache_read: 6,
                cache_write: 12,
                tier: { type: "context" as const, size: 500_000 },
              },
              {
                input: 20,
                output: 75,
                cache_read: 3,
                cache_write: 4,
                tier: { type: "context" as const, size: 272_000 },
              },
            ],
          },
        },
        "tier-no-cache": {
          name: "Tier Without Cache Rates",
          tool_call: true,
          limit: { context: 1_000_000, output: 64_000 },
          cost: {
            input: 10,
            output: 50,
            cache_read: 1,
            cache_write: 2,
            tiers: [{ input: 20, output: 75, tier: { type: "context" as const, size: 272_000 } }],
          },
        },
        legacy: {
          name: "Legacy",
          tool_call: true,
          limit: { context: 400_000, output: 64_000 },
          cost: { input: 10, output: 50, context_over_200k: { input: 15, output: 60 } },
        },
      },
    },
  },
}

const loaded = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer))

const loadModel = (id: string) =>
  Effect.gen(function* () {
    const providers = yield* Provider.use.list()
    const item = providers[ProviderV2.ID.make("tiered-custom")]?.models[id]
    expect(item).toBeDefined()
    return item
  })

describe("session.getUsage with configured general context tiers loaded through Config", () => {
  loaded.instance(
    "configured 272k tier is loaded and selected only above the threshold",
    Effect.gen(function* () {
      const loadedModel = yield* loadModel("tiered")
      expect(loadedModel.cost.tiers).toHaveLength(2)
      const cost = (inputTokens: number) =>
        SessionNs.getUsage({ model: loadedModel, usage: usage({ inputTokens }) }).cost

      expect(cost(271_999)).toBeCloseTo((271_999 * 10) / 1_000_000, 8)
      expect(cost(272_000)).toBeCloseTo((272_000 * 10) / 1_000_000, 8)
      expect(cost(272_001)).toBeCloseTo((272_001 * 20) / 1_000_000, 8)
      // Multiple unordered tiers: the highest matching threshold wins.
      expect(cost(500_000)).toBeCloseTo((500_000 * 20) / 1_000_000, 8)
      expect(cost(500_001)).toBeCloseTo((500_001 * 60) / 1_000_000, 8)
    }),
    { config: tieredConfig },
  )

  loaded.instance(
    "cache tokens count toward the configured threshold and reasoning is charged once",
    Effect.gen(function* () {
      const loadedModel = yield* loadModel("tiered")
      const run = (inputTokens: number) =>
        SessionNs.getUsage({
          model: loadedModel,
          usage: usage({
            inputTokens,
            outputTokens: 10_000,
            reasoningTokens: 4_000,
            cacheReadInputTokens: 200_000,
            cacheWriteInputTokens: 50_000,
            totalTokens: inputTokens + 10_000,
          }),
        })

      const above = run(272_001)
      expect(above.tokens.input).toBe(22_001)
      expect(above.tokens.output).toBe(6_000)
      expect(above.tokens.reasoning).toBe(4_000)
      // 22_001*20 + 6_000*75 + 4_000*75 + 200_000*3 + 50_000*4
      expect(above.cost).toBeCloseTo(1.99002, 8)

      // 21_999*10 + 6_000*50 + 4_000*50 + 200_000*1 + 50_000*2
      expect(run(271_999).cost).toBeCloseTo(1.01999, 8)
    }),
    { config: tieredConfig },
  )

  loaded.instance(
    "configured tier without cache rates charges cached tokens at zero within that tier",
    Effect.gen(function* () {
      const loadedModel = yield* loadModel("tier-no-cache")
      expect(loadedModel.cost.cache).toEqual({ read: 1, write: 2 })
      expect(loadedModel.cost.tiers).toEqual([
        { input: 20, output: 75, cache: { read: 0, write: 0 }, tier: { type: "context", size: 272_000 } },
      ])
      const result = SessionNs.getUsage({
        model: loadedModel,
        usage: usage({ inputTokens: 300_000, cacheReadInputTokens: 100_000, totalTokens: 300_000 }),
      })
      expect(result.cost).toBeCloseTo((200_000 * 20) / 1_000_000, 8)
    }),
    { config: tieredConfig },
  )

  loaded.instance(
    "legacy context_over_200k keeps its 200k boundary",
    Effect.gen(function* () {
      const loadedModel = yield* loadModel("legacy")
      expect(loadedModel.cost.tiers).toBeUndefined()
      const cost = (inputTokens: number) =>
        SessionNs.getUsage({ model: loadedModel, usage: usage({ inputTokens }) }).cost
      expect(cost(200_000)).toBeCloseTo(2, 8)
      expect(cost(200_001)).toBeCloseTo((200_001 * 15) / 1_000_000, 8)
    }),
    { config: tieredConfig },
  )
})
