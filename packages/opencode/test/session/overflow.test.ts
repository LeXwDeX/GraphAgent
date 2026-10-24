import { describe, expect, test } from "bun:test"
import { Token } from "@/util/token"
import { estimateOverhead, estimateRequest, usable } from "../../src/session/overflow"

describe("estimateRequest", () => {
  test("counts CJK text near one token per character", () => {
    const messages = [{ role: "user", content: "中".repeat(4_000) }]
    const naive = Token.estimate(JSON.stringify({ system: [], messages }))
    expect(naive).toBeLessThan(1_200)
    expect(estimateRequest({ system: [], messages })).toBeGreaterThanOrEqual(4_000)
  })

  test("includes system text and tool schemas", () => {
    const base = estimateRequest({ system: [], messages: [] })
    const withSystem = estimateRequest({ system: ["x".repeat(4_000)], messages: [] })
    const withTools = estimateRequest({
      system: [],
      messages: [],
      tools: { read: { description: "y".repeat(4_000), parameters: { type: "object" } } },
    })
    expect(withSystem).toBeGreaterThan(base + 900)
    expect(withTools).toBeGreaterThan(base + 900)
  })

  test("counts the AI SDK inputSchema shape, not only descriptions", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "z".repeat(4_000) } } }
    const withDescriptionOnly = estimateRequest({
      system: [],
      messages: [],
      tools: { lookup: { description: "lookup" } },
    })
    const withSchema = estimateRequest({
      system: [],
      messages: [],
      tools: { lookup: { description: "lookup", inputSchema: { jsonSchema: schema } } },
    })
    expect(withSchema).toBeGreaterThan(withDescriptionOnly + 900)
  })
})

describe("estimateOverhead", () => {
  test("counts system and tool schemas without any messages", () => {
    const base = estimateOverhead({ system: [] })
    const withSystem = estimateOverhead({ system: ["x".repeat(4_000)] })
    const withTools = estimateOverhead({
      system: [],
      tools: { lookup: { description: "y".repeat(4_000), parameters: { type: "object" } } },
    })
    expect(base).toBeLessThan(20)
    expect(withSystem).toBeGreaterThan(base + 900)
    expect(withTools).toBeGreaterThan(base + 900)
    expect(withSystem + withTools).toBeGreaterThan(base + 1_800)
  })

  test("counts the AI SDK inputSchema shape", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "z".repeat(4_000) } } }
    expect(estimateOverhead({ system: [], tools: { lookup: { inputSchema: { jsonSchema: schema } } } })).toBeGreaterThan(
      900,
    )
  })
})

describe("usable output reserve", () => {
  const model = (context: number, output: number, input?: number) =>
    ({
      id: "reasoner",
      providerID: "local",
      limit: { context, output, ...(input === undefined ? {} : { input }) },
    }) as any
  const cfg = (output?: number) =>
    ({
      compaction: {},
      ...(output === undefined
        ? {}
        : { provider: { local: { models: { reasoner: { limit: { context: 128_000, output } } } } } }),
    }) as any

  test("keeps the existing reserve for context windows larger than the output budget", () => {
    expect(usable({ cfg: cfg(), model: model(1_000_000, 384_000) })).toBe(968_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000) })).toBe(168_000)
  })

  test("does not starve a small-context model when the configured output budget is large", () => {
    const small = model(128_000, 384_000)
    expect(usable({ cfg: cfg(384_000), model: small })).toBe(20_000)
    expect(usable({ cfg: cfg(), model: model(128_000, 32_000) })).toBe(96_000)
    expect(usable({ cfg: cfg(), model: model(8_000, 32_000) })).toBe(8_000)
  })

  test("keeps the input-cap reserve independent of the output budget", () => {
    expect(usable({ cfg: cfg(384_000), model: model(1_050_000, 128_000, 922_000) })).toBe(902_000)
  })

  test("keeps the experimental output override authoritative", () => {
    const small = model(128_000, 384_000)
    expect(usable({ cfg: cfg(384_000), model: small, outputTokenMax: 32_000 })).toBe(96_000)
  })

  test("reserves an environment override above the conservative default for a catalog-only limit", () => {
    expect(usable({ cfg: cfg(), model: model(1_000_000, 128_000), outputTokenMax: 64_000 })).toBe(936_000)
    expect(usable({ cfg: cfg(), model: model(1_000_000, 128_000) })).toBe(968_000)
  })
})
