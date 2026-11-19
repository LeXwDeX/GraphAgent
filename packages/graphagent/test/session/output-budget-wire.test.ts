// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"
import { Effect, Layer, Stream } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { LLMRequest } from "@graphagent/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@graphagent/llm/route"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { prepare } from "../../src/session/llm/request"
import { LLMNativeRuntime } from "../../src/session/llm/native-runtime"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// The Anthropic Messages API counts the thinking tokens in `max_tokens` and wants `budget_tokens` below it. What the
// session decides (`prepare`: the cap, the reasoning budget and how they fit the model) reaches the provider through
// two runtimes: the AI SDK path (the default), whose provider adds the budget on top of `maxOutputTokens`, and the
// native runtime (GRAPHAGENT_NATIVE_LLM=true), which sends `max_tokens` itself. The bodies that leave for the
// provider are checked on both (#1464).

const it = testEffect(
  Layer.mergeAll(
    RuntimeFlags.layer(),
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  ),
)

const baseURL = "https://anthropic.example.test/v1"

const claude = (apiID: string, output: number): Provider.Model => {
  const model: Provider.Model = {
    id: ModelV2.ID.make(apiID),
    providerID: ProviderV2.ID.make("anthropic"),
    api: { id: apiID, url: baseURL, npm: "@ai-sdk/anthropic" },
    name: apiID,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-05-14",
  }
  return { ...model, variants: ProviderTransform.variants(model) }
}

const provider: Provider.Info = {
  id: ProviderV2.ID.make("anthropic"),
  name: "Anthropic",
  source: "config",
  env: [],
  options: { apiKey: "fixture-key" },
  models: {},
}

const messages = [{ role: "user" as const, content: "write the report" }]

/** The request the session builds for the `max` thinking tier of `model`. */
const prepared = (model: Provider.Model) =>
  Effect.gen(function* () {
    return yield* prepare({
      model,
      provider,
      cfg: {},
      user: {
        id: SessionV1.MessageID.make("msg_budget_wire"),
        sessionID: SessionID.make("ses_budget_wire"),
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id, variant: "max" },
      },
      sessionID: "ses_budget_wire",
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      system: [],
      messages,
      tools: {},
      auth: undefined,
      flags: yield* RuntimeFlags.Service,
    })
  })

type Params = Effect.Success<ReturnType<typeof prepared>>["params"]
type Body = { max_tokens: number; thinking?: { type: string; budget_tokens: number } }

/** What the AI SDK sends: the body its provider package builds. The fake transport records it and fails the call. */
async function sdkBody(model: Provider.Model, params: Params): Promise<Body> {
  const bodies: Body[] = []
  const transport: typeof globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Missing fixture SDK request body")
      bodies.push(JSON.parse(init.body))
      throw new Error("fixture transport stops after recording the request")
    },
    { preconnect() {} },
  )
  await generateText({
    model: createAnthropic({ apiKey: "fixture-key", baseURL, fetch: transport })(model.api.id),
    messages,
    maxOutputTokens: params.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(model, params.options),
    maxRetries: 0,
  }).catch(() => undefined)
  expect(bodies).toHaveLength(1)
  return bodies[0]
}

/** What the native runtime sends: the request it hands to the client, compiled into its Messages body. */
const nativeBody = (model: Provider.Model, params: Params) =>
  Effect.gen(function* () {
    const captured: LLMRequest[] = []
    const llmClient: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: (request) => {
        captured.push(request)
        return Stream.empty
      },
      generate: () => Effect.die("unused"),
    }
    const native = yield* LLMNativeRuntime.stream({
      model,
      provider,
      auth: undefined,
      llmClient,
      messages,
      tools: {},
      maxOutputTokens: params.maxOutputTokens,
      providerOptions: params.options,
      headers: {},
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(native.reason)
    yield* Stream.runDrain(native.stream)
    expect(captured).toHaveLength(1)
    const compiled = yield* LLMClient.prepare<Body>(captured[0])
    expect(compiled.route).toBe("anthropic-messages")
    return compiled.body
  })

describe("the output cap and the thinking budget on the wire (#1464)", () => {
  const cases: ReadonlyArray<{
    name: string
    apiID: string
    output: number
    /** What both runtimes send: the room for the answer is what `max_tokens` leaves after the budget. */
    maxTokens: number
    budget: number
  }> = [
    {
      // Codex's example: the session cuts the budget to 24,000 and the answer cap to 8,000.
      name: "a 32k model fits its max tier into the cap",
      apiID: "claude-opus-4-1-20250805",
      output: 32_000,
      maxTokens: 32_000,
      budget: 24_000,
    },
    {
      name: "a 64k model keeps the full max budget beside the default cap",
      apiID: "claude-sonnet-4-5-20250929",
      output: 64_000,
      maxTokens: 63_999,
      budget: 31_999,
    },
    {
      name: "a model with an unknown output limit keeps the default cap as max_tokens",
      apiID: "claude-opus-4-1-20250805",
      output: 0,
      maxTokens: 32_000,
      budget: 31_999,
    },
  ]

  for (const item of cases) {
    it.instance(`${item.name}: both runtimes send a budget below max_tokens`, () =>
      Effect.gen(function* () {
        const model = claude(item.apiID, item.output)
        const { params } = yield* prepared(model)
        const sdk = yield* Effect.promise(() => sdkBody(model, params))
        const native = yield* nativeBody(model, params)

        for (const body of [sdk, native]) {
          expect(body.thinking?.type).toBe("enabled")
          expect(body.max_tokens).toBe(item.maxTokens)
          expect(body.thinking?.budget_tokens).toBe(item.budget)
          expect(body.thinking?.budget_tokens).toBeLessThan(body.max_tokens)
        }
        // The whole request stays inside what the model can emit: its output limit, or the cap the session resolved when
        // that limit is unknown. A catalog limit above the default cap lets the budget go beyond the cap, as the AI SDK
        // always added it on top.
        const flags = yield* RuntimeFlags.Service
        const ceiling = item.output > 0 ? item.output : ProviderTransform.requestOutputCap(model, flags.outputTokenMax)
        for (const body of [sdk, native]) expect(body.max_tokens).toBeLessThanOrEqual(ceiling ?? 0)
      }),
    )
  }
})
