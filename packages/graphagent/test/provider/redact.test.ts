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

  test("masks a headers object nested under options whole, wherever it sits", () => {
    const out = ProviderRedact.redactModel(
      model({
        options: {
          headers: { "X-Org": "acme", Authorization: "Bearer nested-secret", retries: 3 },
          transport: { Headers: { "X-Trace": "t-1" }, timeout: 30 },
        },
      }),
    )
    expect(out.options).toEqual({
      headers: {
        "X-Org": ProviderRedact.REDACTED,
        Authorization: ProviderRedact.REDACTED,
        retries: ProviderRedact.REDACTED,
      },
      transport: { Headers: { "X-Trace": ProviderRedact.REDACTED }, timeout: 30 },
    })
  })

  test("searches the variants for credentials like options", () => {
    const out = ProviderRedact.redactModel({
      ...model(),
      variants: { high: { reasoningEffort: "high", thinking: { budgetTokens: 4096 }, apiKey: "variant-secret" } },
    })
    expect(out.variants).toEqual({
      high: { reasoningEffort: "high", thinking: { budgetTokens: 4096 }, apiKey: ProviderRedact.REDACTED },
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

// The shape the server reports for a provider (`Provider.Info`).
type ProviderShape = {
  id: string
  name: string
  source: string
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, unknown>
}

const provider = (extra: Partial<ProviderShape> = {}): ProviderShape => ({
  id: "relay",
  name: "Relay",
  source: "config",
  env: ["RELAY_API_KEY"],
  options: {},
  models: {},
  ...extra,
})

describe("ProviderRedact.redactProvider", () => {
  test("replaces the key of the provider and keeps it a string", () => {
    const out = ProviderRedact.redactProvider(provider({ key: "provider-key-secret" }))
    expect(out.key).toBe(ProviderRedact.REDACTED)
    expect(JSON.stringify(out)).not.toContain("provider-key-secret")
  })

  test("replaces options.apiKey, and a credential-looking string at any depth under options", () => {
    const out = ProviderRedact.redactProvider(
      provider({
        options: {
          apiKey: "opt-secret",
          baseURL: "https://api.example.com/v1",
          timeout: 600000,
          setCacheKey: true,
          auth: { token: "nested-token", client_secret: "nested-secret", region: "eu" },
        },
      }),
    )
    expect(out.options).toEqual({
      apiKey: ProviderRedact.REDACTED,
      baseURL: "https://api.example.com/v1",
      timeout: 600000,
      setCacheKey: true,
      auth: { token: ProviderRedact.REDACTED, client_secret: ProviderRedact.REDACTED, region: "eu" },
    })
    expect(JSON.stringify(out)).not.toMatch(/opt-secret|nested-token|nested-secret/)
  })

  test("masks every value of options.headers, not only Authorization", () => {
    const out = ProviderRedact.redactProvider(
      provider({ options: { headers: { Authorization: "Bearer h-secret", "X-Org": "acme", Cookie: "sid=abc" } } }),
    )
    expect(out.options).toEqual({
      headers: {
        Authorization: ProviderRedact.REDACTED,
        "X-Org": ProviderRedact.REDACTED,
        Cookie: ProviderRedact.REDACTED,
      },
    })
  })

  test("redacts each model as redactModel does", () => {
    const out = ProviderRedact.redactProvider(
      provider({
        models: {
          "m-1": model({
            options: { apiKey: "model-secret", max_tokens: 4096 },
            headers: { "x-api-key": "model-header" },
          }),
          "m-2": { ...model(), variants: { low: { accessToken: "variant-secret" } } },
        },
      }),
    )
    expect(out.models).toEqual({
      "m-1": model({
        options: { apiKey: ProviderRedact.REDACTED, max_tokens: 4096 },
        headers: { "x-api-key": ProviderRedact.REDACTED },
      }),
      "m-2": { ...model(), variants: { low: { accessToken: ProviderRedact.REDACTED } } },
    })
    expect(JSON.stringify(out)).not.toMatch(/model-secret|model-header|variant-secret/)
  })

  test("keeps the env variable names, the other fields and the key order", () => {
    const input = provider({ key: "k", options: { apiKey: "a" }, models: { "m-1": model() } })
    const out = ProviderRedact.redactProvider(input)
    expect(Object.keys(out)).toEqual(Object.keys(input))
    expect(out.env).toEqual(["RELAY_API_KEY"])
    expect({ ...out, key: undefined, options: undefined }).toEqual({ ...input, key: undefined, options: undefined })
  })

  test("a provider without key, options or models stays without them", () => {
    const out = ProviderRedact.redactProvider({ id: "relay" })
    expect(out).toEqual({ id: "relay" })
    expect(Object.keys(out)).toEqual(["id"])
  })

  test("does not modify its input and returns a copy", () => {
    const input = provider({
      key: "keep-original",
      options: { apiKey: "keep-original-2", headers: { Authorization: "keep-original-3" } },
      models: { "m-1": model({ options: { apiKey: "keep-original-4" } }) },
    })
    const before = structuredClone(input)
    const out = ProviderRedact.redactProvider(input)
    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(out.options).not.toBe(input.options)
    expect(out.models).not.toBe(input.models)
  })
})

describe("ProviderRedact.redactConfig", () => {
  test("replaces provider.<id>.options.apiKey and keeps the other options", () => {
    const out = ProviderRedact.redactConfig({
      provider: {
        relay: { options: { apiKey: "config-secret", baseURL: "https://api.example.com/v1", timeout: 600000 } },
        other: { options: { apiKey: "other-secret" } },
      },
    })
    expect(out).toEqual({
      provider: {
        relay: { options: { apiKey: ProviderRedact.REDACTED, baseURL: "https://api.example.com/v1", timeout: 600000 } },
        other: { options: { apiKey: ProviderRedact.REDACTED } },
      },
    })
    expect(JSON.stringify(out)).not.toMatch(/config-secret|other-secret/)
  })

  test("replaces api_key, token, secret, password and the Authorization header under provider options", () => {
    const out = ProviderRedact.redactConfig({
      provider: {
        relay: {
          options: {
            api_key: "s1",
            token: "s2",
            secret: "s3",
            password: "s4",
            headers: { Authorization: "Bearer s5", "X-Org": "acme" },
          },
        },
      },
    })
    expect(out.provider.relay.options).toEqual({
      api_key: ProviderRedact.REDACTED,
      token: ProviderRedact.REDACTED,
      secret: ProviderRedact.REDACTED,
      password: ProviderRedact.REDACTED,
      headers: { Authorization: ProviderRedact.REDACTED, "X-Org": ProviderRedact.REDACTED },
    })
  })

  test("replaces the options, headers and variants of a provider model", () => {
    const out = ProviderRedact.redactConfig({
      provider: {
        relay: {
          models: {
            "m-1": {
              name: "M",
              options: { apiKey: "model-secret", reasoningEffort: "high" },
              headers: { "x-api-key": "model-header", "X-Org": "acme" },
              variants: { high: { accessToken: "variant-secret", reasoningEffort: "high" } },
            },
          },
        },
      },
    })
    expect(out.provider.relay.models["m-1"]).toEqual({
      name: "M",
      options: { apiKey: ProviderRedact.REDACTED, reasoningEffort: "high" },
      headers: { "x-api-key": ProviderRedact.REDACTED, "X-Org": ProviderRedact.REDACTED },
      variants: { high: { accessToken: ProviderRedact.REDACTED, reasoningEffort: "high" } },
    })
  })

  test("replaces credential-looking names in lsp env and initialization, and in formatter environment", () => {
    const out = ProviderRedact.redactConfig({
      lsp: {
        custom: {
          command: ["srv"],
          extensions: [".x"],
          env: { REGISTRY_TOKEN: "lsp-secret", PATH: "/bin" },
          initialization: { apiKey: "init-secret", mode: "fast" },
        },
        off: { disabled: true },
      },
      formatter: { fmt: { command: ["fmt"], environment: { FMT_PASSWORD: "fmt-secret", LANG: "C" } } },
    })
    expect(out).toEqual({
      lsp: {
        custom: {
          command: ["srv"],
          extensions: [".x"],
          env: { REGISTRY_TOKEN: ProviderRedact.REDACTED, PATH: "/bin" },
          initialization: { apiKey: ProviderRedact.REDACTED, mode: "fast" },
        },
        off: { disabled: true },
      },
      formatter: { fmt: { command: ["fmt"], environment: { FMT_PASSWORD: ProviderRedact.REDACTED, LANG: "C" } } },
    })
  })

  test("leaves permission rules and every other section as they are, even when a rule ends in key or token", () => {
    const input = {
      username: "dev",
      model: "relay/m-1",
      permission: { read: { "*.key": "deny", "secrets/*token": "ask", "*": "allow" } },
      permissions: [{ permission: "read", pattern: "*.secret", action: "deny" }],
      tools: { mcp_key: false },
      command: { rotate: { template: "rotate the key" } },
      disabled_providers: ["a-token"],
    }
    expect(ProviderRedact.redactConfig(input)).toEqual(input)
  })

  test("keeps a boolean lsp or formatter section and a configuration without sections", () => {
    expect(ProviderRedact.redactConfig({ lsp: false, formatter: true })).toEqual({ lsp: false, formatter: true })
    expect(ProviderRedact.redactConfig({})).toEqual({})
  })

  test("keeps the key order and does not modify its input", () => {
    const input = {
      model: "relay/m-1",
      provider: { relay: { name: "Relay", options: { apiKey: "keep-original" }, models: {} } },
      username: "dev",
    }
    const before = structuredClone(input)
    const out = ProviderRedact.redactConfig(input)
    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(Object.keys(out)).toEqual(["model", "provider", "username"])
    expect(Object.keys(out.provider.relay)).toEqual(["name", "options", "models"])
  })
})
