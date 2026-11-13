// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { closeCaptureSlot, createCaptureSlot, validateAgainstSchema, validatePayloadAsync } from "@/dag/runtime/capture"
import { evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"

// --- Unit tests for eval.ts ---

describe("evaluateCondition", () => {
  it("returns ok:true value:true for empty/undefined condition", () => {
    expect(evaluateCondition(undefined, {})).toEqual({ ok: true, value: true })
    expect(evaluateCondition("", {})).toEqual({ ok: true, value: true })
  })

  it("evaluates numeric comparison with structured output", () => {
    const outputs = { "explore": { output: { findings_count: 5 } } }
    expect(evaluateCondition("explore.output.findings_count > 0", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("explore.output.findings_count > 10", outputs)).toEqual({ ok: true, value: false })
  })

  it("evaluates equality with structured output", () => {
    const outputs = { "check": { output: { status: "ok" } } }
    expect(evaluateCondition('check.output.status == "ok"', outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition('check.output.status == "fail"', outputs)).toEqual({ ok: true, value: false })
  })

  it("fails loudly when a numeric comparison's path is missing (silent skip was the worst failure mode)", () => {
    const result = evaluateCondition("missing.output.field > 0", {})
    expect(result.ok).toBe(false)
  })

  it("equality with a missing path still evaluates (undefined never equals a literal)", () => {
    expect(evaluateCondition("missing.output.field == done", {})).toEqual({ ok: true, value: false })
  })
})

describe("resolveInputMapping", () => {
  it("resolves full output reference", () => {
    const getOutput = (id: string) => (id === "refactor" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ diff: "refactor.output" }, getOutput)
    expect(result).toEqual({ diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })

  it("returns empty for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves to null for missing node", () => {
    const result = resolveInputMapping({ x: "ghost.output" }, () => null)
    expect(result).toEqual({ x: null })
  })
})

// --- Unit tests for capture.ts (schema validation) ---

describe("validateAgainstSchema", () => {
  it("validates patterns against the complete accepted string", () => {
    expect(validateAgainstSchema("a".repeat(99_999) + "!", { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_000), { pattern: "^a+$" }).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(99_999) + "!", { pattern: "!$" }).ok).toBe(true)
  })

  it("rejects oversize pattern input rather than validating a prefix", () => {
    expect(validateAgainstSchema("a".repeat(100_000) + "!", { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { type: "string" }).ok).toBe(true)
  })

  it("preserves unanchored JSON Schema pattern matching and malformed-pattern rejection", () => {
    expect(validateAgainstSchema("prefix abc suffix", { pattern: "abc" }).ok).toBe(true)
    expect(validateAgainstSchema("abc", { pattern: "[" }).ok).toBe(false)
  })

  it("accepts matching object type", () => {
    expect(validateAgainstSchema({ a: 1 }, { type: "object" })).toEqual({ ok: true })
  })

  it("rejects wrong type", () => {
    expect(validateAgainstSchema("str", { type: "object" }).ok).toBe(false)
    expect(validateAgainstSchema({}, { type: "array" }).ok).toBe(false)
    expect(validateAgainstSchema(42, { type: "string" }).ok).toBe(false)
  })

  it("enforces required fields", () => {
    const schema = { type: "object" as const, required: ["name", "count"] }
    expect(validateAgainstSchema({ name: "x" }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ name: "x", count: 1 }, schema).ok).toBe(true)
  })

  it("requires own JSON properties even for Object.prototype names", () => {
    for (const field of ["constructor", "toString", "__proto__"]) {
      expect(validateAgainstSchema({}, { type: "object", required: [field] }).ok).toBe(false)
      const payload = JSON.parse(`{"${field}":"present"}`)
      expect(validateAgainstSchema(payload, { type: "object", required: [field] }).ok).toBe(true)
    }
  })

  it("validates only present own properties and rejects undeclared prototype names", () => {
    for (const field of ["constructor", "toString", "__proto__"]) {
      const properties = JSON.parse(`{"${field}":{"type":"string"}}`)
      const schema = { type: "object", properties, additionalProperties: false }
      expect(validateAgainstSchema({}, schema).ok).toBe(true)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":"valid"}`), schema).ok).toBe(true)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":1}`), schema).ok).toBe(false)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":"extra"}`), {
        type: "object", properties: {}, additionalProperties: false,
      }).ok).toBe(false)
    }
  })

  it("matches the complete string at the regex length boundary and rejects longer values", () => {
    const schema = { type: "string", pattern: "^a+$" }
    expect(validateAgainstSchema("a".repeat(99_999), schema).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(100_000), schema).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(99_999) + "!", schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_000) + "!", schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { type: "string" }).ok).toBe(true)
  })

  it("validates nested properties recursively", () => {
    const schema = {
      type: "object" as const,
      properties: {
        meta: { type: "object" as const, required: ["id"] },
      },
    }
    expect(validateAgainstSchema({ meta: {} }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ meta: { id: "abc" } }, schema).ok).toBe(true)
  })

  it("validates array items", () => {
    const schema = { type: "array" as const, items: { type: "number" as const } }
    expect(validateAgainstSchema([1, 2, 3], schema).ok).toBe(true)
    expect(validateAgainstSchema([1, "x"], schema).ok).toBe(false)
  })

  it("validates integer type", () => {
    expect(validateAgainstSchema(5, { type: "integer" }).ok).toBe(true)
    expect(validateAgainstSchema(5.5, { type: "integer" }).ok).toBe(false)
    expect(validateAgainstSchema("5", { type: "integer" }).ok).toBe(false)
  })

  it("rejects values outside enum and accepts members", () => {
    const schema = { type: "string", enum: ["ACCEPT", "REJECT"] }
    expect(validateAgainstSchema("ACCEPT", schema).ok).toBe(true)
    expect(validateAgainstSchema("REJECT", schema).ok).toBe(true)
    const bad = validateAgainstSchema("MAYBE", schema)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error).toContain("ACCEPT")
      expect(bad.error).toContain("MAYBE")
    }
  })

  it("enum comparison is case-sensitive", () => {
    expect(validateAgainstSchema("accept", { enum: ["ACCEPT"] }).ok).toBe(false)
  })

  it("validates mixed-type enum values", () => {
    const schema = { enum: [1, "one", true, null] }
    expect(validateAgainstSchema(1, schema).ok).toBe(true)
    expect(validateAgainstSchema("one", schema).ok).toBe(true)
    expect(validateAgainstSchema(true, schema).ok).toBe(true)
    expect(validateAgainstSchema(null, schema).ok).toBe(true)
    expect(validateAgainstSchema(2, schema).ok).toBe(false)
    expect(validateAgainstSchema(false, schema).ok).toBe(false)
  })

  it("validates bare enum without type", () => {
    expect(validateAgainstSchema("x", { enum: ["x", "y"] }).ok).toBe(true)
    expect(validateAgainstSchema("z", { enum: ["x", "y"] }).ok).toBe(false)
  })

  it("validates const with structural deep equality (key order irrelevant)", () => {
    expect(validateAgainstSchema("fixed", { const: "fixed" }).ok).toBe(true)
    expect(validateAgainstSchema("other", { const: "fixed" }).ok).toBe(false)
    const schema = { const: { a: 1, b: { c: [1, 2] } } }
    expect(validateAgainstSchema({ b: { c: [1, 2] }, a: 1 }, schema).ok).toBe(true)
    expect(validateAgainstSchema({ a: 1, b: { c: [2, 1] } }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ a: 1 }, schema).ok).toBe(false)
  })

  it("validates enum nested inside properties and items", () => {
    const schema = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
        tags: { type: "array", items: { enum: ["a", "b"] } },
      },
    }
    expect(validateAgainstSchema({ verdict: "ACCEPT", tags: ["a", "b"] }, schema).ok).toBe(true)
    const badField = validateAgainstSchema({ verdict: "MAYBE" }, schema)
    expect(badField.ok).toBe(false)
    if (!badField.ok) expect(badField.error).toContain('field "verdict"')
    const badItem = validateAgainstSchema({ tags: ["a", "c"] }, schema)
    expect(badItem.ok).toBe(false)
    if (!badItem.ok) expect(badItem.error).toContain("item[1]")
  })

  it("reports type mismatch before enum membership", () => {
    const result = validateAgainstSchema(1, { type: "string", enum: ["a"] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('expected type "string"')
  })
})
describe("validatePayloadAsync", () => {
  it("rejects a closed capture slot", async () => {
    const slot = createCaptureSlot({ type: "object" })
    closeCaptureSlot(slot)
    const result = await validatePayloadAsync(slot, {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.notAvailable).toBe(true)
  })
})
