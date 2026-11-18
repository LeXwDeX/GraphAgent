// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import type { Part } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { APICallError } from "ai"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Provider } from "@/provider/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionProjector } from "@graphagent/core/session/projector"
import {
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  LLMEvent,
  QuotaExceededReason,
} from "@graphagent/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarizeTurn: () => Effect.void,
    read: () => Effect.succeed([]),
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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("RetryGateTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("RetryGateTest.assistant")(function* (
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
]

type Script = LLMEvent[] | Stream.Stream<LLMEvent, unknown>

/** Each processor attempt consumes the next script; the last script repeats. */
function scripted(scripts: Script[]) {
  let calls = 0
  const service = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: () => {
        const script = scripts[Math.min(calls, scripts.length - 1)]
        calls += 1
        return Array.isArray(script) ? Stream.fromIterable(script) : script
      },
    }),
  )
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [...replacements, LayerNode.replace(LLM.node, service)],
    }),
  )
  return { count: () => calls, it }
}

const boot = Effect.fn("RetryGateTest.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const input = (sessionID: SessionID, parent: SessionV1.User, model: Provider.Model): LLM.StreamInput => ({
  user: {
    id: parent.id,
    sessionID: parent.sessionID,
    role: "user",
    time: parent.time,
    agent: parent.agent,
    model: { providerID: ref.providerID, modelID: ref.modelID },
  } satisfies SessionV1.User,
  sessionID,
  model,
  agent: agent(),
  system: [],
  messages: [{ role: "user", content: "run the lookup" }],
  tools: {},
})

const toolParts = (parts: Part[]) => parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")

const proxyError = (message: string) =>
  new APICallError({
    message,
    url: "http://localhost/v1",
    requestBodyValues: {},
    statusCode: 502,
    responseBody: JSON.stringify({ type: "error", error: { type: "upstream_disconnected", message } }),
    isRetryable: true,
  })

const run = (script: Script) => scripted([script])

const gate = run(
  Stream.concat(
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
      LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
      LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
      LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
    ]),
    Stream.fail(proxyError("upstream_disconnected: upstream did not finish the response; it was not replayed")),
  ),
)

gate.it.effect(
  "session.processor marks a retry-gated interrupted turn non-retryable",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run the lookup")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("stop")
        expect(gate.count()).toBe(1)
        expect(msg.error?.name).toBe("APIError")
        if (msg.error?.name === "APIError") {
          expect(msg.error.data.isRetryable).toBe(false)
          expect(msg.error.data.metadata?.retryBlockedBy).toBe("pending-tools")
          expect(msg.error.data.message).toBe(
            "upstream_disconnected: upstream did not finish the response; it was not replayed",
          )
          expect(msg.error.data.statusCode).toBe(502)
          expect(msg.error.data.responseBody).toContain("upstream_disconnected")
        }
        const calls = toolParts(yield* MessageV2.parts(msg.id))
        expect(calls).toHaveLength(1)
        expect(calls[0].state.status).toBe("error")
      }),
    { config: cfg },
  ),
)

const control = scripted([
  Stream.concat(
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textDelta({ id: "text-1", text: "partial" }),
      LLMEvent.textEnd({ id: "text-1" }),
    ]),
    Stream.fail(proxyError("upstream_disconnected")),
  ),
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-2" }),
    LLMEvent.textDelta({ id: "text-2", text: "recovered" }),
    LLMEvent.textEnd({ id: "text-2" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

control.it.effect(
  "session.processor keeps the retry schedule when no tool was admitted",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("continue")
        expect(control.count()).toBe(2)
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

const textsOf = (parts: Part[]) =>
  parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text)

/** One attempt that streams `text` and is then cut off by a retryable proxy failure. */
const partialThenDisconnect = (text: string, options: { ended: boolean }) =>
  Stream.concat(
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textDelta({ id: "text-1", text }),
      ...(options.ended ? [LLMEvent.textEnd({ id: "text-1" })] : []),
    ]),
    Stream.fail(proxyError("upstream_disconnected")),
  )

const recoveredScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-2" }),
  LLMEvent.textDelta({ id: "text-2", text: "recovered" }),
  LLMEvent.textEnd({ id: "text-2" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

for (const ended of [true, false]) {
  const discard = scripted([partialThenDisconnect("partial", { ended }), recoveredScript])

  discard.it.effect(
    `session.processor drops the partial text of a failed attempt once the retry succeeds (text ${ended ? "ended" : "still open"})`,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "answer")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust("90 seconds")
          const result = yield* Fiber.join(running)

          expect(result).toBe("continue")
          expect(discard.count()).toBe(2)
          expect(msg.error).toBeUndefined()
          expect(textsOf(yield* MessageV2.parts(msg.id))).toEqual(["recovered"])
        }),
      { config: cfg },
    ),
  )
}

const exhaustedPartial = scripted([partialThenDisconnect("partial", { ended: true })])

exhaustedPartial.it.effect(
  "session.processor keeps the last attempt's partial text when the retries are exhausted",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("10 minutes")
        const result = yield* Fiber.join(running)

        expect(result).toBe("stop")
        expect(exhaustedPartial.count()).toBe(6)
        expect(msg.error?.name).toBe("APIError")
        // Earlier attempts were dropped as they were retried; only the final one stays.
        expect(textsOf(yield* MessageV2.parts(msg.id))).toEqual(["partial"])
      }),
    { config: cfg },
  ),
)

for (const mode of ["interactive", "noninteractive"] as const) {
  const display = scripted([partialThenDisconnect("partial\nline", { ended: false }), recoveredScript])

  display.it.effect(
    `session.processor never writes a dropped partial text back through the display path (${mode})`,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "answer")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const calls: Array<{ delta: string; index: number; final: boolean }> = []
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            displayMode: mode,
            onTextDisplay: (batch) =>
              Effect.sync(() => {
                calls.push(batch)
                return batch.delta.toUpperCase()
              }),
          })

          const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust("90 seconds")
          expect(yield* Fiber.join(running)).toBe("continue")

          const parts = (yield* MessageV2.parts(msg.id)).filter(
            (part): part is SessionV1.TextPart => part.type === "text",
          )
          expect(parts.map((part) => part.text)).toEqual(["recovered"])
          expect(parts.map((part) => part.displayText)).toEqual(["RECOVERED"])
          // The interactive line flush already delivered the failed attempt's first line before it was cut off.
          expect(calls.at(-1)).toMatchObject({ delta: "recovered", final: true })
          expect(calls.filter((call) => call.final)).toHaveLength(1)
        }),
      { config: cfg },
    ),
  )
}

const rejected = (statusCode: number, message: string) =>
  new APICallError({
    message,
    url: "http://localhost/v1",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { message } }),
    isRetryable: false,
  })

const spent = run(Stream.fail(rejected(402, "Insufficient Balance")))

spent.it.effect(
  "session.processor stops on a spent balance at once and appends the way out to the persisted message",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("stop")
        // A spent balance is never resent: one request, no backoff.
        expect(spent.count()).toBe(1)
        expect(msg.error?.name).toBe("APIError")
        if (msg.error?.name === "APIError") {
          expect(msg.error.data.message.startsWith("Insufficient Balance\n")).toBe(true)
          expect(msg.error.data.message).toContain("quota or balance used up")
          expect(msg.error.data.message).toContain('Provider "test"')
          // Only the message gains the line; the provider's own fields stay as they came.
          expect(msg.error.data.statusCode).toBe(402)
          expect(msg.error.data.isRetryable).toBe(false)
          expect(msg.error.data.responseBody).toBe('{"error":{"message":"Insufficient Balance"}}')
        }
      }),
    { config: cfg },
  ),
)

const refused = run(Stream.fail(rejected(401, "Incorrect API key provided")))

refused.it.effect(
  "session.processor gives a rejected credential its one bounded retry and then points at the login command",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("stop")
        expect(refused.count()).toBe(2)
        expect(msg.error?.name).toBe("APIError")
        if (msg.error?.name === "APIError") {
          expect(msg.error.data.message.startsWith("Incorrect API key provided\n")).toBe(true)
          expect(msg.error.data.message).toContain("`graphagent providers login --provider test`")
        }
      }),
    { config: cfg },
  ),
)

/** A native-runtime 429 the way the executor reports any body that says "quota exceeded". */
const nativeQuota = (body: string) =>
  new LLMError({
    module: "RequestExecutor",
    method: "execute",
    reason: new QuotaExceededReason({
      message: `Provider request failed with HTTP 429: ${body}`,
      http: new HttpContext({
        request: new HttpRequestDetails({ method: "POST", url: "http://localhost/v1", headers: {} }),
        response: new HttpResponseDetails({ status: 429, headers: {} }),
        body,
      }),
    }),
  })

const windowed = scripted([
  Stream.fail(nativeQuota("Quota exceeded for requests per minute. Please retry in 20 seconds.")),
  recoveredScript,
])

windowed.it.effect(
  "session.processor backs a native per-minute quota 429 off and recovers instead of ending the turn",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("continue")
        expect(windowed.count()).toBe(2)
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

const spentNative = run(Stream.fail(nativeQuota("Quota exceeded. Please top up your account.")))

spentNative.it.effect(
  "session.processor ends the turn at once on a native quota 429 with no sign of a temporary limit",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(running)

        expect(result).toBe("stop")
        expect(spentNative.count()).toBe(1)
        expect(msg.error?.name).toBe("APIError")
        if (msg.error?.name === "APIError") {
          expect(msg.error.data.message).toContain("quota or balance used up")
          expect(msg.error.data.metadata?.code).toBe("QuotaExceeded")
        }
      }),
    { config: cfg },
  ),
)
