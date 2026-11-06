import { describe, expect, test } from "bun:test"
import { LLMError, LLMEvent, ToolFailure } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@opencode-ai/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { OpenAIWebSocketPool, TITLE_HEADER } from "@/provider/openai-ws/ws-pool"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"

import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { engineOrganizerCall } from "@opencode-ai/core/session/reasoning-distillation"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {
    "x-model": "model-header",
  },
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
)

function responsesStream(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

type NativeRequestInput = Parameters<typeof LLMNative.request>[0]

const sessionText = (text: string) => ({ type: "text" as const, text })

const sessionOpenAIReasoning = (
  text: string,
  options: {
    readonly storedAs: "providerMetadata" | "providerOptions"
    readonly itemId: string
    readonly encryptedContent: string | null
  },
) => {
  const metadata = {
    openai: { itemId: options.itemId, reasoningEncryptedContent: options.encryptedContent },
  }
  if (options.storedAs === "providerMetadata")
    return Object.assign({ type: "reasoning" as const, text }, { providerMetadata: metadata })
  return Object.assign({ type: "reasoning" as const, text }, { providerOptions: metadata })
}

type SessionAssistantPart = ReturnType<typeof sessionText> | ReturnType<typeof sessionOpenAIReasoning>

const storedSession = {
  user: (content: string): ModelMessage => ({ role: "user", content }),
  assistant: (content: SessionAssistantPart[]): ModelMessage => ({ role: "assistant", content }),
  text: sessionText,
  openaiReasoning: sessionOpenAIReasoning,
}

const openAIResponses = {
  user: (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }),
  assistant: (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
  openaiReasoning: (text: string, options: { readonly itemId: string; readonly encryptedContent: string }) => ({
    type: "reasoning",
    id: options.itemId,
    encrypted_content: options.encryptedContent,
    summary: [{ type: "summary_text", text }],
  }),
}

type PreparedMessagesBody = {
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
}

const prepareNativeRequest = <Body = unknown>(input: NativeRequestInput) =>
  LLMClient.prepare<Body>(LLMNative.request(input))

const expectOpenAIResponsesRequest = (input: {
  readonly history: NativeRequestInput["messages"]
  readonly providerOptions?: NativeRequestInput["providerOptions"]
  readonly maxOutputTokens?: NativeRequestInput["maxOutputTokens"]
  readonly headers?: NativeRequestInput["headers"]
  readonly expectedBody: unknown
}) =>
  Effect.gen(function* () {
    expect(
      yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-openai-key",
        messages: input.history,
        providerOptions: input.providerOptions,
        maxOutputTokens: input.maxOutputTokens,
        headers: input.headers,
      }),
    ).toMatchObject({
      route: "openai-responses",
      protocol: "openai-responses",
      body: input.expectedBody,
    })
  })

describe("session.llm-native.request", () => {
  it.live("streams the OAuth organizer through its provider fetch override from first frame to completion", () =>
    Effect.gen(function* () {
      let directRequests = 0
      const sentinel = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
              directRequests++
              return new Response("organizer must use the OAuth fetch override", { status: 500 })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const captures: Array<{ url: string; body: unknown }> = []
      const firstFrame = Promise.withResolvers<void>()
      let starts = 0
      let completed = false
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          captures.push({ url: request.url, body: await request.clone().json() })
          const encoder = new TextEncoder()
          let created = false
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                const send = (event: unknown) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                if (!created) {
                  created = true
                  send({ type: "response.created", response: { id: "resp_organizer" } })
                  return
                }
                await firstFrame.promise
                expect(starts).toBe(1)
                send({
                  type: "response.output_text.delta",
                  item_id: "msg_1",
                  delta: "confirmed decision uses safe path",
                })
                send({
                  type: "response.completed",
                  response: { usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
                })
                completed = true
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch
      const llmClient = yield* LLMClient.Service
      const engine = LLMNativeRuntime.organizerClient({
        model: baseModel,
        provider: {
          ...providerInfo,
          options: { apiKey: OAUTH_DUMMY_KEY, baseURL: new URL("/v1", sentinel.url).toString(), fetch: customFetch },
        },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
      })
      if (engine.type !== "supported") throw new Error(engine.reason)
      const result = yield* Effect.promise(() =>
        engineOrganizerCall({
          llm: engine.llm,
          model: engine.model,
          effort: "low",
          timeoutMs: 1_000,
          onResponseStarted: () => {
            starts++
            expect(completed).toBe(false)
            firstFrame.resolve()
          },
        })({ prompt: "organize" }),
      )
      expect(result).toEqual({ text: "confirmed decision uses safe path", usageTokens: 25, finishReason: "stop" })
      expect(starts).toBe(1)
      expect(completed).toBe(true)
      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        url: new URL("/v1/responses", sentinel.url).toString(),
        body: { stream: true },
      })
      expect(directRequests).toBe(0)
    }),
  )

  it.live("preserves OAuth title HTTP routing and removes the marker before upstream", () =>
    Effect.gen(function* () {
      let upgrades = 0
      const headers: Headers[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              headers.push(request.headers)
              if (request.headers.get("upgrade") === "websocket") {
                upgrades++
                return new Response(null, { status: 400 })
              }
              return responsesStream([
                { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
              ])
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const transport = yield* Effect.acquireRelease(
        Effect.sync(() => OpenAIWebSocketPool.createWebSocketFetch()),
        (transport) => Effect.sync(() => transport.close()),
      )
      const llmClient = yield* LLMClient.Service
      const native = yield* LLMNativeRuntime.stream({
        model: baseModel,
        provider: {
          ...providerInfo,
          options: { apiKey: OAUTH_DUMMY_KEY, baseURL: new URL("/v1", server.url).toString(), fetch: transport },
        },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: { [TITLE_HEADER]: "true", "x-session-affinity": "title-session" },
        abort: new AbortController().signal,
      })
      if (native.type !== "supported") throw new Error(native.reason)
      yield* native.stream.pipe(Stream.runDrain)
      expect(upgrades).toBe(0)
      expect(headers).toHaveLength(1)
      expect(headers[0]?.has(TITLE_HEADER)).toBe(false)
    }),
  )

  it.effect("strips internal title routing headers before an ordinary OAuth provider fetch", () =>
    Effect.gen(function* () {
      const captures: Headers[] = []
      const ordinaryFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          captures.push((input instanceof Request ? input : new Request(input, init)).headers)
          return responsesStream([
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      const llmClient = yield* LLMClient.Service
      const model: Provider.Model = { ...baseModel, headers: { ...baseModel.headers, "X-OPENCODE-TITLE": "true" } }
      const native = yield* LLMNativeRuntime.stream({
        model,
        provider: {
          ...providerInfo,
          options: {
            apiKey: OAUTH_DUMMY_KEY,
            experimentalWebSockets: true,
            headers: { "X-Opencode-Title": "true", "x-provider": "provider-header" },
            fetch: ordinaryFetch,
          },
        },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: { [TITLE_HEADER]: "true", "x-session-affinity": "title-session" },
        abort: new AbortController().signal,
      })
      if (native.type !== "supported") throw new Error(native.reason)
      yield* native.stream.pipe(Stream.runDrain)
      expect(OpenAIWebSocketPool.isTitleHeaderConsumer(ordinaryFetch)).toBe(false)
      expect(captures).toHaveLength(1)
      expect(captures[0]?.has(TITLE_HEADER)).toBe(false)
      expect(captures[0]?.get("x-provider")).toBe("provider-header")
      expect(captures[0]?.get("x-model")).toBe("model-header")
      expect(captures[0]?.get("x-session-affinity")).toBe("title-session")
      expect(model.headers["X-OPENCODE-TITLE"]).toBe("true")
    }),
  )

  it.effect("strips internal title routing headers from direct native HTTP requests", () =>
    Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      const model: Provider.Model = {
        ...baseModel,
        providerID: ProviderV2.ID.make("relay"),
        headers: { ...baseModel.headers, "X-OPENCODE-TITLE": "true" },
      }
      const native = yield* LLMNativeRuntime.stream({
        model,
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("relay"),
          options: {
            ...providerInfo.options,
            experimentalWebSockets: true,
            headers: { "X-Opencode-Title": "true", "x-provider": "provider-header" },
          },
        },
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: { [TITLE_HEADER]: "true", "x-session-affinity": "title-session" },
        abort: new AbortController().signal,
      })
      if (native.type !== "supported") throw new Error(native.reason)
      const captures: Headers[] = []
      yield* native.stream.pipe(
        Stream.runDrain,
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
              captures.push((input instanceof Request ? input : new Request(input, init)).headers)
              return responsesStream([
                { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
              ])
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      )
      expect(captures).toHaveLength(1)
      expect(captures[0]?.has(TITLE_HEADER)).toBe(false)
      expect(captures[0]?.get("x-provider")).toBe("provider-header")
      expect(captures[0]?.get("x-model")).toBe("model-header")
      expect(captures[0]?.get("x-session-affinity")).toBe("title-session")
      expect(captures[0]?.get("authorization")).toBe("Bearer test-openai-key")
      expect(model.headers["X-OPENCODE-TITLE"]).toBe("true")
    }),
  )

  for (const purpose of ["conversation", "compaction"] as const) {
    it.effect(`native ${purpose} applies its own timeout retry policy`, () =>
      Effect.gen(function* () {
        const llmClient = yield* LLMClient.Service
        let attempts = 0
        const native = yield* LLMNativeRuntime.stream({
          model: baseModel,
          provider: providerInfo,
          auth: undefined,
          llmClient,
          messages: [{ role: "user", content: "hello" }],
          tools: {},
          headers: {},
          abort: new AbortController().signal,
          contextFolding: { enabled: false, purpose, system: { kind: "messages" } },
        })
        if (native.type !== "supported") throw new Error(native.reason)
        const error = yield* native.stream.pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              async () => {
                attempts++
                return new Response(null, { status: 504, headers: { "retry-after-ms": "0" } })
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          ),
        )
        expect(error).toBeInstanceOf(LLMError)
        expect(attempts).toBe(purpose === "conversation" ? 3 : 1)
      }),
    )
  }

  it.effect("native conversation defers retries to the session processor when sessionRetry is set", () =>
    Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      let attempts = 0
      const native = yield* LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
        sessionRetry: true,
        contextFolding: { enabled: false, purpose: "conversation", system: { kind: "messages" } },
      })
      if (native.type !== "supported") throw new Error(native.reason)
      const error = yield* native.stream.pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            async () => {
              attempts++
              return new Response(null, { status: 504, headers: { "retry-after-ms": "0" } })
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        ),
      )
      expect(error).toBeInstanceOf(LLMError)
      // The processor's SessionRetry policy is the only retry layer.
      expect(attempts).toBe(1)
    }),
  )

  test("maps normalized stream inputs to a native LLM request", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "system from messages",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "file", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
            providerOptions: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ]

    const request = LLMNative.request({
      model: baseModel,
      system: ["agent system"],
      messages,
      tools: {
        bash: tool({
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          }),
        }),
      },
      toolChoice: "required",
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      providerOptions: { openai: { store: false } },
      headers: { "x-request": "request-header" },
    })

    expect(request.model).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      route: { id: "openai-responses" },
    })
    expect(request.model.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(request.model.route.defaults.headers).toEqual({
      "x-model": "model-header",
      "x-request": "request-header",
    })
    expect(request.model.route.defaults.limits).toMatchObject({
      context: 128_000,
      output: 32_000,
    })
    expect(request.system).toEqual([
      { type: "text", text: "agent system" },
      { type: "text", text: "system from messages" },
    ])
    expect(request.generation).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 1024,
    })
    expect(request.providerOptions).toEqual({ openai: { store: false } })
    expect(request.toolChoice).toMatchObject({ type: "required" })
    expect(request.tools).toMatchObject([
      {
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ])
    expect(request.messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerMetadata: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "media", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
            providerMetadata: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "bash",
            result: { type: "text", value: "ok" },
            providerMetadata: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ])
  })

  test("maps stored provider metadata to native content metadata", () => {
    const reasoning = Object.assign(
      { type: "reasoning" as const, text: "thinking" },
      {
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-state",
          },
        },
      },
    )
    const request = LLMNative.request({
      model: baseModel,
      messages: [
        {
          role: "assistant",
          content: [reasoning],
        },
      ],
    })

    expect(request.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
    ])
  })

  test("selects native request routes for provider packages", () => {
    const openai = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/openai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openai.route.id).toBe("openai-responses")
    expect(openai.route.endpoint.baseURL).toBe("https://api.openai.com/v1")

    const anthropic = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/anthropic" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(anthropic.route.endpoint.baseURL).toBe("https://api.anthropic.com/v1")

    const google = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/google" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(google.route.id).toBe("gemini")
    expect(google.route.endpoint.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")

    const compatible = LLMNative.model({
      model: {
        ...baseModel,
        providerID: ProviderV2.ID.make("opencode"),
        api: { ...baseModel.api, url: "https://ai.example.test/v1", npm: "@ai-sdk/openai-compatible" },
      },
      apiKey: "test-key",
      messages: [],
    })
    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(compatible.route.endpoint.baseURL).toBe("https://ai.example.test/v1")

    const openrouter = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@openrouter/ai-sdk-provider" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openrouter.route.id).toBe("openrouter")
    expect(openrouter.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")
  })

  test("fails fast for unsupported provider packages", () => {
    expect(() =>
      LLMNative.request({
        model: { ...baseModel, api: { ...baseModel.api, npm: "unknown-provider" } },
        messages: [],
      }),
    ).toThrow("Native LLM request adapter does not support provider package unknown-provider")
  })

  test("only enables native runtime for supported OpenAI API-key models", () => {
    expect(LLMNativeRuntime.status({ model: baseModel, provider: providerInfo, auth: undefined })).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("opencode") },
        provider: { ...providerInfo, id: ProviderV2.ID.make("opencode") },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("opencode"),
          api: { ...baseModel.api, npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("opencode") },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("google"),
          api: { ...baseModel.api, npm: "@ai-sdk/google" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("google") },
        auth: undefined,
      }),
    ).toEqual({
      type: "unsupported",
      reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic",
    })
    // The gate keys off the SDK transport package: any OpenAI-compatible
    // relay (local proxies, DeepSeek, GLM gateways) is supported regardless
    // of its providerID.
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("local-proxy-compatible"),
          api: { ...baseModel.api, url: "https://proxy.example.test/v1", npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("local-proxy-compatible") },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: providerInfo,
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toMatchObject({ type: "supported", apiKey: OAUTH_DUMMY_KEY })

    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, api: { ...baseModel.api, npm: "@ai-sdk/google" } },
        provider: providerInfo,
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" })

    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {} },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "API key is not configured" })
  })

  test("enables native runtime for Anthropic API-key models", () => {
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
        },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("anthropic"),
          name: "Anthropic",
          env: ["ANTHROPIC_API_KEY"],
          options: { apiKey: "test-anthropic-key" },
        },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-anthropic-key" })
  })

  test("prefers console provider api key over stored opencode auth", () => {
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("opencode") },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("opencode"),
          options: { apiKey: "console-token" },
          key: "zen-token",
        },
        auth: { type: "api", key: "zen-token" },
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "console-token",
    })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {}, key: "provider-key" },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "provider-key",
    })
  })

  it.effect("native tool wrapper converts thrown errors into typed ToolFailure", () =>
    Effect.gen(function* () {
      const wrapped = LLMNativeRuntime.nativeTools(
        {
          explode: {
            description: "always throws",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new Error("boom")
            },
          } satisfies Tool,
        },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.explode.execute({}, { id: "call-1", name: "explode" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toBe("boom")
    }),
  )

  it.effect("native tool wrapper raises ToolFailure when the source tool has no execute handler", () =>
    Effect.gen(function* () {
      // The AI SDK Tool shape allows execute to be omitted (e.g., client-side / MCP tools).
      // The native runtime owns execution, so encountering such a tool here means upstream
      // wiring is wrong; we want a typed failure, not a silent skip or unhandled exception.
      const wrapped = LLMNativeRuntime.nativeTools(
        { incomplete: { description: "no execute", inputSchema: jsonSchema({ type: "object" }) } satisfies Tool },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.incomplete.execute({}, { id: "call-1", name: "incomplete" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("incomplete")
    }),
  )

  it.effect("settles parallel native tools before completing the provider step", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const started: string[] = []
      let release: (() => void) | undefined
      let notifyStarted: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const bothStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const lookup = {
        description: "Lookup data",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (_args: unknown, options: { toolCallId: string }) => {
          started.push(options.toolCallId)
          if (started.length === 2) notifyStarted?.()
          await gate
          return { output: options.toolCallId }
        },
      } satisfies Tool
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
            LLMEvent.toolCall({ id: "call-2", name: "lookup", input: {} }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: { inputTokens: 30_000, outputTokens: 1 } }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = yield* LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools: { lookup },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(
        Stream.runForEach((event) => Effect.sync(() => observed.push(event.type))),
        Effect.forkScoped,
      )
      yield* Effect.promise(() => bothStarted)

      expect(started).toEqual(["call-1", "call-2"])
      expect(observed).toEqual(["tool-call", "tool-call"])

      release?.()
      yield* Fiber.join(fiber)
      expect(observed).toEqual(["tool-call", "tool-call", "tool-result", "tool-result", "step-finish", "finish"])
    }),
  )

  it.effect("compiles through the native OpenAI Responses route", () =>
    expectOpenAIResponsesRequest({
      history: [storedSession.user("hello")],
      providerOptions: { openai: { store: false, instructions: "You are concise." } },
      maxOutputTokens: 512,
      headers: { "x-request": "request-header" },
      expectedBody: {
        model: "gpt-5-mini",
        instructions: "You are concise.",
        input: [openAIResponses.user("hello")],
        max_output_tokens: 512,
        store: false,
        stream: true,
      },
    }),
  )

  it.effect("omits non-persisted OpenAI reasoning ids without encrypted state", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerOptions",
            itemId: "rs_1",
            encryptedContent: null,
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        store: false,
      },
    }),
  )

  it.effect("preserves encrypted OpenAI reasoning state through native request lowering", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.openaiReasoning("Checked the previous diff.", {
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("preserves empty encrypted OpenAI reasoning items before tool output", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
        ]),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-state" }],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("references stored OpenAI reasoning items by id", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: null,
          }),
        ]),
      ],
      providerOptions: { openai: { store: true } },
      expectedBody: {
        input: [{ type: "item_reference", id: "rs_1" }],
        store: true,
      },
    }),
  )

  it.effect("uses provider fetch override for native OpenAI OAuth requests", () =>
    Effect.gen(function* () {
      const captures: Array<{ url: string; body: unknown }> = []
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          captures.push({ url: request.url, body: await request.clone().json() })
          return responsesStream([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch

      const llmClient = yield* LLMClient.Service
      const native = yield* LLMNativeRuntime.stream({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: { instructions: "You are concise." },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        body: {
          model: "gpt-5-mini",
          instructions: "You are concise.",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
      })
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", text: "Hello" }),
          expect.objectContaining({ type: "finish" }),
        ]),
      )
    }),
  )

  it.effect("keeps native cache metadata off synthetic attachments and runtime context", () =>
    Effect.gen(function* () {
      const anthropicModel: Provider.Model = {
        ...baseModel,
        id: ModelV2.ID.make("claude-haiku-5-5"),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { id: "claude-haiku-5-5", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
        capabilities: {
          ...baseModel.capabilities,
          input: { ...baseModel.capabilities.input, pdf: true },
        },
      }
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime_context>\n\n<project_memory_data>epoch 1</project_memory_data>\n\n</runtime_context>",
            },
          ],
          providerOptions: { opencode: { context: true, cache: "none" } },
        },
        {
          role: "user",
          content: [
            { type: "text", text: "persisted user" },
            {
              type: "text",
              text: "[todo reminder] ephemeral",
              providerOptions: { opencode: { cache: "none" } },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: {} }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "ok" } },
          ],
        },
        {
          role: "user",
          providerOptions: {
            opencode: { synthetic: "attachment", cache: "none" },
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
          content: [
            {
              type: "text",
              text: "Attached media from tool result:",
              providerOptions: { opencode: { synthetic: "attachment", cache: "none" } },
            },
            { type: "file", mediaType: "image/png", data: "data:image/png;base64,AA==", filename: "attachment.png" },
          ],
        },
      ]
      const transformed = ProviderTransform.message(messages, anthropicModel, {})
      const canonical = LLMNative.request({
        model: anthropicModel,
        apiKey: "test-anthropic-key",
        messages: transformed,
      })
      const attachment = canonical.messages.find((message) => JSON.stringify(message).includes("Attached media"))!
      expect(attachment.metadata).toEqual({ cache: "none" })
      expect(attachment.native).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } })
      expect(attachment.native?.opencode).toBeUndefined()
      const context = canonical.messages.find((message) => JSON.stringify(message).includes("<project_memory_data>"))!
      expect(context.metadata).toEqual({ cache: "none" })
      expect(context.native?.opencode).toBeUndefined()

       const prepared = yield* prepareNativeRequest<PreparedMessagesBody>({
        model: anthropicModel,
        apiKey: "test-anthropic-key",
        messages: transformed,
      })
       const body = prepared.body
      const blocks = body.messages.flatMap((message) => message.content)
      expect(blocks.find((block) => block.text === "persisted user")).toMatchObject({
        cache_control: { type: "ephemeral" },
      })
      expect(
        JSON.stringify(blocks.find((block) => JSON.stringify(block).includes("<project_memory_data>"))),
      ).not.toContain("cache_control")
      const attachmentBody = body.messages.find((message) => JSON.stringify(message).includes("Attached media"))
      expect(attachmentBody).toBeDefined()
      expect(JSON.stringify(attachmentBody)).not.toContain("cache_control")
    }),
  )

  it.effect("prepares provider-executed history after switching to an OpenAI-compatible chat model", () =>
    Effect.gen(function* () {
      const compatibleModel: Provider.Model = {
        ...baseModel,
        id: ModelV2.ID.make("qwen3"),
        providerID: ProviderV2.ID.make("local"),
        api: { id: "qwen3", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
      }
      const history: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "Search the web for agents." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "hosted_1",
              toolName: "web_search",
              input: { query: "agents" },
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "hosted_1",
              toolName: "web_search",
              output: { type: "text", value: "search summary" },
            },
            { type: "text", text: "The search found agents." },
          ],
        },
      ]

       const prepared = yield* prepareNativeRequest<PreparedMessagesBody>({
        model: compatibleModel,
        apiKey: "test-compatible-key",
        messages: ProviderTransform.message(history, compatibleModel, {}),
      })

      expect(prepared.route).toBe("openai-compatible-chat")
      const body = JSON.stringify(prepared.body)
      expect(body).not.toContain('"tool_calls"')
      expect(body).toContain("web_search")
      expect(body).toContain("search summary")
      expect(body).toContain("The search found agents.")
    }),
  )

  it.effect("prepares incomplete and malformed provider-executed history after switching models", () =>
    Effect.gen(function* () {
      const compatibleModel: Provider.Model = {
        ...baseModel,
        id: ModelV2.ID.make("qwen3"),
        providerID: ProviderV2.ID.make("local"),
        api: { id: "qwen3", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
      }
      const history: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "hosted_call",
              toolName: "web_search",
              input: { query: "agents" },
              providerExecuted: true,
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "",
              toolName: "",
              input: undefined,
              providerExecuted: true,
            },
            { type: "tool-result", toolCallId: "", toolName: "", output: { type: "text", value: "fetched page" } },
          ],
        },
      ]

      const prepared = yield* prepareNativeRequest({
        model: compatibleModel,
        apiKey: "test-compatible-key",
        messages: ProviderTransform.message(history, compatibleModel, {}),
      })

      const body = JSON.stringify(prepared.body)
      expect(body.match(/"role":"assistant"/g)).toHaveLength(2)
      expect(body).not.toContain('"tool_calls"')
      expect(body).toContain("web_search")
      expect(body).toContain("fetched page")
    }),
  )

  it.effect("keeps native Bedrock cache points off synthetic attachments and runtime context", () =>
    Effect.gen(function* () {
      const bedrockModel: Provider.Model = {
        ...baseModel,
        id: ModelV2.ID.make("anthropic.claude-3-5-sonnet-20241022-v2:0"),
        providerID: ProviderV2.ID.make("amazon-bedrock"),
        api: {
          id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          url: "https://bedrock-runtime.us-east-1.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
        capabilities: {
          ...baseModel.capabilities,
          input: { ...baseModel.capabilities.input, pdf: true },
        },
      }
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime_context>\n\n<project_memory_data>epoch 1</project_memory_data>\n\n</runtime_context>",
            },
          ],
          providerOptions: { opencode: { context: true, cache: "none" } },
        },
        {
          role: "user",
          content: [
            { type: "text", text: "persisted user" },
            {
              type: "text",
              text: "[todo reminder] ephemeral",
              providerOptions: { opencode: { cache: "none" } },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: {} }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "ok" } },
          ],
        },
        {
          role: "user",
          providerOptions: {
            opencode: { synthetic: "attachment", cache: "none" },
            bedrock: { cachePoint: { type: "default" } },
          },
          content: [
            {
              type: "text",
              text: "Attached media from tool result:",
              providerOptions: { opencode: { synthetic: "attachment", cache: "none" } },
            },
            { type: "file", mediaType: "image/png", data: "data:image/png;base64,AA==", filename: "attachment.png" },
          ],
        },
      ]
      const transformed = ProviderTransform.message(messages, bedrockModel, {})
      const canonical = LLMNative.request({
        model: bedrockModel,
        apiKey: "test-bedrock-key",
        messages: transformed,
      })
      const attachment = canonical.messages.find((message) => JSON.stringify(message).includes("Attached media"))!
      expect(attachment.metadata).toEqual({ cache: "none" })
      expect(attachment.native).toMatchObject({ bedrock: { cachePoint: { type: "default" } } })
      expect(attachment.native?.opencode).toBeUndefined()
      const context = canonical.messages.find((message) => JSON.stringify(message).includes("<project_memory_data>"))!
      expect(context.metadata).toEqual({ cache: "none" })

      const prepared = yield* prepareNativeRequest<PreparedMessagesBody>({
        model: bedrockModel,
        apiKey: "test-bedrock-key",
        messages: transformed,
        tools: { read: { description: "read", inputSchema: { type: "object", properties: {} } } },
      })
       const body = prepared.body
      const blocks = body.messages.flatMap((message) => message.content)
      const persisted = body.messages.find((message) => JSON.stringify(message).includes("persisted user"))!
      expect(JSON.stringify(persisted)).toContain("cachePoint")
      expect(
        JSON.stringify(blocks.find((block) => JSON.stringify(block).includes("<project_memory_data>"))),
      ).not.toContain("cachePoint")
      const attachmentBody = body.messages.find((message) => JSON.stringify(message).includes("Attached media"))
      expect(attachmentBody).toBeDefined()
      expect(JSON.stringify(attachmentBody)).not.toContain("cachePoint")
    }),
  )
})
