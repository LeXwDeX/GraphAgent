import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Part } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Clock, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor, type Result } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Provider } from "@/provider/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("EmptyTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("EmptyTest.assistant")(function* (sessionID: SessionID, parentID: MessageID, root: string) {
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

/**
 * Builds a processor environment backed by a scripted LLM.Service. Each
 * processor attempt consumes the next script; the last script repeats. A
 * `{ fail }` entry makes the stream fail with that error, exercising the
 * recognized API-error retry path before later empty/content scripts.
 */
type Script =
  LLMEvent[] | { fail: LLMEvent } | { activity: "tool-executed" | "suppressed" | "observational"; events: LLMEvent[] }
function scripted(scripts: Script[]) {
  let calls = 0
  const service = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: (input) => {
        const script = scripts[Math.min(calls, scripts.length - 1)]
        calls += 1
        if ("activity" in script) {
          input.onAttemptActivity?.(script.activity)
          return Stream.fromIterable(script.events)
        }
        return "fail" in script ? Stream.fail(script.fail) : Stream.fromIterable(script)
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

const boot = Effect.fn("EmptyTest.boot")(function* () {
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
  messages: [{ role: "user", content: "say something" }],
  tools: {},
})

const toolParts = (parts: Part[]) => parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")

// A bookkeeping-only attempt: start/finish signals, no text, no reasoning, no
// tool activity, unknown finish reason. This is the exact silent-exit shape
// from the issue.
const emptyUnknown: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  LLMEvent.finish({ reason: "unknown" }),
]

const emptyStop: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const validScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "done" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const apiFailScript: Script = {
  fail: LLMEvent.providerError({ message: "Provider is overloaded", retryable: true }),
}

const networkError = LLMEvent.providerError({ message: "network error", retryable: true })

function verifyNoRetry(name: string, first: Script) {
  const fixture = scripted([first, validScript])
  fixture.it.effect(
    name,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, name)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust("90 seconds")
          yield* Fiber.join(run)
          expect(fixture.count()).toBe(1)
        }),
      { config: cfg },
    ),
  )
}

function verifyRetry(name: string, first: Script) {
  const fixture = scripted([first, validScript])
  fixture.it.effect(
    name,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, name)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust("90 seconds")
          expect(yield* Fiber.join(run)).toBe("continue")
          expect(fixture.count()).toBe(2)
        }),
      { config: cfg },
    ),
  )
}

verifyNoRetry("session.processor does not retry a nonempty orphan text delta", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textDelta({ id: "orphan", text: "content" }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
])

verifyNoRetry("session.processor does not retry an unknown finish with answer text", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "answer" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
])

verifyRetry("session.processor retries an abnormal orphan reasoning delta without an answer", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningDelta({ id: "orphan", text: "thought" }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
])

verifyNoRetry("session.processor preserves suppressed activity when there is no finish", {
  activity: "suppressed",
  events: [LLMEvent.stepStart({ index: 0 })],
})

verifyRetry("session.processor retries a network failure after suppressed provider activity", {
  activity: "observational",
  events: [LLMEvent.stepStart({ index: 0 }), networkError],
})

verifyNoRetry("session.processor does not replay after suppressed approval or abort activity", {
  activity: "suppressed",
  events: [LLMEvent.stepStart({ index: 0 }), networkError],
})

verifyNoRetry("session.processor treats unclassified suppressed metadata as retry-blocking", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown", providerMetadata: { opencode: { suppressedActivity: true } } }),
  networkError,
])

verifyNoRetry("session.processor does not replay a tool that executed before its stream event arrived", {
  activity: "tool-executed",
  events: [LLMEvent.stepStart({ index: 0 }), networkError],
})

verifyNoRetry("session.processor does not replay a tool result after a network failure", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
  LLMEvent.toolResult({ id: "call-1", name: "lookup", result: { type: "text", value: "done" } }),
  networkError,
])

verifyNoRetry("session.processor does not replay an admitted tool after a network failure", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
  networkError,
])

const toolInputNetwork = scripted([
  [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }), networkError],
  validScript,
])

toolInputNetwork.it.effect(
  "session.processor clears unexecuted tool input before retrying a network failure",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool input network")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(run)).toBe("continue")
        expect(toolInputNetwork.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        expect(toolParts(parts).every((part) => part.state.status === "error")).toBe(true)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { config: cfg },
  ),
)

const partialNetwork = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reason-1" }),
    LLMEvent.reasoningDelta({ id: "reason-1", text: "thinking" }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "partial" }),
    networkError,
  ],
  validScript,
])

partialNetwork.it.effect(
  "session.processor retries an explicit network failure after partial reasoning and text",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "partial network")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(run)).toBe("continue")
        expect(partialNetwork.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "reasoning" && part.text === "thinking")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "partial" && part.time?.end)).toBe(true)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Recovery: empty attempt is retried and a valid follow-up continues the turn
// ---------------------------------------------------------------------------

const recovered = scripted([emptyUnknown, validScript])

recovered.it.effect(
  "session.processor retries a bookkeeping-only empty response and recovers with the next attempt",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "say something")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(recovered.count()).toBe(2)
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(toolParts(parts)).toHaveLength(0)
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Zero-length text is empty; whitespace text is not (no trimming)
// ---------------------------------------------------------------------------

const zeroLengthText = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
  validScript,
])

zeroLengthText.it.effect(
  "session.processor treats a zero-length text attempt as empty and retries",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "zero text")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(zeroLengthText.count()).toBe(2)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

const whitespaceText = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: " " }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

whitespaceText.it.effect(
  "session.processor does not treat whitespace-only text as an empty response",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "whitespace")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(whitespaceText.count()).toBe(1)
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Reasoning: non-empty reasoning is content; zero-length reasoning is empty
// ---------------------------------------------------------------------------

const reasoningOnly = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reason-1" }),
    LLMEvent.reasoningDelta({ id: "reason-1", text: "thinking" }),
    LLMEvent.reasoningEnd({ id: "reason-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

reasoningOnly.it.effect(
  "session.processor accepts a completed reasoning-only stop response",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(reasoningOnly.count()).toBe(1)
      }),
    { config: cfg },
  ),
)

// A synchronous continuation is only for a request that ended with reasoning and nothing else. Provider activity
// that is not session-visible (a source or file chunk: `observational`) means the request did produce output, so
// the processor must not split; the deferred reasoning is organized in place instead.
const deferredReasoningScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "reason-1" }),
  LLMEvent.reasoningDelta({ id: "reason-1", text: "thinking" }),
  LLMEvent.reasoningEnd({ id: "reason-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

function deferReasoning(unused: string[]) {
  return {
    onReasoningSettled: (_part: SessionV1.ReasoningPart, canDefer: boolean) =>
      Effect.succeed(canDefer ? ("defer" as const) : ("continue" as const)),
    onReasoningUnused: (parts: readonly SessionV1.ReasoningPart[]) =>
      Effect.sync(() => {
        unused.push(...parts.map((part) => part.id))
      }),
  }
}

function verifyReasoningShaping(name: string, first: Script, expected: Result, unusedCount: number) {
  const fixture = scripted([first])
  fixture.it.effect(
    name,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, name)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const unused: string[] = []
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            ...deferReasoning(unused),
          })
          const result = yield* handle.process(input(chat.id, parent, mdl))
          expect(result).toBe(expected)
          expect(unused).toHaveLength(unusedCount)
        }),
      { config: cfg },
    ),
  )
}

verifyReasoningShaping(
  "session.processor continues a request that ends with deferred reasoning alone",
  deferredReasoningScript,
  "split",
  0,
)

verifyReasoningShaping(
  "session.processor keeps observational activity in place instead of continuing",
  { activity: "observational", events: deferredReasoningScript },
  "continue",
  1,
)

const incompleteReasoning: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "reason-1" }),
  LLMEvent.reasoningDelta({ id: "reason-1", text: "unfinished thought" }),
  LLMEvent.reasoningEnd({ id: "reason-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  LLMEvent.finish({ reason: "unknown" }),
]

const reasoningUnknown = scripted([incompleteReasoning, validScript])

reasoningUnknown.it.effect(
  "session.processor retries unknown reasoning-only output and discards failed reasoning",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning without answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(run)).toBe("continue")
        expect(reasoningUnknown.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { config: cfg },
  ),
)

const opaqueReasoningUnknown = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({
      id: "opaque-1",
      providerMetadata: { openai: { reasoningEncryptedContent: "test-encrypted-state" } },
    }),
    LLMEvent.reasoningEnd({ id: "opaque-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  ],
  validScript,
])

opaqueReasoningUnknown.it.effect(
  "session.processor retries opaque-only unknown reasoning without replaying its metadata",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "opaque reasoning without answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(run)).toBe("continue")
        expect(opaqueReasoningUnknown.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
        expect(JSON.stringify(parts)).not.toContain("test-encrypted-state")
        const { db } = yield* Database.Service
        const v2 = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, chat.id)).all()
        const projected = JSON.stringify(v2.filter((row) => row.type === "assistant"))
        expect(projected).toContain("failedAttempt")
        expect(projected).not.toContain("test-encrypted-state")
      }),
    { config: cfg },
  ),
)

const missingFinishReasoning = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reason-1" }),
    LLMEvent.reasoningDelta({ id: "reason-1", text: "interrupted thought" }),
  ],
  validScript,
])

missingFinishReasoning.it.effect(
  "session.processor retries a stream that drains after reasoning without finish",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stream ended")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(run)).toBe("continue")
        expect(missingFinishReasoning.count()).toBe(2)
      }),
    { config: cfg },
  ),
)

verifyNoRetry("session.processor accepts opaque-only reasoning with a completed stop", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "opaque-1", providerMetadata: { openai: { reasoningEncryptedContent: "opaque" } } }),
  LLMEvent.reasoningEnd({ id: "opaque-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
])

verifyRetry("session.processor treats empty nested reasoning metadata and zero text as empty", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "empty-meta", providerMetadata: { openai: {} } }),
  LLMEvent.reasoningEnd({ id: "empty-meta", providerMetadata: { anthropic: { signature: "" } } }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
])

verifyNoRetry("session.processor honors a final stop without step-finish for reasoning", [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "reason-1" }),
  LLMEvent.reasoningDelta({ id: "reason-1", text: "complete" }),
  LLMEvent.reasoningEnd({ id: "reason-1" }),
  LLMEvent.finish({ reason: "stop" }),
])

const zeroReasoning = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reason-1" }),
    LLMEvent.reasoningEnd({ id: "reason-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
  validScript,
])

zeroReasoning.it.effect(
  "session.processor treats a zero-length reasoning attempt as empty and retries",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "zero reasoning")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(zeroReasoning.count()).toBe(2)
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Tool activity is never eligible for the empty path
// ---------------------------------------------------------------------------

const completeInputNoCall = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

completeInputNoCall.it.effect(
  "session.processor keeps complete tool input without an executable call out of the empty path",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "input only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(completeInputNoCall.count()).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

const inputEndNoCall = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

inputEndNoCall.it.effect(
  "session.processor keeps tool input signals without deltas or calls out of the empty path",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "input end only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(inputEndNoCall.count()).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

const executedToolStop = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
    LLMEvent.toolResult({
      id: "call-1",
      name: "lookup",
      result: { type: "json", value: { title: "Lookup", output: "ok", metadata: {} } },
    }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

executedToolStop.it.effect(
  "session.processor keeps a stop finish with executed tools out of the empty path",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "executed tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(executedToolStop.count()).toBe(1)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Finish reasons that stay outside the empty gate
// ---------------------------------------------------------------------------

const lengthFinish = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "length" }),
    LLMEvent.finish({ reason: "length" }),
  ],
])

lengthFinish.it.effect(
  "session.processor does not retry an empty response with an explicit length finish",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "length")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(lengthFinish.count()).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

const contentFilterFinish = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "content-filter" }),
    LLMEvent.finish({ reason: "content-filter" }),
  ],
])

contentFilterFinish.it.effect(
  "session.processor does not retry an empty response with a content-filter finish",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "content filter")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(contentFilterFinish.count()).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// A known stop finish with no content is empty (bookkeeping-only assistant)
// ---------------------------------------------------------------------------

const stopEmpty = scripted([emptyStop, validScript])

stopEmpty.it.effect(
  "session.processor retries a bookkeeping-only stop finish and recovers with the next attempt",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stop empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(stopEmpty.count()).toBe(2)
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Exhaustion: repeated empty responses end with a clear persisted error
// ---------------------------------------------------------------------------

const exhausted = scripted([emptyUnknown])

exhausted.it.effect(
  "session.processor stops after the finite budget on repeated empty responses with a clear error",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service
        const retried: number[] = []
        const errors: string[] = []
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Retried.type && Schema.is(SessionEvent.Retried.data)(event.data)) {
            retried.push(event.data.attempt)
          }
          if (event.type === Session.Event.Error.type && Schema.is(Session.Event.Error.data)(event.data)) {
            if (event.data.error) errors.push(event.data.error.name)
          }
          return Effect.void
        })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "always empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("10 minutes")
        const result = yield* Fiber.join(run)
        yield* off

        expect(result).toBe("stop")
        expect(exhausted.count()).toBe(6)
        expect(retried).toStrictEqual([1, 2, 3, 4, 5])
        expect(errors).toContain("APIError")
        expect(handle.message.error).toBeDefined()
        expect(handle.message.error?.name).toBe("APIError")
        if (handle.message.error && "data" in handle.message.error) {
          const data = handle.message.error.data as { message?: string; metadata?: Record<string, unknown> }
          expect(data.message).toContain("empty")
          expect(data.metadata?.code).toBe("empty_response")
        }
        expect(yield* sts.get(chat.id)).toMatchObject({ type: "idle" })

        // Single-turn history: no tool parts persisted and nothing replayed.
        const parts = yield* MessageV2.parts(msg.id)
        expect(toolParts(parts)).toHaveLength(0)
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Empty and reasoning-only failures share one budget, even when alternating.
// ---------------------------------------------------------------------------

const alternatingExhaustion = scripted([
  emptyUnknown,
  incompleteReasoning,
  emptyUnknown,
  incompleteReasoning,
  emptyUnknown,
  incompleteReasoning,
])

alternatingExhaustion.it.effect(
  "session.processor shares one finite budget across empty and reasoning-only failures",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "always incomplete")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const clock = yield* TestClock.testClockWith(Effect.succeed)
        // Let each actual retry sleep advance virtual time at its registration
        // point. A large one-shot adjustment can overtake async persistence.
        const result = yield* handle
          .process(input(chat.id, parent, mdl))
          .pipe(Effect.provideService(Clock.Clock, { ...clock, sleep: (duration) => clock.adjust(duration) }))
        expect(result).toBe("stop")
        expect(alternatingExhaustion.count()).toBe(6)
        expect(handle.message.error?.name).toBe("APIError")
        if (handle.message.error && "data" in handle.message.error) {
          const data = handle.message.error.data as { metadata?: Record<string, unknown> }
          expect(data.metadata?.code).toBe("incomplete_reasoning_response")
        }
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
        const { db } = yield* Database.Service
        const v2 = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, chat.id)).all()
        const reasoning = v2
          .filter((row) => row.type === "assistant")
          .flatMap((row) =>
            Schema.decodeUnknownSync(SessionMessage.Assistant)({
              ...row.data,
              id: row.id,
              type: row.type,
            }).content.filter((item) => item.type === "reasoning"),
          )
        expect(reasoning).toHaveLength(3)
        expect(
          reasoning.every((item) => item.text === "" && item.providerMetadata?.opencode?.failedAttempt === true),
        ).toBe(true)
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Per-attempt reset: recognized API-error retry followed by an empty attempt
// ---------------------------------------------------------------------------

const apiErrorThenEmpty = scripted([apiFailScript, emptyUnknown, validScript])

apiErrorThenEmpty.it.effect(
  "session.processor resets empty detection per attempt after a recognized API-error retry",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "api then empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("10 minutes")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(apiErrorThenEmpty.count()).toBe(3)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Empty after an earlier successful tool-bearing iteration on the same handle
// ---------------------------------------------------------------------------

const toolTurnScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
  LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
  LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
  LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
  LLMEvent.toolResult({
    id: "call-1",
    name: "lookup",
    result: { type: "json", value: { title: "Lookup", output: "ok", metadata: {} } },
  }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const afterToolTurn = scripted([toolTurnScript, emptyUnknown, validScript])

afterToolTurn.it.effect(
  "session.processor detects an empty attempt after an earlier successful tool-bearing iteration",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool then empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const first = yield* handle.process(input(chat.id, parent, mdl))
        expect(first).toBe("continue")
        expect(afterToolTurn.count()).toBe(1)

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const second = yield* Fiber.join(run)

        expect(second).toBe("continue")
        expect(afterToolTurn.count()).toBe(3)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Cancellation during empty-retry backoff stops further attempts
// ---------------------------------------------------------------------------

const cancelled = scripted([emptyUnknown])

cancelled.it.effect(
  "session.processor cancellation during empty-retry backoff stops further attempts",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "cancel empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        // Attempt 1 ended empty and the schedule is waiting on the first backoff.
        yield* TestClock.adjust("3 seconds")
        expect(cancelled.count()).toBe(2)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        yield* TestClock.adjust("10 minutes")
        expect(cancelled.count()).toBe(2)
      }),
    { config: cfg },
  ),
)
