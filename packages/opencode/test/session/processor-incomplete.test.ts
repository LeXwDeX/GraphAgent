import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Part } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
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
import { ToolInputRejectedError } from "../../src/session/llm/ai-sdk"

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

const user = Effect.fn("IncompleteTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("IncompleteTest.assistant")(function* (
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

/**
 * Builds a processor environment backed by a scripted LLM.Service. Each
 * processor attempt consumes the next script; the last script repeats.
 */
function scripted(scripts: LLMEvent[][]) {
  let calls = 0
  const service = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: () => {
        const script = scripts[Math.min(calls, scripts.length - 1)]
        calls += 1
        return Stream.fromIterable(script)
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

const boot = Effect.fn("IncompleteTest.boot")(function* () {
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

const incompleteScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-a", name: "lookup" }),
  LLMEvent.toolInputDelta({ id: "call-a", name: "lookup", text: '{"que' }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  LLMEvent.finish({ reason: "unknown" }),
]

const recoveredScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-b", name: "lookup" }),
  LLMEvent.toolInputDelta({ id: "call-b", name: "lookup", text: '{"query":"x"}' }),
  LLMEvent.toolInputEnd({ id: "call-b", name: "lookup" }),
  LLMEvent.toolCall({ id: "call-b", name: "lookup", input: { query: "x" } }),
  LLMEvent.toolResult({
    id: "call-b",
    name: "lookup",
    result: { type: "json", value: { title: "Lookup", output: "ok", metadata: {} } },
  }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.stepStart({ index: 1 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "done" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 1, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

// ---------------------------------------------------------------------------
// Retry admission and eventual success
// ---------------------------------------------------------------------------

const recovered = scripted([incompleteScript, recoveredScript])

recovered.it.effect(
  "session.processor retries an incomplete tool response and recovers with a valid follow-up",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run the lookup")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(recovered.count()).toBe(2)

        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        expect(calls).toHaveLength(2)
        const stale = calls.find((part) => part.callID === "call-a")
        const fresh = calls.find((part) => part.callID === "call-b")
        expect(stale?.state.status).toBe("error")
        if (stale?.state.status === "error") {
          expect(stale.state.metadata?.interrupted).toBe(true)
        }
        expect(fresh?.state.status).toBe("completed")
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Complete response with unknown finish is not retried
// ---------------------------------------------------------------------------

const completeUnknown = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "plain answer" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

completeUnknown.it.effect(
  "session.processor does not retry a complete response with an unknown finish reason",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(completeUnknown.count()).toBe(1)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Executed tool plus unfinished input never replays
// ---------------------------------------------------------------------------

const mixedExecuted = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
    LLMEvent.toolResult({
      id: "call-1",
      name: "lookup",
      result: { type: "json", value: { title: "Lookup", output: "done", metadata: {} } },
    }),
    LLMEvent.toolInputStart({ id: "call-2", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-2", name: "lookup", text: '{"qu' }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

mixedExecuted.it.effect(
  "session.processor never replays a request that executed a tool and still ended incomplete",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "mixed tools")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(mixedExecuted.count()).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        const executed = calls.find((part) => part.callID === "call-1")
        const unfinished = calls.find((part) => part.callID === "call-2")
        expect(executed?.state.status).toBe("completed")
        expect(unfinished?.state.status).toBe("error")
        if (unfinished?.state.status === "error") {
          expect(unfinished.state.error).toBe("Tool execution aborted")
          expect(unfinished.state.metadata?.interrupted).toBe(true)
        }
        expect(result).toBe("continue")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Tool error signal blocks recovery
// ---------------------------------------------------------------------------

const toolErrored = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
    LLMEvent.toolResult({ id: "call-1", name: "lookup", result: { type: "error", value: "permission denied" } }),
    LLMEvent.toolInputStart({ id: "call-2", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-2", name: "lookup", text: '{"qu' }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

toolErrored.it.effect(
  "session.processor does not recover after a tool execution error in the failed request",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(toolErrored.count()).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        const failed = toolParts(parts).find((part) => part.callID === "call-1")
        expect(failed?.state.status).toBe("error")
        expect(result).toBe("continue")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Normal completion plus interrupted orphan stays on the existing path
// ---------------------------------------------------------------------------

const normalOrphan = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-a", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-a", name: "lookup", text: '{"que' }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

normalOrphan.it.effect(
  "session.processor keeps the no-extra-request behavior for a normal stop with an interrupted orphan",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "orphan")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(normalOrphan.count()).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        const orphan = toolParts(parts)[0]
        expect(orphan?.state.status).toBe("error")
        if (orphan?.state.status === "error") {
          expect(orphan.state.error).toBe("Tool execution aborted")
          expect(orphan.state.metadata?.interrupted).toBe(true)
        }
        expect(msg.finish).toBe("stop")
        expect(result).toBe("continue")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Exhaustion stops with a durable, meaningful error
// ---------------------------------------------------------------------------

const exhausted = scripted([incompleteScript])

exhausted.it.effect(
  "session.processor stops after the finite retry budget and retains a clear error",
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
        const parent = yield* user(chat.id, "always incomplete")
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
          const message = (handle.message.error.data as { message?: string }).message
          expect(message).toContain("tool call")
        }
        expect(yield* sts.get(chat.id)).toMatchObject({ type: "idle" })

        const parts = yield* MessageV2.parts(msg.id)
        const placeholder = toolParts(parts)[0]
        expect(placeholder?.state.status).toBe("error")
        if (placeholder?.state.status === "error") {
          expect(placeholder.state.metadata?.interrupted).toBe(true)
        }
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Cancellation during retry backoff stops further attempts
// ---------------------------------------------------------------------------

const cancelled = scripted([incompleteScript])

cancelled.it.effect(
  "session.processor cancellation during retry backoff stops further attempts",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "cancel")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        // Attempt 1 failed and the schedule is waiting on the first backoff.
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

        const parts = yield* MessageV2.parts(msg.id)
        const placeholder = toolParts(parts)[0]
        expect(placeholder?.state.status).toBe("error")
        if (placeholder?.state.status === "error") {
          expect(placeholder.state.metadata?.interrupted).toBe(true)
        }
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Stale attempt identity: reused call ID cannot overwrite the older placeholder
// ---------------------------------------------------------------------------

const reusedCallID = scripted([
  incompleteScript,
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-a", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-a", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-a", name: "lookup" }),
    LLMEvent.toolCall({ id: "call-a", name: "lookup", input: { query: "x" } }),
    LLMEvent.toolResult({
      id: "call-a",
      name: "lookup",
      result: { type: "json", value: { title: "Lookup", output: "ok", metadata: {} } },
    }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
])

reusedCallID.it.effect(
  "session.processor keeps a retried attempt's tool results from overwriting the failed placeholder",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reuse call id")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(reusedCallID.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        expect(calls).toHaveLength(2)
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.metadata?.interrupted).toBe(true)
        }
        expect(calls[1]?.state.status).toBe("completed")
        if (calls[1]?.state.status === "completed") {
          expect(calls[1].state.input).toEqual({ query: "x" })
          expect(calls[1].state.metadata?.interrupted).toBeUndefined()
        }
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Rejected tool input (adapter sentinel): retry once, then recover
// ---------------------------------------------------------------------------

const rejectedInput = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-a", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-a", name: "lookup", text: '{"que' }),
    LLMEvent.toolCall({ id: "call-a", name: "lookup", input: '{"que' }),
    LLMEvent.toolError({
      id: "call-a",
      name: "lookup",
      message: "Invalid input for tool lookup: JSON parsing failed",
      error: new ToolInputRejectedError("Invalid input for tool lookup: JSON parsing failed"),
    }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
  recoveredScript,
])

rejectedInput.it.effect(
  "session.processor retries a rejected tool input and executes the tool on the next attempt",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "rejected input")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(rejectedInput.count()).toBe(2)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        expect(calls).toHaveLength(2)
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.error).toContain("Invalid input for tool")
        }
        expect(calls[1]?.state.status).toBe("completed")
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Complete response with a rejected input (tool-calls finish) is not retried
// ---------------------------------------------------------------------------

const completeRejected = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"que' }),
    LLMEvent.toolCall({ id: "call-1", name: "lookup", input: '{"que' }),
    LLMEvent.toolError({
      id: "call-1",
      name: "lookup",
      message: "Invalid input for tool lookup: JSON parsing failed",
      error: new ToolInputRejectedError("Invalid input for tool lookup: JSON parsing failed"),
    }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
])

completeRejected.it.effect(
  "session.processor does not retry a complete response whose tool input was rejected",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "complete rejected")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(completeRejected.count()).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.error).toContain("Invalid input for tool")
        }
        expect(result).toBe("continue")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// A real tool error whose text spoofs the old repair-artifact phrase never retries
// ---------------------------------------------------------------------------

const spoofedToolError = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
    LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
    LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
    LLMEvent.toolError({
      id: "call-1",
      name: "lookup",
      message: "unavailable tool 'invalid'",
      error: "unavailable tool 'invalid'",
    }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

spoofedToolError.it.effect(
  "session.processor does not classify a real tool error by its message text",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "spoofed error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(spoofedToolError.count()).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = toolParts(parts)
        expect(calls[0]?.state.status).toBe("error")
        expect(result).toBe("continue")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// P1: a rejected first attempt followed by a complete unknown-finish text
// attempt ends after exactly two attempts
// ---------------------------------------------------------------------------

const rejectedThenUnknownText = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-a", name: "lookup" }),
    LLMEvent.toolInputDelta({ id: "call-a", name: "lookup", text: '{"que' }),
    LLMEvent.toolCall({ id: "call-a", name: "lookup", input: '{"que' }),
    LLMEvent.toolError({
      id: "call-a",
      name: "lookup",
      message: "Invalid input for tool lookup: JSON parsing failed",
      error: new ToolInputRejectedError("Invalid input for tool lookup: JSON parsing failed"),
    }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "plain answer" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
    LLMEvent.finish({ reason: "unknown" }),
  ],
])

rejectedThenUnknownText.it.effect(
  "session.processor resets detection per attempt so a complete unknown-finish follow-up is not retried again",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "rejected then text")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        expect(rejectedThenUnknownText.count()).toBe(2)
        expect(result).toBe("continue")
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)
