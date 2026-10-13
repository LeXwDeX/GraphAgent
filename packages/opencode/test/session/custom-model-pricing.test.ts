import { describe, expect, test } from "bun:test"
import { Usage } from "@opencode-ai/llm"
import { Session as SessionNs } from "@/session/session"

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
