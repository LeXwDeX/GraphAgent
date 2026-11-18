// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ProviderRedact } from "@/provider/redact"

// The shape `models --verbose` prints: the fields after `options` and `headers` must come through unchanged.
const model = (extra: { options?: Record<string, unknown>; headers?: Record<string, string> } = {}) => ({
  id: "m",
  providerID: "relay",
  api: { id: "m", url: "https://api.example.com/v1", npm: "@ai-sdk/openai-compatible" },
  name: "M",
  limit: { context: 128_000, output: 8_192 },
  status: "active",
  options: extra.options ?? {},
  headers: extra.headers ?? {},
  release_date: "2026-01-01",
})

describe("ProviderRedact.isSecretKey", () => {
  test("matches names ending in key, token, secret, authorization or password, case-insensitively", () => {
    for (const name of ["apiKey", "x-api-key", "accessToken", "client_secret", "Authorization", "DB_PASSWORD"]) {
      expect({ name, secret: ProviderRedact.isSecretKey(name, "v") }).toEqual({ name, secret: true })
    }
  })

  test("does not match counters such as max_tokens, or other names", () => {
    for (const name of ["max_tokens", "maxTokens", "temperature", "keyboard", "x-trace-id"]) {
      expect({ name, secret: ProviderRedact.isSecretKey(name, "v") }).toEqual({ name, secret: false })
    }
  })

  test("only strings can be secrets", () => {
    expect(ProviderRedact.isSecretKey("apiKey", 1)).toBe(false)
    expect(ProviderRedact.isSecretKey("apiKey", true)).toBe(false)
    expect(ProviderRedact.isSecretKey("apiKey", { nested: "x" })).toBe(false)
    expect(ProviderRedact.isSecretKey("apiKey", undefined)).toBe(false)
  })
})

describe("ProviderRedact.redactModel", () => {
  test("replaces a string options.apiKey", () => {
    const out = ProviderRedact.redactModel(model({ options: { apiKey: "opt-secret" } }))
    expect(out.options).toEqual({ apiKey: ProviderRedact.REDACTED })
    expect(JSON.stringify(out)).not.toContain("opt-secret")
  })

  test("keeps the numeric options.max_tokens and options.maxTokens", () => {
    const out = ProviderRedact.redactModel(model({ options: { max_tokens: 4096, maxTokens: 2048, apiKey: "k" } }))
    expect(out.options).toEqual({ max_tokens: 4096, maxTokens: 2048, apiKey: ProviderRedact.REDACTED })
  })

  test("recurses into nested objects and arrays", () => {
    const out = ProviderRedact.redactModel(
      model({
        options: {
          auth: { accessToken: "nested-secret", scope: "read", timeout: 30 },
          list: [{ client_secret: "in-array" }, { name: "kept" }],
          flag: true,
        },
      }),
    )
    expect(out.options).toEqual({
      auth: { accessToken: ProviderRedact.REDACTED, scope: "read", timeout: 30 },
      list: [{ client_secret: ProviderRedact.REDACTED }, { name: "kept" }],
      flag: true,
    })
  })

  test("does not mask a non-string value under a secret-looking name", () => {
    const out = ProviderRedact.redactModel(model({ options: { tokenKey: 7, secret: false } }))
    expect(out.options).toEqual({ tokenKey: 7, secret: false })
  })

  test("replaces every header value and keeps the header names", () => {
    const out = ProviderRedact.redactModel(
      model({ headers: { Authorization: "Bearer header-secret", "X-Org": "acme", "x-api-key": "k2" } }),
    )
    expect(out.headers).toEqual({
      Authorization: ProviderRedact.REDACTED,
      "X-Org": ProviderRedact.REDACTED,
      "x-api-key": ProviderRedact.REDACTED,
    })
  })

  test("leaves every other field and the key order unchanged", () => {
    const input = model({ options: { apiKey: "k", max_tokens: 1 }, headers: { Authorization: "Bearer x" } })
    const out = ProviderRedact.redactModel(input)
    expect(Object.keys(out)).toEqual(Object.keys(input))
    expect(JSON.stringify({ ...out, options: undefined, headers: undefined })).toBe(
      JSON.stringify({ ...input, options: undefined, headers: undefined }),
    )
    expect(Object.keys(out.options)).toEqual(Object.keys(input.options))
  })

  test("does not modify its input and returns a copy", () => {
    const input = model({
      options: { apiKey: "keep-original", nested: { accessToken: "keep-original-2" } },
      headers: { Authorization: "Bearer keep-original-3" },
    })
    const before = structuredClone(input)
    const out = ProviderRedact.redactModel(input)
    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(out.options).not.toBe(input.options)
    expect(out.headers).not.toBe(input.headers)
  })

  test("a model without options or headers stays without them", () => {
    const out = ProviderRedact.redactModel({ id: "m" })
    expect(out).toEqual({ id: "m" })
    expect("options" in out).toBe(false)
    expect("headers" in out).toBe(false)
  })
})
