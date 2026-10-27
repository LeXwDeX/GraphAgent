import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  LayerNode.replace(SessionSummary.node, summary),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
]
const env = LayerNode.buildLayer(LayerNode.group([root, LayerNode.make(TestLLMServer.layer, [])]), { replacements })

const it = testEffect(env)

const native = testEffect(
  LayerNode.buildLayer(LayerNode.group([root, LayerNode.make(TestLLMServer.layer, [])]), {
    replacements: [
      LayerNode.replace(SessionSummary.node, summary),
      LayerNode.replace(
        RuntimeFlags.node,
        RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true }),
      ),
    ],
  }),
)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect.succeed(undefined),
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.buildLayer(root, {
  replacements: [...replacements, LayerNode.replace(LLM.node, providerErrorLLM)],
})
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect.succeed(undefined),
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.buildLayer(root, {
  replacements: [...replacements, LayerNode.replace(LLM.node, fragmentFailureLLM)],
})
const itFragmentFailure = testEffect(fragmentFailureEnv)

const classifiedProviderErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect.succeed(undefined),
    stream: () =>
      Stream.make(LLMEvent.providerError({ message: "request entity too large", classification: "context-overflow" })),
  }),
)
const classifiedProviderErrorEnv = LayerNode.buildLayer(
  LayerNode.group([root, LayerNode.make(TestLLMServer.layer, [])]),
  {
    replacements: [...replacements, LayerNode.replace(LLM.node, classifiedProviderErrorLLM)],
  },
)
const itClassifiedProviderError = testEffect(classifiedProviderErrorEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const nativeCompactionProcessor = Effect.fn("test.nativeCompactionProcessor")(function* (msg: SessionV1.Assistant) {
  const processors = yield* SessionProcessor.Service
  const provider = yield* Provider.Service
  const model = {
    ...(yield* provider.getModel(ref.providerID, ref.modelID)),
    limit: { context: 32_000, output: 4_000 },
  }
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: msg.sessionID, model })
  return { model, handle }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)
it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          if (!Schema.is(SessionStatus.Event.Status.data)(evt.data)) return Effect.void
          const data = evt.data
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itClassifiedProviderError.live("session.processor preserves classified native provider-error events", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact native provider event")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact native provider event" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

native.live("native tools settle before high usage requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.push(reply().tool("lookup", { query: "weather" }).usage({ input: 30_000, output: 1 }))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "finish the slow lookup before compacting")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const { model, handle } = yield* nativeCompactionProcessor(msg)
        const value = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "finish the slow lookup before compacting" }],
          tools: {
            lookup: tool({
              description: "Delayed lookup",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input, options) => {
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, 500)
                  options.abortSignal?.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(timer)
                      reject(new Error("lookup interrupted"))
                    },
                    { once: true },
                  )
                })
                return { title: "Lookup", output: `result:${input.query}`, metadata: {} }
              },
            }),
          },
        })
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(value).toBe("compact")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.output).toBe("result:weather")
        expect(call.state.input).toEqual({ query: "weather" })
        expect(handle.message.tokens.input).toBe(30_000)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

native.live("native parallel tools all deliver results before compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-parallel",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: ["first", "second"].map((query, index) => ({
                        index,
                        id: `call_${query}`,
                        type: "function",
                        function: { name: "lookup", arguments: JSON.stringify({ query }) },
                      })),
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 30_000, completion_tokens: 1, total_tokens: 30_001 },
              },
            ],
          }),
        )
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "complete both lookups")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const { model, handle } = yield* nativeCompactionProcessor(msg)
        const started: string[] = []
        const bothStarted = defer<void>()
        const value = yield* handle
          .process({
            user: parent,
            sessionID: chat.id,
            model,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "complete both lookups" }],
            tools: {
              lookup: tool({
                description: "Parallel lookup",
                inputSchema: z.object({ query: z.string() }),
                execute: async (input) => {
                  started.push(input.query)
                  if (started.length === 2) bothStarted.resolve()
                  await bothStarted.promise
                  return { title: "Lookup", output: `result:${input.query}`, metadata: {} }
                },
              }),
            },
          })
          .pipe((effect) => awaitWithTimeout(effect, "parallel native tools did not complete", "5 seconds"))
        expect(value).toBe("compact")
        const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
        expect(
          calls.map((part) => ({
            id: part.callID,
            state: part.state.status,
            output: part.state.status === "completed" ? part.state.output : undefined,
          })),
        ).toEqual([
          { id: "call_first", state: "completed", output: "result:first" },
          { id: "call_second", state: "completed", output: "result:second" },
        ])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

native.live("user interruption still aborts a native tool waiting to settle", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.push(reply().tool("lookup", { query: "weather" }).usage({ input: 30_000, output: 1 }))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "cancel the lookup")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const { model, handle } = yield* nativeCompactionProcessor(msg)
        const started = defer<void>()
        let aborted = false
        const run = yield* handle
          .process({
            user: parent,
            sessionID: chat.id,
            model,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "cancel the lookup" }],
            tools: {
              lookup: tool({
                description: "Pending lookup",
                inputSchema: z.object({ query: z.string() }),
                execute: async (_input, options) => {
                  await new Promise<void>((_resolve, reject) => {
                    options.abortSignal?.addEventListener(
                      "abort",
                      () => {
                        aborted = true
                        reject(new Error("lookup interrupted"))
                      },
                      { once: true },
                    )
                    started.resolve()
                  })
                  return { title: "Lookup", output: "unexpected completion", metadata: {} }
                },
              }),
            },
          })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Effect.promise(() => started.promise),
          "native tool did not start",
        )
        yield* awaitWithTimeout(Fiber.interrupt(run), "native tool ignored user interruption")
        expect(aborted).toBe(true)
        const exit = yield* Fiber.await(run)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        const call = (yield* MessageV2.parts(msg.id)).find((part) => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.metadata?.interrupted).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry an incomplete tool response and execute the tool once", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executed = 0
        const { processors, session, provider } = yield* boot()

        // Attempt 1: tool input starts but the stream ends without a finish reason.
        yield* llm.push(reply().pendingTool("lookup", { query: "x" }).item())
        // Attempt 2 (retry): the complete tool call followed by a normal finish.
        yield* llm.push(reply().tool("lookup", { query: "x" }).stop().item())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "incomplete tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "run the lookup" }],
          tools: {
            lookup: tool({
              description: "Pending lookup",
              inputSchema: z.object({ query: z.string() }),
              execute: async () => {
                executed += 1
                return { title: "Lookup", output: "ok", metadata: {} }
              },
            }),
          },
        })

        expect(result).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(executed).toBe(1)

        const parts = yield* MessageV2.parts(msg.id)
        const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(calls).toHaveLength(2)
        // Both attempts reuse call_1: the failed rejected-input placeholder
        // keeps its terminal error (the SDK's InvalidToolInputError message,
        // never an executed repair artifact), the retried call settles into
        // its own part.
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.error).toContain("Invalid input for tool")
          expect(calls[0].state.error).not.toContain("unavailable tool")
        }
        expect(calls[1]?.state.status).toBe("completed")
        if (calls[1]?.state.status === "completed") {
          expect(calls[1].state.input).toEqual({ query: "x" })
          expect(calls[1].state.output).toBe("ok")
          expect(calls[1].state.metadata?.interrupted).toBeUndefined()
        }
        expect(msg.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests keep the lowercase repair path for unknown tool names", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executed = 0
        const { processors, session, provider } = yield* boot()
        // The model calls "LOOKUP" with valid JSON: a NoSuchToolError that the
        // lowercase repair still fixes. Must execute once and never retry.
        yield* llm.push(reply().tool("LOOKUP", { query: "x" }).stop().item())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "uppercase tool name")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "run the lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup",
              inputSchema: z.object({ query: z.string() }),
              execute: async () => {
                executed += 1
                return { title: "Lookup", output: "ok", metadata: {} }
              },
            }),
          },
        })

        expect(result).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(executed).toBe(1)

        const parts = yield* MessageV2.parts(msg.id)
        const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("completed")
        if (calls[0]?.state.status === "completed") {
          expect(calls[0].state.input).toEqual({ query: "x" })
          expect(calls[0].state.output).toBe("ok")
        }
        expect(msg.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests never execute the repair artifact for unknown tool names", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executed = 0
        let invalidExecuted = 0
        const { processors, session, provider } = yield* boot()
        // A fully unknown tool name: the repair artifact renames the call to
        // the reserved "invalid" tool name, but that name is excluded from
        // activeTools, so the SDK's parse fails with NoSuchToolError and the
        // emitted invalid tool-call error is never executed. The model still
        // sees the error text and the request is never auto-retried.
        yield* llm.push(reply().tool("no_such_tool", { query: "x" }).stop().item())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "unknown tool name")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "run the lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup",
              inputSchema: z.object({ query: z.string() }),
              execute: async () => {
                executed += 1
                return { title: "Lookup", output: "ok", metadata: {} }
              },
            }),
            invalid: tool({
              description: "Do not use",
              inputSchema: z.object({ tool: z.string(), error: z.string() }),
              execute: async (input) => {
                invalidExecuted += 1
                return {
                  title: "Invalid Tool",
                  output: `The arguments provided to the tool are invalid: ${input.error}`,
                  metadata: {},
                }
              },
            }),
          },
        })

        expect(result).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(executed).toBe(0)
        expect(invalidExecuted).toBe(0)

        const parts = yield* MessageV2.parts(msg.id)
        const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.error).toContain("unavailable tool 'invalid'")
        }
        expect(msg.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const settlements: Array<typeof SessionEvent.Tool.Failed.Type> = []
        const off = yield* events.listen((event) => {
          if (Schema.is(SessionEvent.Tool.Failed)(event)) settlements.push(event)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(settlements).toHaveLength(1)
        expect(settlements[0]?.data).toMatchObject({
          callID: "call-1",
          error: { type: "unknown", message: "provider boom" },
          result: { type: "error", value: "provider boom" },
          provider: { executed: true },
        })
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests flush partial v2 fragments before step failure", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        let text: string | undefined
        let reasoning: string | undefined
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          if (event.type === SessionEvent.Text.Ended.type)
            text = (event.data as typeof SessionEvent.Text.Ended.data.Type).text
          if (event.type === SessionEvent.Reasoning.Ended.type)
            reasoning = (event.data as typeof SessionEvent.Reasoning.Ended.data.Type).text
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const failed = seen.indexOf(SessionEvent.Step.Failed.type)
        expect(failed).toBeGreaterThan(-1)
        expect(seen.indexOf(SessionEvent.Text.Ended.type)).toBeLessThan(failed)
        expect(seen.indexOf(SessionEvent.Reasoning.Ended.type)).toBeLessThan(failed)
        expect(text).toBe("partial")
        expect(reasoning).toBe("thinking")
      }),
    { config: cfg },
  ),
  // The unclassified provider error goes through the 3s/6s/6s reconnect fallback first.
  30_000,
)

const displayLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect.succeed(undefined),
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "display-first" }),
        LLMEvent.textDelta({ id: "display-first", text: "alpha" }),
        LLMEvent.textEnd({ id: "display-first" }),
        LLMEvent.textStart({ id: "display-second" }),
        LLMEvent.textDelta({ id: "display-second", text: "beta\nlast" }),
        LLMEvent.textEnd({ id: "display-second" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const displayIt = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [...replacements, LayerNode.replace(LLM.node, displayLLM)],
  }),
)
for (const mode of ["interactive", "noninteractive"] as const) {
  displayIt.live(`MessageDisplay holds cross-part lines in their original display position (${mode})`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const calls: Array<{ delta: string; index: number; final: boolean }> = []
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model,
            displayMode: mode,
            onTextDisplay: (batch) =>
              Effect.sync(() => {
                calls.push(batch)
                return batch.delta.toUpperCase()
              }),
          })
          yield* handle.process({
            user: parent as SessionV1.User,
            sessionID: chat.id,
            model,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          const parts = (yield* MessageV2.parts(msg.id)).filter(
            (part): part is SessionV1.TextPart => part.type === "text",
          )
          expect(parts.map((part) => part.text)).toEqual(["alpha", "beta\nlast"])
          expect(parts.map((part) => part.displayText)).toEqual(
            mode === "interactive" ? ["ALPHABETA\n", "LAST"] : ["ALPHABETA\nLAST", ""],
          )
          expect(calls).toEqual(
            mode === "interactive"
              ? [
                  { delta: "alphabeta\n", index: 0, final: false },
                  { delta: "last", index: 1, final: true },
                ]
              : [{ delta: "alphabeta\nlast", index: 0, final: true }],
          )
        }),
      { config: cfg },
    ),
  )
}

for (const mode of ["interactive", "noninteractive"] as const) {
  it.live(`MessageDisplay finalizes partial text once after cancellation (${mode})`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          yield* llm.push(reply().text("partial tail").hang())
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "cancel display")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const calls: Array<{ delta: string; index: number; final: boolean }> = []
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model,
            displayMode: mode,
            onTextDisplay: (batch) =>
              Effect.sync(() => {
                calls.push(batch)
                return batch.delta.toUpperCase()
              }),
          })
          const events = yield* EventV2Bridge.Service
          let textArrived = false
          const off = yield* events.listen((event) =>
            Effect.sync(() => {
              if (event.type !== MessageV2.Event.PartDelta.type) return
              const data = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.data)(event.data)
              if (data.messageID === msg.id && data.delta === "partial tail") textArrived = true
            }),
          )
          yield* Effect.addFinalizer(() => off)
          const work = yield* handle
            .process({
              user: parent as SessionV1.User,
              sessionID: chat.id,
              model,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "cancel display" }],
              tools: {},
            })
            .pipe(Effect.forkChild)
          yield* pollWithTimeout(
            Effect.sync(() => (textArrived ? true : undefined)),
            "partial output did not arrive",
          )
          yield* Fiber.interrupt(work)
          const parts = (yield* MessageV2.parts(msg.id)).filter(
            (part): part is SessionV1.TextPart => part.type === "text",
          )
          expect(parts.map((part) => part.text).join("")).toBe("partial tail")
          expect(parts.map((part) => part.displayText).join("")).toBe("PARTIAL TAIL")
          expect(calls).toEqual([{ delta: "partial tail", index: 0, final: true }])
          expect(handle.message.error?.name).toBe("MessageAbortedError")
        }),
      { config: providerCfg },
    ),
  )
  it.live(`MessageDisplay emits only accepted text after a provider retry (${mode})`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
          yield* llm.text("after retry")
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "retry display")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const calls: Array<{ delta: string; index: number; final: boolean }> = []
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model,
            displayMode: mode,
            onTextDisplay: (batch) =>
              Effect.sync(() => {
                calls.push(batch)
                return batch.delta.toUpperCase()
              }),
          })
          yield* handle.process({
            user: parent as SessionV1.User,
            sessionID: chat.id,
            model,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "retry display" }],
            tools: {},
          })
          const parts = (yield* MessageV2.parts(msg.id)).filter(
            (part): part is SessionV1.TextPart => part.type === "text",
          )
          expect(parts.map((part) => part.text).join("")).toBe("after retry")
          expect(parts.map((part) => part.displayText).join("")).toBe("AFTER RETRY")
          expect(calls).toEqual([{ delta: "after retry", index: 0, final: true }])
          expect(yield* llm.calls).toBe(2)
        }),
      { config: providerCfg },
    ),
  )
}
