import { describe, expect, test } from "bun:test"
import {
  classifyProperty,
  fieldSpecsFromSchema,
  schemaToQuestions,
  validateAndCoerce,
} from "@/mcp/elicitation"

// mcp-elicitation-notification unit tests: schema→Question mapping (5.1) and
// reply validation + three-state coercion (5.2). The mapping/validation helpers
// are pure synchronous functions exported from the adapter.

describe("mcp elicitation — schema→Question mapping (5.1)", () => {
  test("enum property maps to an options list", () => {
    const res = schemaToQuestions("pick", {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
    })
    expect("reject" in res).toBe(false)
    if ("reject" in res) return
    expect(res.questions).toHaveLength(1)
    expect(res.questions[0].options.map((o) => o.label)).toEqual(["red", "green", "blue"])
    expect(res.questions[0].custom).toBe(false)
  })

  test("boolean property maps to Yes/No options", () => {
    const res = schemaToQuestions("confirm", {
      type: "object",
      properties: { ok: { type: "boolean" } },
    })
    if ("reject" in res) throw new Error("expected mapping")
    expect(res.questions[0].options.map((o) => o.label)).toEqual(["Yes", "No"])
    expect(res.questions[0].custom).toBe(false)
  })

  test("string property maps to free-text (custom=true, empty options)", () => {
    const res = schemaToQuestions("enter", {
      type: "object",
      properties: { name: { type: "string", description: "Your name" } },
    })
    if ("reject" in res) throw new Error("expected mapping")
    expect(res.questions[0].options).toEqual([])
    expect(res.questions[0].custom).toBe(true)
    expect(res.questions[0].question).toContain("Your name")
  })

  test("number/integer properties map to free-text", () => {
    const res = schemaToQuestions("enter", {
      type: "object",
      properties: { count: { type: "integer" }, score: { type: "number" } },
    })
    if ("reject" in res) throw new Error("expected mapping")
    expect(res.questions).toHaveLength(2)
    const specs = fieldSpecsFromSchema({
      type: "object",
      properties: { count: { type: "integer" }, score: { type: "number" } },
    })
    expect(specs.map((s) => s.kind)).toEqual(["integer", "number"])
  })

  test("non-object requestedSchema is rejected", () => {
    expect("reject" in schemaToQuestions("x", "nope")).toBe(true)
    expect("reject" in schemaToQuestions("x", { type: "string" })).toBe(true)
  })

  test("nested/array/object properties are rejected", () => {
    const res = schemaToQuestions("x", {
      type: "object",
      properties: { bad: { type: "object" } },
    })
    expect("reject" in res).toBe(true)
    const res2 = schemaToQuestions("x", {
      type: "object",
      properties: { bad: { type: "array", items: { type: "string" } } },
    })
    expect("reject" in res2).toBe(true)
  })

  test("classifyProperty rejects non-string enum members", () => {
    expect("reject" in classifyProperty("c", { type: "string", enum: ["a", 1] })).toBe(true)
  })
})

describe("mcp elicitation — reply validation & coercion (5.2)", () => {
  test("enum answer validated against enum and coerced as string", () => {
    const fields = fieldSpecsFromSchema({ type: "object", properties: { c: { type: "string", enum: ["a", "b"] } } })
    expect(validateAndCoerce(fields, [["a"]])).toEqual({ c: "a" })
    // invalid selection → decline
    expect(validateAndCoerce(fields, [["z"]])).toBeUndefined()
    expect(validateAndCoerce(fields, [[]])).toBeUndefined()
  })

  test("boolean answer maps Yes→true, No→false", () => {
    const fields = fieldSpecsFromSchema({ type: "object", properties: { ok: { type: "boolean" } } })
    expect(validateAndCoerce(fields, [["Yes"]])).toEqual({ ok: true })
    expect(validateAndCoerce(fields, [["No"]])).toEqual({ ok: false })
    expect(validateAndCoerce(fields, [["Maybe"]])).toBeUndefined()
  })

  test("string answer coerced as-is", () => {
    const fields = fieldSpecsFromSchema({ type: "object", properties: { name: { type: "string" } } })
    expect(validateAndCoerce(fields, [["Ada"]])).toEqual({ name: "Ada" })
    expect(validateAndCoerce(fields, [[]])).toBeUndefined()
  })

  test("number/integer answers parsed and validated", () => {
    const fields = fieldSpecsFromSchema({
      type: "object",
      properties: { n: { type: "number" }, i: { type: "integer" } },
    })
    expect(validateAndCoerce(fields, [["42"], ["7"]])).toEqual({ n: 42, i: 7 })
    // non-numeric → decline
    expect(validateAndCoerce(fields, [["abc"], ["7"]])).toBeUndefined()
    // non-integer into the INTEGER field (i) → decline
    expect(validateAndCoerce(fields, [["7"], ["1.5"]])).toBeUndefined()
    // 1.5 is valid for the NUMBER field (n); 7 valid for integer field (i)
    expect(validateAndCoerce(fields, [["1.5"], ["7"]])).toEqual({ n: 1.5, i: 7 })
  })

  test("missing answer (empty) for required field → decline", () => {
    const fields = fieldSpecsFromSchema({ type: "object", properties: { c: { type: "string", enum: ["a"] } } })
    expect(validateAndCoerce(fields, [undefined as never])).toBeUndefined()
  })
})
