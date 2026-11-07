import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ProviderAdapters } from "@/provider/adapter/registry"
import type { ProviderAdapter } from "@/provider/adapter/types"
import type { Provider } from "@/provider/provider"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayerWith, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const projectOptions = { config: { formatter: false, lsp: false } }
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

const oauthResult = async () => ({
  url: oauthURL,
  method: "code" as const,
  instructions: oauthInstructions,
  callback: async () => ({ type: "success" as const, key: "token" }),
})

const zeroCost = (provider: Provider.Info) => {
  for (const model of Object.values(provider.models ?? {})) {
    ;(model as { cost: { input: number; output: number; cache: { read: number; write: number } } }).cost = {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    }
  }
}

const authAdapters: ProviderAdapter[] = [
  {
    id: "test.oauth-parity",
    auth: {
      provider: providerID,
      methods: [
        { type: "api", label: "API key" },
        { type: "oauth", label: "OAuth", authorize: oauthResult },
      ],
    },
  },
  {
    id: "test.oauth-validation",
    auth: {
      provider: "test-oauth-validation",
      methods: [
        {
          type: "oauth",
          label: "OAuth",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "Token",
              validate: (value: string) => (value === "ok" ? undefined : "Token must be ok"),
            },
          ],
          authorize: oauthResult,
        },
      ],
    },
  },
  {
    id: "test.google-auth-loader",
    auth: {
      provider: "google",
      loader: async (_getAuth, provider) => {
        zeroCost(provider)
        return { apiKey: "", fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }
      },
      methods: [{ type: "api", label: "API key" }],
    },
  },
  {
    id: "test.google-models",
    provider: {
      id: "google",
      models: async (provider) => {
        const models = Object.fromEntries(
          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),
        )
        provider.name = "mutated-provider"
        provider.options = { ...provider.options, mutatedByPlugin: true }
        zeroCost(provider)
        return models
      },
    },
  },
]

const adaptersLayer = Layer.succeed(
  ProviderAdapters.Service,
  ProviderAdapters.createRegistry(Effect.succeed<readonly ProviderAdapter[]>(authAdapters)),
)

const it = testEffect(
  Layer.mergeAll(testStateLayer, httpApiLayerWith([LayerNode.replace(ProviderAdapters.node, adaptersLayer)])),
)

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-opencode-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "GRAPHAGENT_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      expect(hasNonZeroModelCost(configBody, "providers", "google")).toBe(true)
    }),
    projectOptions,
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    projectOptions,
  )
})
