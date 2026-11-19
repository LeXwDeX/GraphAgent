// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ProviderRedact } from "@/provider/redact"
import { isRecord } from "@/util/record"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

// #1553: a configuration written with `{env:}` references is resolved by the time it is read, and the provider list
// carries the key of a provider. None of the four read endpoints may send those values to a client. Every value here
// is made up; no real credential is read.
const providerID = "redaction-probe"
const envName = "GRAPHAGENT_TEST_REDACTION_SECRET"
const envSecret = "fake-env-secret-1553"
const storedKey = "fake-stored-key-1553"
const baseURL = "https://api.example.com/v1"
const REDACTED = ProviderRedact.REDACTED

const previousSecret = process.env[envName]
const previousConfigDir = process.env.GRAPHAGENT_TEST_CONFIG_DIR
const configDir = path.join(os.tmpdir(), `graphagent-secret-redaction-${process.pid}`)
process.env[envName] = envSecret
process.env.GRAPHAGENT_TEST_CONFIG_DIR = configDir

const reference = `{env:${envName}}`

const probeProvider = {
  id: providerID,
  name: "Redaction Probe",
  env: [],
  npm: "@ai-sdk/openai-compatible",
  options: {
    apiKey: reference,
    baseURL,
    headers: { Authorization: `Bearer ${reference}`, "X-Org": "acme" },
  },
  models: {
    "probe-model": {
      id: "probe-model",
      name: "Probe Model",
      tool_call: true,
      limit: { context: 100000, output: 10000 },
      headers: { "x-api-key": reference },
      options: { apiKey: reference, reasoningEffort: "high" },
    },
  },
}

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))

beforeEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
})

afterAll(async () => {
  if (previousSecret === undefined) delete process.env[envName]
  else process.env[envName] = previousSecret
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
  else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

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

function field(input: unknown, ...names: string[]): unknown {
  let value = input
  for (const name of names) value = isRecord(value) ? value[name] : undefined
  return value
}

function providerOf(input: unknown, key: "all" | "providers", id: string) {
  const list = field(input, key)
  return Array.isArray(list) ? list.find((item) => isRecord(item) && item.id === id) : undefined
}

// The body of a successful read, as text and parsed, after checking that neither made-up secret is in it.
function readClean(path: string, headers?: HeadersInit) {
  return Effect.gen(function* () {
    const response = yield* request(path, { headers })
    expect(response.status).toBe(200)
    const text = yield* response.text
    expect(text).not.toContain(envSecret)
    expect(text).not.toContain(storedKey)
    return JSON.parse(text) as unknown
  })
}

describe("secret redaction on the read endpoints", () => {
  it.instance(
    "GET /config shows the options of a provider without the resolved apiKey and headers",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const body = yield* readClean("/config", { "x-graphagent-directory": directory })

      const options = field(body, "provider", providerID, "options")
      expect(field(options, "apiKey")).toBe(REDACTED)
      expect(field(options, "baseURL")).toBe(baseURL)
      expect(field(options, "headers")).toEqual({ Authorization: REDACTED, "X-Org": REDACTED })
      const model = field(body, "provider", providerID, "models", "probe-model")
      expect(field(model, "headers")).toEqual({ "x-api-key": REDACTED })
      expect(field(model, "options")).toEqual({ apiKey: REDACTED, reasoningEffort: "high" })
    }),
    { config: { formatter: false, lsp: false, provider: { [providerID]: probeProvider } } },
    30000,
  )

  it.instance(
    "GET /config/providers and GET /provider show a provider without its resolved credentials",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("GRAPHAGENT_AUTH_CONTENT", JSON.stringify({ google: { type: "api", key: storedKey } }))
      const headers = { "x-graphagent-directory": directory }
      const catalog = yield* readClean("/config/providers", headers)
      const list = yield* readClean("/provider", headers)

      for (const [body, key] of [
        [catalog, "providers"],
        [list, "all"],
      ] as const) {
        const probe = providerOf(body, key, providerID)
        expect(field(probe, "options", "apiKey")).toBe(REDACTED)
        expect(field(probe, "options", "baseURL")).toBe(baseURL)
        expect(field(probe, "options", "headers")).toEqual({ Authorization: REDACTED, "X-Org": REDACTED })
        const model = field(probe, "models", "probe-model")
        expect(field(model, "name")).toBe("Probe Model")
        expect(field(model, "headers")).toEqual({ "x-api-key": REDACTED })
        expect(field(model, "options", "apiKey")).toBe(REDACTED)
        expect(field(model, "options", "reasoningEffort")).toBe("high")

        // The key of a provider, from the credential store, is masked too.
        expect(field(providerOf(body, key, "google"), "key")).toBe(REDACTED)
      }
      // What the list says about connection and default models is untouched.
      expect(field(list, "connected")).toContain(providerID)
      expect(field(list, "connected")).toContain("google")
      expect(field(list, "default", providerID)).toBe("probe-model")
      expect(field(catalog, "default", providerID)).toBe("probe-model")
    }),
    { config: { formatter: false, lsp: false, provider: { [providerID]: probeProvider } } },
    30000,
  )

  it.live(
    "GET /global/config shows the options of a provider without the resolved apiKey and headers",
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(configDir, "graphagent.jsonc"),
          JSON.stringify({ provider: { [providerID]: probeProvider } }),
        ),
      )
      const body = yield* readClean("/global/config")

      const options = field(body, "provider", providerID, "options")
      expect(field(options, "apiKey")).toBe(REDACTED)
      expect(field(options, "baseURL")).toBe(baseURL)
      expect(field(options, "headers")).toEqual({ Authorization: REDACTED, "X-Org": REDACTED })
    }),
  )
})
