import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { HookTranscript } from "@/hook/transcript"
import { HookModelMetrics } from "@/hook/model-metrics"
import { ProviderTest } from "../fake/provider"

const model = ProviderTest.model({
  id: ModelV2.ID.make("claude-fixture"),
  providerID: ProviderV2.ID.make("anthropic"),
  api: { id: "claude-fixture", npm: "@ai-sdk/anthropic", url: "https://example.invalid" },
})
const history = (created = 1, overrides: Record<string, unknown> = {}): HookTranscript.Message[] => [
  {
    info: {
      id: "metrics-assistant",
      sessionID: "metrics-fixture",
      role: "assistant",
      providerID: model.providerID,
      modelID: model.id,
      time: { created, completed: 999_999 },
      tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 30, write: 40 } },
      ...overrides,
    },
    parts: [],
  },
]
const input = { sessionID: "metrics-fixture", target: model, previous: model, history: history(), now: 1000 }
const snapshot = (value: Parameters<typeof HookModelMetrics.snapshot>[0]) =>
  Effect.runPromise(HookModelMetrics.snapshot(value))

describe("truthful model hook metrics", () => {
  test("includes separately stored reasoning and all cached input in the context estimate", async () => {
    const result = await snapshot(input)
    expect(result.contextTokens).toBe(197)
    expect(result.promptCacheWarm).toBe(true)
  })
  test("cache lifetime starts at request creation, not its recent response completion", async () => {
    expect((await snapshot({ ...input, now: 300_001 })).promptCacheWarm).toBe(false)
    expect((await snapshot({ ...input, now: 1 })).promptCacheWarm).toBe(true)
    expect((await snapshot({ ...input, now: 0 })).promptCacheWarm).toBe(false)
  })
  test("effective model then agent then variant options control TTL, not ignored raw provider options", () => {
    expect(
      HookModelMetrics.ttl({ sessionID: input.sessionID, model, providerOptions: { cacheControl: { ttl: "1h" } } }),
    ).toBe("5m")
    const configured = {
      ...model,
      options: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      variants: { short: { cacheControl: { ttl: "5m" } } },
    }
    expect(HookModelMetrics.ttl({ sessionID: input.sessionID, model: configured })).toBe("1h")
    expect(
      HookModelMetrics.ttl({
        sessionID: input.sessionID,
        model: configured,
        agentOptions: { cacheControl: { ttl: "5m" } },
      }),
    ).toBe("5m")
    expect(HookModelMetrics.ttl({ sessionID: input.sessionID, model: configured, variant: "short" })).toBe("5m")
  })
  test("warm checks the previous model's TTL and identity, not target TTL", async () => {
    const target = { ...model, options: { cacheControl: { type: "ephemeral", ttl: "1h" } } }
    expect((await snapshot({ ...input, target, now: 600_001 })).promptCacheWarm).toBe(false)
    expect((await snapshot({ ...input, previous: target, now: 600_001 })).promptCacheWarm).toBe(true)
    expect((await snapshot({ ...input, history: history(1, { modelID: "different" }) })).promptCacheWarm).toBe(false)
    expect(
      (
        await snapshot({
          ...input,
          history: history(1, { tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        })
      ).promptCacheWarm,
    ).toBe(false)
  })
  test("explicit zero prices are configured; normalized unknown zeros are not catalog prices", async () => {
    const zero = await snapshot({ ...input, configuredCost: { input: 0, output: 0, cache_write: 0 } })
    expect(zero).toMatchObject({ pricing: "configured", estimatedCacheWriteUsd: 0 })
    const unknown = await snapshot({ ...input, target: ProviderTest.model() })
    expect(unknown.pricing).toBe("default")
    expect(unknown.estimatedCacheWriteUsd).toBeCloseTo((197 * 1.25) / 1_000_000)
  })
  test("configured tiers replace catalog tiers and one-hour writes cost 1.6 times standard writes", async () => {
    const target = { ...model, options: { cacheControl: { type: "ephemeral", ttl: "1h" } } }
    const result = await snapshot({
      ...input,
      target,
      configuredCost: { input: 2, output: 10, cache_write: 2.5 },
      catalogCost: {
        input: 5,
        output: 25,
        cache_write: 6.25,
        tiers: [{ input: 20, output: 100, cache_write: 25, tier: { type: "context", size: 10 } }],
      },
    })
    expect(result.pricing).toBe("configured")
    expect(result.estimatedCacheWriteUsd).toBeCloseTo((197 * 4) / 1_000_000)
    const inherited = await snapshot({
      ...input,
      configuredCost: { input: 2, output: 10 },
      catalogCost: {
        input: 5,
        output: 25,
        cache_write: 4,
        tiers: [{ input: 20, output: 100, cache_write: 50, tier: { type: "context", size: 10 } }],
      },
    })
    expect(inherited.pricing).toBe("catalog")
    expect(inherited.estimatedCacheWriteUsd).toBeCloseTo((197 * 4) / 1_000_000)
    const tiered = await snapshot({
      ...input,
      catalogCost: {
        input: 1,
        output: 5,
        cache_write: 1.25,
        tiers: [{ input: 2, output: 10, cache_write: 2.5, tier: { type: "context", size: 100 } }],
      },
    })
    expect(tiered.pricing).toBe("catalog")
    expect(tiered.estimatedCacheWriteUsd).toBeCloseTo((197 * 2.5) / 1_000_000)
  })
})

describe("official SessionStart metrics", () => {
  const metrics: HookModelMetrics.Metrics = {
    contextTokens: 197,
    promptCacheWarm: true,
    cacheTtl: "5m",
    estimatedCacheWriteUsd: 0.1,
    pricing: "configured",
  }
  const fields = (
    source: "startup" | "resume" | "fork" | "compact",
    extra: Partial<Parameters<typeof HookModelMetrics.sessionFields>[0]> = {},
  ) =>
    HookModelMetrics.sessionFields({
      source,
      title: "generated-looking title",
      history: history(1),
      metrics,
      now: 1_000_000,
      ...extra,
    })
  test("only resume/fork with an actual response emit the four official metrics", () => {
    expect(fields("startup")).toEqual({})
    expect(fields("compact")).toEqual({})
    expect(fields("resume", { history: [] })).toEqual({})
    expect(fields("fork")).toEqual({
      secondsSinceLastResponse: 0.001,
      contextTokens: 197,
      promptCacheLikelyExpired: false,
      estimatedCacheWriteUsd: 0.1,
    })
  })
  test("response completion time and TTL determine expiry; later compaction also expires it", () => {
    expect(fields("resume", { now: 1_300_000 }).promptCacheLikelyExpired).toBe(true)
    expect(fields("resume", { now: 1_300_000, metrics: { ...metrics, cacheTtl: "1h" } }).promptCacheLikelyExpired).toBe(
      false,
    )
    const compacted: HookTranscript.Message[] = [
      ...history(1),
      {
        info: { id: "metrics-compaction", sessionID: "metrics-fixture", role: "user", time: { created: 1000001 } },
        parts: [{ type: "compaction" }],
      },
    ]
    expect(fields("resume", { history: compacted }).promptCacheLikelyExpired).toBe(true)
  })
  test("only recorded custom titles are included; legacy and generated titles are omitted", () => {
    expect(fields("startup", { titleSource: "custom" })).toEqual({ sessionTitle: "generated-looking title" })
    expect(fields("startup", { titleSource: "generated" })).toEqual({})
    expect(fields("startup", { titleSource: undefined })).toEqual({})
  })
})
