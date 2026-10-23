import { expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import { streamText } from "ai"
import { pathToFileURL } from "node:url"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk"
import { ConfigProvider, Effect, Layer } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { TITLE_HEADER } from "@/plugin/openai/ws-pool"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { LLMRequestPrep } from "@/session/llm/request"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { disposeAllInstancesEffect, provideTmpdirInstance, withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const layer = Layer.mergeAll(
  Provider.defaultLayer,
  Env.defaultLayer,
  Plugin.defaultLayer,
  Session.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const it = testEffect(layer)
const plainTransport = testEffect(
  layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_DEFAULT_PLUGINS: true }))),
  ),
)

const events = [
  { type: "response.created", response: { id: "resp_test", model: "test-model", created_at: 0 } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant" } },
  { type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "ok" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant" } },
  {
    type: "response.completed",
    response: {
      id: "resp_test",
      model: "test-model",
      created_at: 0,
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
]
const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"

function providerConfig(
  baseURL: string,
  experimentalWebSockets?: boolean,
  providerID = "relay",
): Partial<ConfigV1.Info> {
  return {
    enabled_providers: [providerID],
    provider: {
      [providerID]: {
        npm: "@ai-sdk/openai",
        options: {
          baseURL,
          apiKey: "test-provider-key",
          ...(experimentalWebSockets === undefined ? {} : { experimentalWebSockets }),
        },
        models: { "test-model": { name: "Test Model", limit: { context: 10000, output: 1000 } } },
      },
    },
  }
}

for (const [providerID, configuredMarkers] of [
  ["openai", false],
  ["openai", true],
  ["relay", false],
  ["relay", true],
] as const) {
  plainTransport.live(
    `${providerID} plugin fetch keeps HTTP priority and strips title routing headers with configured markers=${configuredMarkers}`,
    () =>
      Effect.gen(function* () {
        const received: Headers[] = []
        let upgrades = 0
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                if (request.headers.get("upgrade") === "websocket") {
                  upgrades++
                  return new Response(null, { status: 400 })
                }
                received.push(request.headers)
                return new Response(sse, { headers: { "content-type": "text/event-stream" } })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        yield* Effect.gen(function* () {
          const provider = yield* Provider.Service
          const plugin = yield* Plugin.Service
          const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const info = yield* provider.getProvider(ProviderV2.ID.make(providerID))
          const session = yield* Session.use.create({})
          const flags = yield* RuntimeFlags.Service
          for (const agent of ["build", "title"]) {
            const { headers } = yield* LLMRequestPrep.prepare({
              model,
              provider: info,
              sessionID: session.id,
              agent: { name: agent, mode: "primary", permission: [], options: {} },
              user: {
                id: SessionV1.MessageID.make("msg_test"),
                sessionID: session.id,
                role: "user",
                time: { created: 0 },
                agent,
                model: { providerID: model.providerID, modelID: model.id },
              },
              auth: undefined,
              plugin,
              flags,
              isWorkflow: false,
              messages: [{ role: "user", content: "hello" }],
              system: [],
              tools: {},
            })
            const result = streamText({
              model: language,
              prompt: "hello",
              headers: { ...headers, "x-session-affinity": session.id, "x-ordinary": "preserved" },
              maxRetries: 0,
            })
            expect(yield* Effect.promise(() => result.text)).toBe("ok")
          }
          expect(upgrades).toBe(0)
          expect(received).toHaveLength(2)
          for (const headers of received) {
            expect(headers.has(TITLE_HEADER)).toBe(false)
            expect(headers.get("x-custom-fetch")).toBe("preserved")
            expect(headers.get("x-ordinary")).toBe("preserved")
            expect(headers.get("x-provider")).toBe("preserved")
            expect(headers.get("x-model")).toBe("preserved")
            expect(headers.get("x-session-affinity")).toBe(session.id)
            expect(headers.get("authorization")).toBe("Bearer test-provider-key")
          }
        }).pipe(
          withTmpdirInstance({
            init: (directory) =>
              Effect.promise(async () => {
                const file = `${directory}/custom-fetch.ts`
                await Bun.write(
                  file,
                  `export default async () => ({ config(cfg) {
                cfg.provider[${JSON.stringify(providerID)}].options.fetch = async (input, init) => {
                  const headers = new Headers(init?.headers)
                  headers.set("x-custom-fetch", "preserved")
                  return globalThis.fetch(input, { ...init, headers })
                }
              } })`,
                )
                const config = providerConfig(new URL("/v1", server.url).toString(), true, providerID)
                const provider = config.provider?.[providerID]
                const model = provider?.models?.["test-model"]
                if (!provider || !model) throw new Error("Expected configured provider model")
                provider.options = {
                  ...provider.options,
                  headers: { "x-provider": "preserved", ...(configuredMarkers ? { "X-Opencode-Title": "true" } : {}) },
                }
                model.headers = { "x-model": "preserved", ...(configuredMarkers ? { "X-OPENCODE-TITLE": "true" } : {}) }
                await Bun.write(
                  `${directory}/opencode.json`,
                  JSON.stringify({
                    ...config,
                    plugin: [pathToFileURL(file).href],
                  }),
                )
              }),
          }),
        )
      }),
  )
}

plainTransport.live("custom fetch rebuilding Request preserves empty and title-only header overrides", () =>
  Effect.gen(function* () {
    const received: { headers: Headers; body: string }[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            received.push({ headers: request.headers, body: await request.text() })
            return new Response("ok")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("request-rebuild"), ModelV2.ID.make("test-model"))
      const language = yield* provider.getLanguage(model)
      const timers = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          start: spyOn(globalThis, "setTimeout"),
          clear: spyOn(globalThis, "clearTimeout"),
        })),
        (timers) =>
          Effect.sync(() => {
            timers.start.mockRestore()
            timers.clear.mockRestore()
          }),
      )
      const result = yield* Effect.promise(() => language.doGenerate({ prompt: [] }))
      expect(result.content).toEqual([{ type: "text", text: "ok" }])
      expect(received).toHaveLength(6)
      for (const request of received) {
        expect(request.headers.has(TITLE_HEADER)).toBe(false)
        expect(request.headers.has("authorization")).toBe(false)
        expect(request.headers.has("x-private")).toBe(false)
        expect(request.body).toBe("retained-body")
      }
      const headerTimers = timers.start.mock.calls.flatMap((args, index) => {
        const result = timers.start.mock.results[index]
        return args[1] === 60_123 && result.type === "return" ? [result.value] : []
      })
      expect(headerTimers).toHaveLength(8)
      for (const timer of headerTimers) expect(timers.clear).toHaveBeenCalledWith(timer)
    }).pipe(
      withTmpdirInstance({
        init: (directory) =>
          Effect.promise(async () => {
            const sdk = `${directory}/request-sdk.ts`
            await Bun.write(
              sdk,
              `export function createSDK(options) {
          return { languageModel(modelId) {
            return { specificationVersion: "v3", provider: "request-rebuild", modelId, supportedUrls: {},
              async doGenerate() {
                for (const marker of [false, true]) for (const form of ["record", "headers", "tuples"]) {
                  const input = new Request(options.baseURL, { method: "POST", body: "retained-body",
                    headers: { authorization: "Bearer synthetic-original", "x-private": "synthetic-private", "x-opencode-title": "original-marker" } });
                  const override = marker ? { "X-Opencode-Title": "true" } : {};
                  const headers = form === "record" ? override : form === "headers" ? new Headers(override) : Object.entries(override);
                  await (await options.fetch(input, { headers })).text();
                }
                const used = new Request(options.baseURL, { method: "POST", body: "used-body",
                  headers: { "x-opencode-title": "true" } });
                await used.text();
                const prepareError = await options.fetch(used, { headers: {} }).catch(error => error);
                if (!(prepareError instanceof TypeError)) throw new Error("Expected used Request preparation to fail");
                const customError = await options.fetch(new Request(options.baseURL, { method: "POST", body: "retained-body",
                  headers: { "x-opencode-title": "true" } }), { headers: { "x-fixture-throw": "true" } }).catch(error => error);
                if (customError?.message !== "synthetic custom fetch failure") throw new Error("Expected synchronous custom fetch failure");
                return { content: [{type: "text", text: "ok"}], finishReason: {unified: "stop", raw: "stop"},
                  usage: {inputTokens: {total: 1}, outputTokens: {total: 1}}, warnings: [] };
              }
            };
          } };
        }`,
            )
            const plugin = `${directory}/rebuilding-fetch.ts`
            await Bun.write(
              plugin,
              `export default async () => ({ config(cfg) {
          cfg.provider["request-rebuild"].options.fetch = (input, init) => {
            if (new Headers(init?.headers).has("x-fixture-throw")) throw new Error("synthetic custom fetch failure");
            return globalThis.fetch(new Request(input, init));
          };
        } })`,
            )
            await Bun.write(
              `${directory}/opencode.json`,
              JSON.stringify({
                enabled_providers: ["request-rebuild"],
                plugin: [pathToFileURL(plugin).href],
                provider: {
                  "request-rebuild": {
                    npm: pathToFileURL(sdk).href,
                    options: { baseURL: server.url.toString(), apiKey: "synthetic", headerTimeout: 60_123 },
                    models: { "test-model": { name: "Request transport", limit: { context: 10000, output: 1000 } } },
                  },
                },
              }),
            )
          }),
      }),
    )
  }),
)

for (const [providerID, disableDefaultPlugins] of [
  ["relay", false],
  ["openai", false],
  ["relay", true],
  ["openai", true],
] as const) {
  const transport = testEffect(
    layer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_DEFAULT_PLUGINS: disableDefaultPlugins })),
      ),
    ),
  )
  for (const configured of [undefined, false, true]) {
    if (providerID === "openai" && configured === undefined) continue
    transport.live(
      `${providerID} transport with experimentalWebSockets=${configured}, disabled plugins=${disableDefaultPlugins}`,
      () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = process.env.OPENCODE_AUTH_CONTENT
              process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "test-provider-key" } })
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
                else process.env.OPENCODE_AUTH_CONTENT = previous
              }),
          )
          let upgrades = 0
          let posts = 0
          let closed = 0
          const closeEvents = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                websocket: {
                  close() {
                    closeEvents[closed++]?.resolve()
                  },
                  message(socket, message) {
                    const body = JSON.parse(String(message))
                    expect(body.type).toBe("response.create")
                    expect(body.experimentalWebSockets).toBeUndefined()
                    for (const event of events) socket.send(JSON.stringify(event))
                  },
                },
                async fetch(request, server): Promise<Response | undefined> {
                  expect(request.headers.get("authorization")).toBe("Bearer test-provider-key")
                  expect(new URL(request.url).pathname).toBe("/v1/responses")
                  expect(request.headers.has(TITLE_HEADER)).toBe(false)
                  if (request.headers.get("upgrade") === "websocket") {
                    upgrades++
                    expect(request.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06")
                    if (server.upgrade(request)) return undefined
                    return new Response(null, { status: 400 })
                  }
                  posts++
                  expect(request.method).toBe("POST")
                  expect((await request.json()).experimentalWebSockets).toBeUndefined()
                  return new Response(sse, { headers: { "content-type": "text/event-stream" } })
                },
              }),
            ),
            (server) => Effect.sync(() => server.stop(true)),
          )

          yield* provideTmpdirInstance(
            () =>
              Effect.gen(function* () {
                const provider = yield* Provider.Service
                const plugin = yield* Plugin.Service
                const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make("test-model"))
                const language = yield* provider.getLanguage(model)
                const info = yield* provider.getProvider(ProviderV2.ID.make(providerID))
                const session = yield* Session.use.create({})
                const flags = yield* RuntimeFlags.Service
                expect(flags.disableDefaultPlugins).toBe(disableDefaultPlugins)
                if (disableDefaultPlugins) expect(yield* plugin.list()).toHaveLength(0)
                for (const title of [false, false, true]) {
                  const agent = title ? "title" : "build"
                  const input = { model, provider: info, sessionID: session.id, agent }
                  const { headers } = yield* LLMRequestPrep.prepare({
                    ...input,
                    agent: { name: agent, mode: "primary", permission: [], options: {} },
                    user: {
                      id: SessionV1.MessageID.make("msg_test"),
                      sessionID: session.id,
                      role: "user",
                      time: { created: 0 },
                      agent,
                      model: { providerID: model.providerID, modelID: model.id },
                    },
                    auth: undefined,
                    plugin,
                    flags,
                    isWorkflow: false,
                    messages: [{ role: "user", content: "hello" }],
                    system: [],
                    tools: {},
                  })
                  expect(new Headers(headers).get(TITLE_HEADER)).toBe(configured === true && title ? "true" : null)
                  if (providerID === "relay") {
                    const params = yield* plugin.trigger("chat.params", input, { maxOutputTokens: 1000 })
                    expect(params.maxOutputTokens).toBe(1000)
                  }
                  const result = streamText({
                    model: language,
                    messages: [{ role: "user", content: "hello" }],
                    headers: {
                      "x-session-affinity": session.id,
                      ...headers,
                    },
                    maxRetries: 0,
                  })
                  expect(yield* Effect.promise(() => result.text)).toBe("ok")
                }
                expect(upgrades).toBe(configured === true ? 1 : 0)
                expect(posts).toBe(configured === true ? 1 : 3)
                if (configured !== true) return

                yield* Session.use.remove(session.id)
                yield* awaitWithTimeout(
                  Effect.promise(() => closeEvents[0].promise),
                  "session deletion must close its WS",
                )
                const next = yield* Session.use.create({})
                const result = streamText({
                  model: language,
                  messages: [{ role: "user", content: "hello" }],
                  headers: { "x-session-affinity": next.id },
                  maxRetries: 0,
                })
                expect(yield* Effect.promise(() => result.text)).toBe("ok")
                expect(upgrades).toBe(2)
                yield* disposeAllInstancesEffect
                yield* awaitWithTimeout(
                  Effect.promise(() => closeEvents[1].promise),
                  "instance disposal must close its WS",
                )
                expect(closed).toBe(2)
              }),
            { config: providerConfig(new URL("/v1", server.url).toString(), configured, providerID) },
          )
        }),
    )
  }
}

for (const differentHeaders of [false, true]) {
  it.live(`custom provider isolates WS connections by ${differentHeaders ? "model headers" : "model endpoint"}`, () =>
    Effect.gen(function* () {
      const upgrades = [0, 0]
      const requests = [0, 0]
      const closed = [0, 0]
      const closeEvents = [
        [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
        [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
      ]
      const servers: Array<Bun.Server<{ identity: number }>> = []
      for (const identity of [0, 1]) {
        servers.push(
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve<{ identity: number }>({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request, server) {
                  expect(new URL(request.url).pathname).toBe("/v1/responses")
                  expect(request.headers.get("authorization")).toBe("Bearer test-provider-key")
                  const connection = differentHeaders ? Number(request.headers.get("x-model-identity")) : identity
                  if (server.upgrade(request, { data: { identity: connection } })) {
                    upgrades[connection]++
                    return undefined
                  }
                  return new Response(null, { status: 400 })
                },
                websocket: {
                  message(socket) {
                    requests[socket.data.identity]++
                    for (const event of events) socket.send(JSON.stringify(event))
                  },
                  close(socket) {
                    closeEvents[socket.data.identity][closed[socket.data.identity]++]?.resolve()
                  },
                },
              }),
            ),
            (server) => Effect.sync(() => server.stop(true)),
          ),
        )
      }
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const languages = []
            for (const id of ["a", "b"]) {
              const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make(id))
              languages.push(yield* provider.getLanguage(model))
            }
            const session = yield* Session.use.create({})
            for (const index of [0, 0, 1, 1, 0]) {
              const result = streamText({
                model: languages[index],
                prompt: "hello",
                headers: { "x-session-affinity": session.id },
                maxRetries: 0,
              })
              expect(yield* Effect.promise(() => result.text)).toBe("ok")
            }
            expect(upgrades).toEqual([1, 1])
            expect(requests).toEqual([3, 2])
            yield* Session.use.remove(session.id)
            for (const identity of [0, 1]) {
              yield* awaitWithTimeout(
                Effect.promise(() => closeEvents[identity][0].promise),
                "session removes every WS identity",
              )
            }
            const next = yield* Session.use.create({})
            for (const language of languages) {
              const result = streamText({
                model: language,
                prompt: "hello",
                headers: { "x-session-affinity": next.id },
                maxRetries: 0,
              })
              expect(yield* Effect.promise(() => result.text)).toBe("ok")
            }
            expect(upgrades).toEqual([2, 2])
            yield* disposeAllInstancesEffect
            for (const identity of [0, 1]) {
              yield* awaitWithTimeout(
                Effect.promise(() => closeEvents[identity][1].promise),
                "disposal closes every WS identity",
              )
            }
            expect(closed).toEqual([2, 2])
          }),
        {
          config: {
            enabled_providers: ["relay"],
            provider: {
              relay: {
                npm: "@ai-sdk/openai",
                options: { apiKey: "test-provider-key", experimentalWebSockets: true },
                models: Object.fromEntries(
                  ["a", "b"].map((id, identity) => [
                    id,
                    {
                      provider: { api: new URL("/v1", servers[differentHeaders ? 0 : identity].url).toString() },
                      headers: { "x-model-identity": String(differentHeaders ? identity : 0) },
                    },
                  ]),
                ),
              },
            },
          },
        },
      )
    }),
  )
}

it.live("custom provider preserves the existing WS retry budget and sticky POST/SSE fallback", () =>
  Effect.gen(function* () {
    let upgrades = 0
    let posts = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            expect(request.headers.get("authorization")).toBe("Bearer test-provider-key")
            if (request.headers.get("upgrade") === "websocket") {
              upgrades++
              return new Response("WebSockets unavailable", { status: 400 })
            }
            posts++
            expect(request.method).toBe("POST")
            expect((await request.json()).stream).toBe(true)
            return new Response(sse, { headers: { "content-type": "text/event-stream" } })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          for (let attempt = 0; attempt < 5; attempt++) {
            const result = streamText({
              model: language,
              prompt: "hello",
              headers: { "x-session-affinity": "fallback-session" },
              maxRetries: 0,
              onError: () => undefined,
            })
            let error: unknown
            yield* Effect.promise(async () => {
              for await (const chunk of result.fullStream) if (chunk.type === "error") error = chunk.error
            })
            if (!(error instanceof Error)) throw new Error("the SDK must expose the WS failure")
            expect(error.cause).toBeInstanceOf(ProviderError.ResponseStreamError)
            const parsed = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("relay") })
            expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
            if (!SessionV1.APIError.isInstance(parsed)) throw new Error("Expected APIError")
            expect(parsed.data.message).toContain("WebSocket connection")
            expect(parsed.data.isRetryable).toBe(true)
            expect(parsed.data.statusCode).toBeUndefined()
            expect(posts).toBe(0)
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = streamText({
              model: language,
              prompt: "hello",
              headers: { "x-session-affinity": "fallback-session" },
              maxRetries: 0,
            })
            expect(yield* Effect.promise(() => result.text)).toBe("ok")
          }
          expect(upgrades).toBe(6)
          expect(posts).toBe(2)
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider preserves nested WebSocket provider error status and body", () =>
  Effect.gen(function* () {
    const errorEvent = JSON.stringify({
      type: "error",
      status: 400,
      headers: { "x-request-id": "req_nested" },
      error: { message: "invalid request" },
    })
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (request.headers.get("upgrade") === "websocket") {
              return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
            }
            return new Response(null, { status: 400 })
          },
          websocket: {
            message(socket) {
              socket.send(errorEvent)
            },
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "hello",
            headers: { "x-session-affinity": "nested-error-session" },
            maxRetries: 0,
            onError: () => undefined,
          })
          let error: unknown
          yield* Effect.promise(async () => {
            for await (const chunk of result.fullStream) if (chunk.type === "error") error = chunk.error
          })
          if (!(error instanceof Error)) throw new Error("the SDK must expose the WebSocket provider failure")
          const parsed = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("relay") })
          expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
          if (!SessionV1.APIError.isInstance(parsed)) throw new Error("Expected APIError")
          expect(parsed.data).toStrictEqual({
            message: "invalid request",
            statusCode: 400,
            isRetryable: false,
            responseHeaders: { "content-type": "application/json", "x-request-id": "req_nested" },
            responseBody: errorEvent,
            metadata: { url: `http://127.0.0.1:${server.port}/v1/responses` },
          })
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider preserves the SDK error part for a terminal response.failed", () =>
  Effect.gen(function* () {
    const errorEvent = JSON.stringify({
      type: "response.failed",
      sequence_number: 1,
      response: {
        id: "resp_terminal",
        status: 200,
        error: { type: "server_error", code: "server_error", message: "upstream failed" },
      },
    })
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (request.headers.get("upgrade") === "websocket") {
              return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
            }
            return new Response(null, { status: 400 })
          },
          websocket: {
            message(socket) {
              socket.send(errorEvent)
            },
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "hello",
            headers: { "x-session-affinity": "terminal-failure-session" },
            maxRetries: 0,
            onError: () => undefined,
          })
          let error: unknown
          yield* Effect.promise(async () => {
            for await (const chunk of result.fullStream) if (chunk.type === "error") error = chunk.error
          })
          if (!(error instanceof Error)) throw new Error("the SDK must expose the terminal provider failure")
          const parsed = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("relay") })
          expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
          if (!SessionV1.APIError.isInstance(parsed)) throw new Error("Expected APIError")
          expect(parsed.data.message).toBe("upstream failed")
          expect(parsed.data.statusCode).toBe(500)
          expect(parsed.data.isRetryable).toBe(true)
          expect(parsed.data.responseBody).toContain("upstream failed")
          expect(parsed.data.metadata).toStrictEqual({
            url: `http://127.0.0.1:${server.port}/v1/responses`,
            code: "server_error",
          })
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider keeps response.incomplete max_output_tokens as a length finish", () =>
  Effect.gen(function* () {
    const event = {
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (request.headers.get("upgrade") === "websocket") {
              return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
            }
            return new Response(null, { status: 400 })
          },
          websocket: {
            message(socket) {
              socket.send(JSON.stringify(event))
            },
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "hello",
            headers: { "x-session-affinity": "incomplete-length-session" },
            maxRetries: 0,
            onError: () => undefined,
          })
          let finishReason: string | undefined
          let error: unknown
          yield* Effect.promise(async () => {
            for await (const chunk of result.fullStream) {
              if (chunk.type === "error") error = chunk.error
              if (chunk.type === "finish") finishReason = chunk.finishReason
            }
          })
          expect(error).toBeUndefined()
          expect(finishReason).toBe("length")
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider keeps response.incomplete content_filter as a content-filter finish", () =>
  Effect.gen(function* () {
    const event = {
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp_filtered",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (request.headers.get("upgrade") === "websocket") {
              return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
            }
            return new Response(null, { status: 400 })
          },
          websocket: {
            message(socket) {
              socket.send(JSON.stringify(event))
            },
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "hello",
            headers: { "x-session-affinity": "incomplete-filter-session" },
            maxRetries: 0,
            onError: () => undefined,
          })
          let finishReason: string | undefined
          let error: unknown
          yield* Effect.promise(async () => {
            for await (const chunk of result.fullStream) {
              if (chunk.type === "error") error = chunk.error
              if (chunk.type === "finish") finishReason = chunk.finishReason
            }
          })
          expect(error).toBeUndefined()
          expect(finishReason).toBe("content-filter")
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider keeps a 2xx error event as a structured SDK error part", () =>
  Effect.gen(function* () {
    const event = {
      type: "error",
      sequence_number: 1,
      status: 200,
      error: { type: "server_error", code: "server_error", message: "temporary upstream error" },
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (request.headers.get("upgrade") === "websocket") {
              return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
            }
            return new Response(null, { status: 400 })
          },
          websocket: {
            message(socket) {
              socket.send(JSON.stringify(event))
            },
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "hello",
            headers: { "x-session-affinity": "2xx-error-session" },
            maxRetries: 0,
            onError: () => undefined,
          })
          let error: unknown
          yield* Effect.promise(async () => {
            for await (const chunk of result.fullStream) if (chunk.type === "error") error = chunk.error
          })
          if (!(error instanceof Error)) throw new Error("the SDK must expose the 2xx error event")
          const parsed = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("relay") })
          expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
          if (!SessionV1.APIError.isInstance(parsed)) throw new Error("Expected APIError")
          expect(parsed.data).toMatchObject({
            message: "temporary upstream error",
            statusCode: 500,
            isRetryable: true,
            responseHeaders: { "content-type": "text/event-stream" },
            metadata: {
              url: `http://127.0.0.1:${server.port}/v1/responses`,
              code: "server_error",
              type: "server_error",
            },
          })
          expect(parsed.data.responseBody).toContain("temporary upstream error")
        }),
      { config: providerConfig(new URL("/v1", server.url).toString(), true) },
    )
  }),
)

const toolCall = {
  type: "function_call",
  id: "fc_test",
  call_id: "call_test",
  name: "read",
  arguments: "{}",
  status: "completed",
}
const toolCallEvents = [
  { type: "response.created", response: { id: "resp_tool", model: "test-model", created_at: 0 } },
  { type: "response.output_item.added", output_index: 0, item: toolCall },
  { type: "response.output_item.done", output_index: 0, item: toolCall },
  {
    type: "response.completed",
    response: {
      id: "resp_tool",
      model: "test-model",
      created_at: 0,
      output: [toolCall],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
]
const missingToolOutput = {
  type: "error",
  error: {
    type: "invalid_request_error",
    param: "input",
    message: "No tool output found for function call call_test.",
  },
  status: 400,
}

// Upstream model: a connection that already delivered an unanswered tool call
// rejects the next response.create. State lives on the socket, not the payload.
function chainedServer() {
  type Data = { session: string; pendingCalls: boolean }
  type Signal = { promise: Promise<void>; resolve: () => void; settled: boolean }
  const sessions = new Map<string, { connections: number; closes: Signal[] }>()
  const messages: string[] = []
  const entry = (session: string) => {
    const existing = sessions.get(session)
    if (existing) return existing
    const created = { connections: 0, closes: [] as Signal[] }
    sessions.set(session, created)
    return created
  }
  const server = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/v1/responses") return new Response("unexpected", { status: 404 })
      if (request.headers.get("upgrade") !== "websocket") return new Response("http")
      const session = request.headers.get("x-session-affinity") ?? request.headers.get("session-id") ?? ""
      entry(session).connections++
      if (server.upgrade(request, { data: { session, pendingCalls: false } })) return undefined
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        messages.push(socket.data.session)
        if (socket.data.session.startsWith("delete:")) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        const text = String(raw)
        if (text.includes("compaction-continue") && socket.data.pendingCalls) {
          socket.send(JSON.stringify(missingToolOutput))
          return
        }
        if (text.includes("tool-call-step")) {
          socket.data.pendingCalls = true
          for (const event of toolCallEvents) socket.send(JSON.stringify(event))
          return
        }
        for (const event of events) socket.send(JSON.stringify(event))
      },
      close(socket) {
        const signal = entry(socket.data.session).closes.find((item) => !item.settled)
        if (!signal) return
        signal.settled = true
        signal.resolve()
      },
    },
  })
  return {
    url: server.url,
    server,
    connections: (session: string) => sessions.get(session)?.connections ?? 0,
    messages: (session: string) => messages.filter((item) => item === session).length,
    closing(session: string) {
      const resolver = Promise.withResolvers<void>()
      entry(session).closes.push({ ...resolver, settled: false })
      return resolver.promise
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

plainTransport.live("custom provider resets idle Responses sockets on committed compaction with directory filter", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(
      Effect.sync(() => chainedServer()),
      (upstream) => Effect.promise(() => upstream[Symbol.asyncDispose]()),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const bridge = yield* EventV2Bridge.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const first = yield* Session.use.create({})
          const second = yield* Session.use.create({})
          const turn = (sessionID: string) =>
            Effect.promise(
              () =>
                streamText({
                  model: language,
                  prompt: "hello",
                  headers: { "x-session-affinity": sessionID },
                  maxRetries: 0,
                }).text,
            )

          expect(yield* turn(first.id)).toBe("ok")
          expect(yield* turn(second.id)).toBe("ok")

          const secondClosed = upstream.closing(second.id)
          yield* bridge.publish(SessionCompactionEvent.Compacted, { sessionID: second.id })
          yield* awaitWithTimeout(
            Effect.promise(() => secondClosed),
            "compaction must reset the session socket",
          )
          expect(yield* turn(first.id)).toBe("ok")
          expect(upstream.connections(first.id)).toBe(1)

          yield* bridge.publish(
            SessionCompactionEvent.Compacted,
            { sessionID: first.id },
            {
              location: new Location.Info({
                directory: AbsolutePath.make("/tmp/other-directory"),
                project: {
                  id: Project.ID.make("other-project"),
                  directory: AbsolutePath.make("/tmp/other-directory"),
                },
              }),
            },
          )
          expect(yield* turn(first.id)).toBe("ok")
          expect(upstream.connections(first.id)).toBe(1)

          const firstClosed = upstream.closing(first.id)
          yield* bridge.publish(SessionCompactionEvent.Compacted, { sessionID: first.id })
          yield* awaitWithTimeout(
            Effect.promise(() => firstClosed),
            "compaction must reset the session socket",
          )
          expect(yield* turn(first.id)).toBe("ok")
          expect(upstream.connections(first.id)).toBe(2)
          expect(upstream.connections(second.id)).toBe(1)
        }),
      { config: providerConfig(new URL("/v1", upstream.url).toString(), true) },
    )
  }),
)

plainTransport.live("custom provider compaction boundary rejects a reused socket that chains tool calls", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(
      Effect.sync(() => chainedServer()),
      (upstream) => Effect.promise(() => upstream[Symbol.asyncDispose]()),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const bridge = yield* EventV2Bridge.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("relay"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          const session = yield* Session.use.create({})
          const turn = (prompt: string) =>
            Effect.promise(
              () =>
                streamText({
                  model: language,
                  prompt,
                  headers: { "x-session-affinity": session.id },
                  maxRetries: 0,
                }).text,
            )

          // First turn ends in a tool call; its output is dropped by compaction.
          yield* turn("tool-call-step").pipe(Effect.exit)
          expect(upstream.connections(session.id)).toBe(1)

          const closed = upstream.closing(session.id)
          yield* bridge.publish(SessionCompactionEvent.Compacted, { sessionID: session.id })
          yield* awaitWithTimeout(
            Effect.promise(() => closed),
            "compaction must reset the session socket",
          )

          // The summary contains no function call, so a fresh socket is required.
          expect(yield* turn("compaction-continue")).toBe("ok")
          expect(upstream.connections(session.id)).toBe(2)
        }),
      { config: providerConfig(new URL("/v1", upstream.url).toString(), true) },
    )
  }),
)

async function failureError(promise: Promise<string>) {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`Expected an Error, received ${String(error)}`, { cause: error })
    return error
  }
  throw new Error("Expected response text to reject")
}

test("built-in openai plugin resets its Responses socket on session.compacted and still aborts session.deleted", async () => {
  const upstream = chainedServer()
  try {
    const hooks = await CodexAuthPlugin(
      {
        client: createOpencodeClient({ baseUrl: upstream.url.toString() }),
        project: { id: "builtin-openai", worktree: "/tmp/issue868", time: { created: 0 } },
        directory: "/tmp/issue868",
        worktree: "/tmp/issue868",
        experimental_workspace: { register() {} },
        serverUrl: new URL(upstream.url),
        $,
      },
      { experimentalWebSockets: true },
    )
    try {
      const loaded = await hooks.auth!.loader!(async () => ({ type: "api", key: "sk-test" }), {
        id: "openai",
        name: "OpenAI",
        source: "api",
        env: [],
        options: {},
        models: {},
      })
      const send = (sessionID: string) =>
        loaded.fetch!(new URL("/v1/responses", upstream.url).toString(), {
          method: "POST",
          headers: { "session-id": sessionID },
          body: JSON.stringify({ stream: true, input: "hello" }),
        })
      const completed = async (sessionID: string) => {
        const response = await send(sessionID)
        expect(await response.text()).toContain("data: [DONE]")
      }

      await completed("builtin-session")
      expect(upstream.connections("builtin-session")).toBe(1)
      const closed = upstream.closing("builtin-session")
      const compacted: Event = { type: "session.compacted", properties: { sessionID: "builtin-session" } }
      await hooks.event!({ event: compacted })
      await closed
      await completed("builtin-session")
      expect(upstream.connections("builtin-session")).toBe(2)

      const pending = await send("delete:builtin")
      const failure = pending.text()
      const deadline = Date.now() + 1_000
      while (upstream.messages("delete:builtin") === 0) {
        if (Date.now() > deadline) throw new Error("the built-in plugin did not send its delete request")
        await Bun.sleep(1)
      }
      const deleted: Event = {
        type: "session.deleted",
        properties: {
          info: {
            id: "delete:builtin",
            projectID: "builtin-openai",
            directory: "/tmp/issue868",
            title: "Deleted",
            version: "1",
            time: { created: 0, updated: 0 },
          },
        },
      }
      await hooks.event!({ event: deleted })
      expect(await failureError(failure)).toMatchObject({
        name: "AbortError",
        message: "WebSocket session removed",
      })
    } finally {
      await hooks.dispose?.()
    }
  } finally {
    await upstream[Symbol.asyncDispose]()
  }
})
