// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ProviderErrorClass } from "@/provider/error-class"

const facts = (input: {
  status?: number
  names?: string[]
  text?: string
  temporary?: boolean
}): ProviderErrorClass.ErrorFacts => ({
  ...(input.status === undefined ? {} : { status: input.status }),
  names: input.names ?? [],
  text: input.text ?? "",
  temporary: input.temporary ?? false,
})

/** Index of the first row the facts reach, ignoring the transient skip. */
const rowOf = (input: ProviderErrorClass.ErrorFacts) =>
  ProviderErrorClass.ROWS.findIndex((row) => ProviderErrorClass.rowMatches(row, input))

describe("ProviderErrorClass.ROWS", () => {
  test("has eleven rows in the documented order", () => {
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
      "rate_limited",
      "quota_exhausted",
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
    {
      row: 10,
      cls: "rate_limited",
      facts: facts({
        status: 429,
        names: ["quotaexceeded"],
        text: "Quota exceeded for requests per minute. Please retry in 20 seconds.",
        temporary: true,
      }),
    },
    {
      row: 11,
      cls: "quota_exhausted",
      facts: facts({ status: 429, names: ["quotaexceeded"], text: "Quota exceeded. Please top up your account." }),
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

  test("the native QuotaExceeded tag alone is not proof of a spent balance", () => {
    const names = ["quotaexceeded"]
    // The native runtime tags every "quota exceeded" 429 this way, a full per-minute window included.
    expect(
      ProviderErrorClass.match(
        facts({ names, text: "Quota exceeded for requests per minute", temporary: true }),
        false,
      ),
    ).toBe("rate_limited")
    expect(ProviderErrorClass.match(facts({ names, text: "Quota exceeded" }), false)).toBe("quota_exhausted")
    // The tag rows come last: a provider code that names a spent balance outranks the tag and the wording.
    expect(
      ProviderErrorClass.match(
        facts({ names: [...names, "insufficient_quota"], text: "You exceeded your current quota", temporary: true }),
        false,
      ),
    ).toBe("quota_exhausted")
  })

  test("a row that writes temporary needs the facts to agree", () => {
    const weak = ProviderErrorClass.ROWS.filter((row) => row.names?.includes("quotaexceeded"))
    expect(weak.map((row) => row.temporary)).toEqual([true, false])
    const [windowed, spent] = weak
    const open = facts({ names: ["quotaexceeded"], temporary: true })
    const closed = facts({ names: ["quotaexceeded"], temporary: false })
    expect(ProviderErrorClass.rowMatches(windowed, open)).toBe(true)
    expect(ProviderErrorClass.rowMatches(windowed, closed)).toBe(false)
    expect(ProviderErrorClass.rowMatches(spent, open)).toBe(false)
    expect(ProviderErrorClass.rowMatches(spent, closed)).toBe(true)
    // A row that says nothing about it ignores the fact.
    const row = ProviderErrorClass.ROWS[1]
    expect(row.temporary).toBeUndefined()
    expect(ProviderErrorClass.rowMatches(row, facts({ names: ["insufficient_quota"], temporary: true }))).toBe(true)
  })

  test.each([
    "insufficient_quota",
    "credit_balance_exhausted",
    "exceeded_current_quota_error",
    "enforced_spend_limit_reached",
    "arrearage",
    "allocationquota.freetieronly",
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
    ).toEqual({ status: 429, names: ["quotaexceeded", "billing"], text: "boom\n", temporary: false })
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

describe("ProviderErrorClass.factsOf temporary", () => {
  const data = (input: Partial<Parameters<typeof ProviderErrorClass.factsOf>[0]> = {}) => ({
    message: "boom",
    isRetryable: false,
    ...input,
  })

  test.each([
    "Quota exceeded for requests per minute. Please retry in 20 seconds.",
    "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'request limit per minute'",
    "Rate limit reached for gpt-4 on requests per min (RPM): Limit 3, Used 3. Please try again in 20s.",
    "Requests have exceeded the token rate limit of your current pricing tier. Please retry after 86400 seconds.",
    "Quota exceeded: 5 requests per day",
    "Quota exceeded: 100 requests per hour",
    "Quota exceeded: 2 requests per-second",
    "Too many requests",
    "rate_limit_exceeded",
    "Requests are being throttled",
    "Please wait 30 seconds before the next request",
    "Daily TPM limit",
    "Retry-After: 20",
  ])("reads %s as a limit that lifts by itself", (message) => {
    expect(ProviderErrorClass.factsOf(data({ message })).temporary).toBe(true)
  })

  test.each([
    "Quota exceeded.",
    "Quota exceeded. Please top up your account.",
    "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    "Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits.",
    "Provider request failed with HTTP 429: Quota exceeded",
    "Insufficient balance, please recharge and retry",
    "余额不足，请充值",
    "Access denied, please make sure your account is in good standing.",
  ])("does not read %s as a limit that lifts by itself", (message) => {
    expect(ProviderErrorClass.factsOf(data({ message })).temporary).toBe(false)
  })

  test("reads the retry hint Google keeps in the error details", () => {
    const responseBody = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" }],
      },
    })
    expect(ProviderErrorClass.factsOf(data({ responseBody })).temporary).toBe(true)
  })

  test("reads a retry-after header as a temporary limit, whatever the wording", () => {
    const headerSets: Array<Record<string, string>> = [
      { "retry-after": "20" },
      { "Retry-After": "20" },
      { "retry-after-ms": "1500" },
    ]
    for (const responseHeaders of headerSets) {
      expect(ProviderErrorClass.factsOf(data({ message: "Quota exceeded.", responseHeaders })).temporary).toBe(true)
    }
    const other = { "x-request-id": "req_1", "content-type": "application/json" }
    expect(ProviderErrorClass.factsOf(data({ message: "Quota exceeded.", responseHeaders: other })).temporary).toBe(
      false,
    )
  })

  test("does not take the HTTP status the native message names for a retry signal", () => {
    const message = "Provider request failed with HTTP 429: Quota exceeded"
    expect(
      ProviderErrorClass.factsOf(data({ message, statusCode: 429, responseBody: "Quota exceeded" })).temporary,
    ).toBe(false)
  })
})

// The 429 bodies of `packages/llm/test/executor.test.ts` (#1578), which asserts how the native executor reads each one:
// the spent balances as `QuotaExceeded`, tried once, and the windowed allocations as `RateLimit`, retried. Keep the two
// lists in step, so that the executor and this table agree on every body.
describe("ProviderErrorClass on the 429 bodies the native executor classifies", () => {
  const spentBalances: ReadonlyArray<readonly [name: string, body: string]> = [
    [
      "credit_balance_exhausted",
      '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is exhausted."}}',
    ],
    [
      "exceeded_current_quota_error",
      '{"error":{"code":"exceeded_current_quota_error","message":"You exceeded your current quota, please check your plan and billing details."}}',
    ],
    [
      "enforced_spend_limit_reached",
      '{"error":{"code":"enforced_spend_limit_reached","message":"The spend limit for this workspace has been reached."}}',
    ],
    [
      "arrearage",
      '{"error":{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}}',
    ],
    [
      "allocationquota.freetieronly",
      '{"error":{"code":"AllocationQuota.FreeTierOnly","message":"The free tier of the model has been exhausted."}}',
    ],
    [
      "free allocated quota exceeded",
      '{"error":{"message":"The Free Allocated Quota Exceeded, please purchase a plan."}}',
    ],
    [
      "insufficient_quota",
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
    ],
  ]

  const windowedAllocations: ReadonlyArray<readonly [name: string, body: string]> = [
    [
      "insufficient_quota",
      '{"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"Allocated quota exceeded, please increase your quota limit."}}',
    ],
    [
      "Throttling.AllocationQuota",
      '{"error":{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded, please increase your quota limit."}}',
    ],
    [
      "the phrase in capitals",
      '{"error":{"code":"Throttling.AllocationQuota","message":"ALLOCATED QUOTA EXCEEDED, PLEASE INCREASE YOUR QUOTA LIMIT."}}',
    ],
  ]

  // What the native runtime stores for such an error: the message names the HTTP status, the reason's tag rides in
  // `metadata.code`, and only a `RateLimit` is flagged retryable.
  const stored = (
    body: string,
    tag: "QuotaExceeded" | "RateLimit",
  ): Parameters<typeof ProviderErrorClass.factsOf>[0] => ({
    message: `Provider request failed with HTTP 429: ${body}`,
    statusCode: 429,
    isRetryable: tag === "RateLimit",
    responseBody: body,
    metadata: { code: tag },
  })

  test.each(spentBalances)("reads %s as a spent balance", (_name, body) => {
    const facts = ProviderErrorClass.factsOf(stored(body, "QuotaExceeded"))
    expect(ProviderErrorClass.match(facts, false)).toBe("quota_exhausted")
  })

  test.each(windowedAllocations)(
    "reads the 429 asking to increase the quota limit (%s) as a rate limit",
    (_name, body) => {
      const facts = ProviderErrorClass.factsOf(stored(body, "RateLimit"))
      expect(ProviderErrorClass.match(facts, false)).toBe("rate_limited")
    },
  )

  test("reads the bodies the same way when no native tag rides along", () => {
    const untagged = (body: string) =>
      ProviderErrorClass.match(
        ProviderErrorClass.factsOf({ message: "boom", isRetryable: false, statusCode: 429, responseBody: body }),
        false,
      )
    for (const [, body] of spentBalances) expect(untagged(body)).toBe("quota_exhausted")
    for (const [, body] of windowedAllocations) expect(untagged(body)).toBe("rate_limited")
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
