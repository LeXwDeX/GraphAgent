import { describe, expect, test } from "bun:test"
import { Token } from "@/util/token"
import { estimateOverhead, estimateRequest } from "../../src/session/overflow"

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
