// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ProviderErrorClass } from "@/provider/error-class"

const facts = (input: { status?: number; names?: string[]; text?: string }): ProviderErrorClass.ErrorFacts => ({
  ...(input.status === undefined ? {} : { status: input.status }),
  names: input.names ?? [],
  text: input.text ?? "",
})

/** Index of the first row the facts reach, ignoring the transient skip. */
const rowOf = (input: ProviderErrorClass.ErrorFacts) =>
  ProviderErrorClass.ROWS.findIndex((row) => ProviderErrorClass.rowMatches(row, input))

describe("ProviderErrorClass.ROWS", () => {
  test("has nine rows in the documented order", () => {
    expect(ProviderErrorClass.ROWS.map((row) => row.cls)).toEqual([
      "rate_limited",
      "quota_exhausted",
      "quota_exhausted",
      "quota_exhausted",
      "quota_exhausted",
      "quota_exhausted",
      "content_refused",
      "invalid_request",
      "invalid_request",
    ])
  })

  // One example per row. `row` is the 1-based position in the table; each example must reach exactly that row first.
  const examples: ReadonlyArray<{
    row: number
    cls: ProviderErrorClass.ErrorClass
    facts: ProviderErrorClass.ErrorFacts
  }> = [
    {
      row: 1,
      cls: "rate_limited",
      facts: facts({
        status: 429,
        names: ["insufficient_quota"],
        text: "Allocated quota exceeded, please increase your quota limit.",
      }),
    },
    {
      row: 2,
      cls: "quota_exhausted",
      facts: facts({
        status: 429,
        names: ["insufficient_quota"],
        text: "You exceeded your current quota, please check your plan and billing details.",
      }),
    },
    { row: 3, cls: "quota_exhausted", facts: facts({ status: 402, text: "Payment Required" }) },
    {
      row: 4,
      cls: "quota_exhausted",
      facts: facts({ status: 429, text: "The free allocated quota exceeded, please purchase a plan." }),
    },
    {
      row: 5,
      cls: "quota_exhausted",
      facts: facts({ status: 429, names: ["1113"], text: "您的账户已欠费，请充值后重试。" }),
    },
    {
      row: 6,
      cls: "quota_exhausted",
      facts: facts({ status: 429, names: ["1308"], text: "已达到 5 小时的使用上限。" }),
    },
    {
      row: 7,
      cls: "content_refused",
      facts: facts({
        status: 400,
        names: ["data_inspection_failed"],
        text: "Input data may contain inappropriate content.",
      }),
    },
    {
      row: 8,
      cls: "invalid_request",
      facts: facts({ status: 400, names: ["invalid_request_error"], text: "messages: field required" }),
    },
    {
      row: 9,
      cls: "invalid_request",
      facts: facts({ names: ["invalid_prompt"], text: "Invalid prompt: your prompt was flagged." }),
    },
  ]

  for (const example of examples) {
    test(`row ${example.row} classifies as ${example.cls}`, () => {
      expect(rowOf(example.facts)).toBe(example.row - 1)
      expect(ProviderErrorClass.match(example.facts, false)).toBe(example.cls)
    })
  }

  test("the per-minute allocation of row 1 outranks the balance names of row 2", () => {
    const names = ["insufficient_quota"]
    expect(ProviderErrorClass.match(facts({ names, text: "please increase your quota limit" }), false)).toBe(
      "rate_limited",
    )
    expect(ProviderErrorClass.match(facts({ names, text: "You exceeded your current quota" }), false)).toBe(
      "quota_exhausted",
    )
    expect(
      ProviderErrorClass.match(
        facts({
          names: ["throttling.allocationquota"],
          text: "Allocated quota exceeded, please increase your quota limit.",
        }),
        false,
      ),
    ).toBe("rate_limited")
    // The row needs the phrase as well as the name.
    expect(
      ProviderErrorClass.match(facts({ names: ["throttling.allocationquota"], text: "Slow down" }), false),
    ).toBeUndefined()
  })

  test.each([
    "insufficient_quota",
    "credit_balance_exhausted",
    "exceeded_current_quota_error",
    "enforced_spend_limit_reached",
    "arrearage",
    "allocationquota.freetieronly",
    "quotaexceeded",
  ])("row 2 recognises the name %s", (name) => {
    expect(rowOf(facts({ names: [name], text: "denied" }))).toBe(1)
  })

  test.each(["content_filter", "data_inspection_failed", "datainspectionfailed", "contentpolicy"])(
    "row 7 recognises the name %s",
    (name) => {
      expect(rowOf(facts({ names: [name] }))).toBe(6)
    },
  )

  test.each(["1308", "1309", "1310", "1316", "1317"])(
    "row 6 recognises the Zhipu code %s with a limit message",
    (code) => {
      expect(rowOf(facts({ names: [code], text: "已达到使用上限" }))).toBe(5)
      expect(rowOf(facts({ names: [code], text: "套餐已到期" }))).toBe(5)
    },
  )

  test("rows that name fields need every field to hit", () => {
    // Row 5: the code alone, or the phrase alone, is not enough.
    expect(ProviderErrorClass.match(facts({ names: ["1113"], text: "denied" }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ text: "账户已欠费" }), false)).toBeUndefined()
    // Row 6: same.
    expect(ProviderErrorClass.match(facts({ names: ["1308"], text: "denied" }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ text: "已达到使用上限" }), false)).toBeUndefined()
    // A neighbouring Zhipu code is not in the row.
    expect(ProviderErrorClass.match(facts({ names: ["1305"], text: "已达到使用上限" }), false)).toBeUndefined()
  })

  test("row 8 needs both a 400 or 422 status and an invalid-request name", () => {
    const names = ["invalid_request_error"]
    expect(ProviderErrorClass.match(facts({ status: 400, names }), false)).toBe("invalid_request")
    expect(ProviderErrorClass.match(facts({ status: 422, names }), false)).toBe("invalid_request")
    expect(ProviderErrorClass.match(facts({ status: 404, names }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ names }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ status: 400, names: ["something_else"] }), false)).toBeUndefined()
    for (const name of ["invalid_parameter_error", "invalid_parameter", "invalidparameter", "invalid_argument"]) {
      expect(ProviderErrorClass.match(facts({ status: 400, names: [name] }), false)).toBe("invalid_request")
    }
  })

  test("a transient signal skips the invalid_request rows and nothing else", () => {
    const invalid = facts({ status: 400, names: ["invalid_request_error"] })
    const prompt = facts({ names: ["invalid_prompt"] })
    expect(ProviderErrorClass.match(invalid, true)).toBeUndefined()
    expect(ProviderErrorClass.match(prompt, true)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ status: 402 }), true)).toBe("quota_exhausted")
    expect(ProviderErrorClass.match(facts({ names: ["content_filter"] }), true)).toBe("content_refused")
  })

  test("matches nothing for an error no row names", () => {
    expect(ProviderErrorClass.match(facts({ status: 500, text: "Internal server error" }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({ status: 429, text: "Rate limit reached" }), false)).toBeUndefined()
    expect(ProviderErrorClass.match(facts({}), false)).toBeUndefined()
  })
})

describe("ProviderErrorClass.factsOf", () => {
  const data = (input: Partial<Parameters<typeof ProviderErrorClass.factsOf>[0]> = {}) => ({
    message: "boom",
    isRetryable: false,
    ...input,
  })

  test("reads the status and the metadata names", () => {
    expect(
      ProviderErrorClass.factsOf(
        data({ statusCode: 429, metadata: { code: "QuotaExceeded", type: "Billing", url: "x" } }),
      ),
    ).toEqual({ status: 429, names: ["quotaexceeded", "billing"], text: "boom\n" })
  })

  test("reads the names a JSON body carries, lower-cased and de-duplicated", () => {
    const body = JSON.stringify({
      code: "TopLevel",
      type: "error",
      error: {
        code: "Insufficient_Quota",
        type: "insufficient_quota",
        status: "RESOURCE_EXHAUSTED",
        details: { error_code: "ARREARAGE" },
        message: "ignored",
      },
    })
    const result = ProviderErrorClass.factsOf(data({ responseBody: body, metadata: { code: "insufficient_QUOTA" } }))
    expect(result.names).toEqual(["insufficient_quota", "resource_exhausted", "arrearage", "toplevel", "error"])
  })

  test("takes a numeric error code from the body, which metadata cannot carry", () => {
    const result = ProviderErrorClass.factsOf(
      data({ message: "已达到 5 小时的使用上限", responseBody: '{"error":{"code":1308,"message":"limit"}}' }),
    )
    expect(result.names).toEqual(["1308"])
    expect(result.text).toBe('已达到 5 小时的使用上限\n{"error":{"code":1308,"message":"limit"}}')
  })

  test("reads the error_code under error.details", () => {
    const result = ProviderErrorClass.factsOf(
      data({ responseBody: JSON.stringify({ error: { details: { error_code: "ENFORCED_SPEND_LIMIT_REACHED" } } }) }),
    )
    expect(result.names).toEqual(["enforced_spend_limit_reached"])
  })

  test("survives a body that is not JSON, or not an object", () => {
    for (const responseBody of ["<html>Bad gateway</html>", "", "null", "42", '"text"', "[1,2]", '{"error":"plain"}']) {
      const result = ProviderErrorClass.factsOf(
        data({ statusCode: 502, responseBody, metadata: { code: "ZlibError" } }),
      )
      expect(result.names).toEqual(["zliberror"])
      expect(result.status).toBe(502)
      expect(result.text.startsWith("boom\n")).toBe(true)
    }
  })

  test("ignores body values that are neither strings nor numbers", () => {
    const body = JSON.stringify({ code: { nested: true }, type: null, error: { code: false, type: ["a"], status: "" } })
    expect(ProviderErrorClass.factsOf(data({ responseBody: body })).names).toEqual([])
  })

  test("leaves the status out when the error had none", () => {
    expect("status" in ProviderErrorClass.factsOf(data())).toBe(false)
  })

  test("bounds the text to 4000 characters", () => {
    const result = ProviderErrorClass.factsOf(data({ message: "m".repeat(3_000), responseBody: "b".repeat(3_000) }))
    expect(result.text).toHaveLength(4_000)
    expect(result.text.startsWith("m".repeat(3_000) + "\n")).toBe(true)
  })
})

describe("ProviderErrorClass.hintOf", () => {
  test("names the provider and the way out for an exhausted quota", () => {
    expect(ProviderErrorClass.hintOf("quota_exhausted", "zhipuai")).toBe(
      'Provider "zhipuai": quota or balance used up, so resending cannot succeed. Top up or switch model.',
    )
  })

  test("points rejected credentials at the login command", () => {
    expect(ProviderErrorClass.hintOf("auth", "anthropic")).toBe(
      'Provider "anthropic" rejected the credentials. Run `graphagent providers login --provider anthropic`.',
    )
  })

  test("tells the user how to get past a content refusal", () => {
    expect(ProviderErrorClass.hintOf("content_refused", "anything")).toBe(
      "The provider's content filter rejected this conversation. Rephrase the last message or start a new session.",
    )
  })

  test.each(["rate_limited", "context_overflow", "invalid_request", "transient"] as const)(
    "has no hint for %s",
    (cls) => {
      expect(ProviderErrorClass.hintOf(cls, "test")).toBeUndefined()
    },
  )
})
