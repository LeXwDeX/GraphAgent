import { describe, expect, test } from "bun:test"
import { Token } from "@/util/token"
import { estimateRequest } from "../../src/session/overflow"

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
})
