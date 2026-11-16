// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import type { Part } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
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
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LLMEvent } from "@graphagent/llm"
import { LLMClient } from "@graphagent/llm/route"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { jsonSchema, tool, type Tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { ProviderAdapters } from "@/provider/adapter/registry"
import { AgentScheduler } from "@/session/agent-scheduler"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildPermissionPolicy } from "@/session/child/types"
import { ToolInputRejectedError } from "../../src/session/llm/ai-sdk"

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
]

/**
 * Builds a processor environment backed by a scripted LLM.Service. Each
 * processor attempt consumes the next script; the last script repeats.
 */
function scripted(scripts: LLMEvent[][], options: { denyDoomLoop?: boolean } = {}) {
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
  // #1031 M7 SF-5: the unattended adjudicator denies the doom-loop ask with a
  // `dag_safety:SF-5` reason instead of prompting.
  const doomDenied = Layer.mock(Permission.Service, {
    ask: (request) =>
      request.permission === "doom_loop"
        ? Effect.fail(new PermissionV1.DeniedError({ ruleset: [], reason: "dag_safety:SF-5: denied by test" }))
        : Effect.void,
  })
  const extra = options.denyDoomLoop ? [LayerNode.replace(Permission.node, doomDenied)] : []
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [...replacements, LayerNode.replace(LLM.node, service), ...extra],
    }),
  )
  return { count: () => calls, it }
}

/**
 * Drives the real native LLM runtime with a scripted wire stream, so tool-call
 * admission is observed by the actual adapter and its execution gate.
 */
function nativeScripted(script: LLMEvent[], tools: Record<string, Tool>) {
  const service = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die(new Error("native test does not prepare")),
      stream: () => Stream.fromIterable(script),
      generate: () => Effect.die(new Error("native test does not generate")),
    }),
  )
  const llm = LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(ProviderAdapters.defaultLayer),
    Layer.provide(service),
    Layer.provide(RuntimeFlags.layer({ experimentalNativeLlm: true })),
    Layer.provide(AgentScheduler.defaultLayer),
  )
  // #1031 M7 SF-5: the unattended adjudicator denies the doom-loop ask with a
  // `dag_safety:SF-5` reason instead of prompting.
  const doomDenied = Layer.mock(Permission.Service, {
    ask: (request) =>
      request.permission === "doom_loop"
        ? Effect.fail(new PermissionV1.DeniedError({ ruleset: [], reason: "dag_safety:SF-5: denied by test" }))
        : Effect.void,
  })
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [
        ...replacements,
        LayerNode.replace(LLM.node, llm),
        LayerNode.replace(Permission.node, doomDenied),
      ],
    }),
  )
  return { it, tools }
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
        const errors: string[] = []
        const off = yield* events.listen((event) => {
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

// ---------------------------------------------------------------------------
// SF-5 (unattended doom loop) is a recoverable tool error
// ---------------------------------------------------------------------------

const identicalCall = (id: string): LLMEvent[] => [
  LLMEvent.toolInputStart({ id, name: "lookup" }),
  LLMEvent.toolInputDelta({ id, name: "lookup", text: '{"query":"x"}' }),
  LLMEvent.toolInputEnd({ id, name: "lookup" }),
  LLMEvent.toolCall({ id, name: "lookup", input: { query: "x" } }),
]

const toolOk = (id: string) =>
  LLMEvent.toolResult({
    id,
    name: "lookup",
    result: { type: "json", value: { title: "Lookup", output: "ok", metadata: {} } },
  })

const doomScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  ...identicalCall("call-a"),
  toolOk("call-a"),
  ...identicalCall("call-b"),
  toolOk("call-b"),
  ...identicalCall("call-c"),
  // The adapter may still deliver the result after the admission denial; it
  // must not overwrite the recorded SF-5 error part.
  toolOk("call-c"),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const doomLoop = scripted([doomScript], { denyDoomLoop: true })

doomLoop.it.effect(
  "session.processor turns an unattended SF-5 denial into a tool error and keeps the turn",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "keep trying")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        // The denial is a tool error, not a turn-ending failure: the node can
        // choose another path on the next step.
        expect(result).toBe("continue")
        expect(msg.error).toBeUndefined()
        const calls = toolParts(yield* MessageV2.parts(msg.id))
        expect(calls).toHaveLength(3)
        expect(calls.find((part) => part.callID === "call-a")?.state.status).toBe("completed")
        expect(calls.find((part) => part.callID === "call-b")?.state.status).toBe("completed")
        const denied = calls.find((part) => part.callID === "call-c")
        expect(denied?.state.status).toBe("error")
        if (denied?.state.status === "error") expect(denied.state.error).toContain("dag_safety:SF-5")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// SF-5: the denied native call must not execute
// ---------------------------------------------------------------------------

const executedIds: string[] = []

const lookupTool = tool({
  description: "Lookup",
  inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
  execute: async (_input: unknown, options: { toolCallId: string }) => {
    executedIds.push(options.toolCallId)
    return { ok: true }
  },
})

const nativeDoomScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-a", name: "lookup", input: { query: "x" } }),
  LLMEvent.toolCall({ id: "call-b", name: "lookup", input: { query: "x" } }),
  LLMEvent.toolCall({ id: "call-c", name: "lookup", input: { query: "x" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const nativeDoom = nativeScripted(nativeDoomScript, { lookup: lookupTool })

nativeDoom.it.effect(
  "session.processor does not execute an SF-5-denied native tool call",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        executedIds.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "keep trying")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle
          .process({ ...input(chat.id, parent, mdl), tools: nativeDoom.tools })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        // The denied call never reached the tool; the previous two did.
        expect(executedIds).toEqual(["call-a", "call-b"])
        // The model still sees the denial as that call's tool error, and the
        // turn continues instead of stopping.
        expect(result).toBe("continue")
        expect(msg.error).toBeUndefined()
        const calls = toolParts(yield* MessageV2.parts(msg.id))
        expect(calls).toHaveLength(3)
        expect(calls.find((part) => part.callID === "call-a")?.state.status).toBe("completed")
        expect(calls.find((part) => part.callID === "call-b")?.state.status).toBe("completed")
        const denied = calls.find((part) => part.callID === "call-c")
        expect(denied?.state.status).toBe("error")
        if (denied?.state.status === "error") expect(denied.state.error).toContain("dag_safety:SF-5")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// SF-5 on the default AI SDK runtime: the SDK dispatches a call while the
// processor is still handling its `tool-call` event
// ---------------------------------------------------------------------------

/**
 * One model response: the identical `lookup` call three times. The AI SDK
 * starts running the calls as soon as the response has finished, concurrently
 * with the processor handling the `tool-call` events, so a tool can be
 * dispatched before the doom-loop check of its call has settled.
 */
const identicalCallsModel = new MockLanguageModelV3({
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        for (const id of ["call-a", "call-b", "call-c"])
          controller.enqueue({ type: "tool-call", toolCallId: id, toolName: "lookup", input: '{"query":"x"}' })
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        })
        controller.close()
      },
    }),
  }),
})

/**
 * Drives the real LLM layer on the AI SDK runtime (the default) with a scripted
 * language model, so the SDK itself dispatches the tools. The doom-loop ask of
 * the third call settles only after the SDK has dispatched that call, or after
 * `graceMs` without it doing so (`hang`: never): the slow processor of the race.
 * `order` records when each tool ran and when the ask settled.
 */
function sdkIdenticalCalls(outcome: "deny" | "allow" | "hang", graceMs: number) {
  const order: string[] = []
  const dispatched = Promise.withResolvers<void>()
  const asked = Promise.withResolvers<void>()
  const lookup = tool({
    description: "Lookup",
    inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
    execute: async (_input: unknown, options: { toolCallId: string }) => {
      order.push(`run:${options.toolCallId}`)
      if (options.toolCallId === "call-c") dispatched.resolve()
      return { ok: true }
    },
  })
  const doomLoop = Effect.sync(() => asked.resolve()).pipe(
    Effect.andThen(
      outcome === "hang" ? Effect.never : Effect.promise(() => Promise.race([dispatched.promise, Bun.sleep(graceMs)])),
    ),
    Effect.andThen(Effect.sync(() => order.push("ask"))),
    Effect.andThen(
      outcome === "deny"
        ? Effect.fail(new PermissionV1.DeniedError({ ruleset: [], reason: "dag_safety:SF-5: denied by test" }))
        : Effect.void,
    ),
  )
  const permission = Layer.mock(Permission.Service, {
    ask: (request) => (request.permission === "doom_loop" ? doomLoop : Effect.void),
  })
  // Only `getLanguage` is scripted; the model catalog and credentials stay real.
  const provider = Layer.effect(
    Provider.Service,
    Effect.gen(function* () {
      const real = yield* Provider.Service
      return Provider.Service.of({ ...real, getLanguage: () => Effect.succeed(identicalCallsModel) })
    }),
  ).pipe(Layer.provide(Provider.defaultLayer))
  const client = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die(new Error("AI SDK test does not prepare")),
      stream: () => Stream.die(new Error("AI SDK test does not stream natively")),
      generate: () => Effect.die(new Error("AI SDK test does not generate")),
    }),
  )
  const llm = LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(provider),
    Layer.provide(ProviderAdapters.defaultLayer),
    Layer.provide(client),
    Layer.provide(RuntimeFlags.layer({ experimentalNativeLlm: false })),
    Layer.provide(AgentScheduler.defaultLayer),
  )
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [...replacements, LayerNode.replace(LLM.node, llm), LayerNode.replace(Permission.node, permission)],
    }),
  )
  return { it, order, lookup, asked: asked.promise }
}

/** Registers `sessionID` as the session of an active child run until the scope ends. */
const childRun = (sessionID: SessionID, parentSessionID: SessionID, permission: ChildPermissionPolicy) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const owner = { kind: "dag_node" as const, workflowID: "dag_gate", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_gate_${sessionID}`,
        childSessionID: sessionID,
        parentSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission,
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

const sdkDoom = sdkIdenticalCalls("deny", 250)

sdkDoom.it.effect(
  "session.processor does not run an SF-5-denied call the AI SDK dispatched before the denial",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        yield* childRun(chat.id, SessionID.make("ses_gate_root"), { ask: "auto" })
        const parent = yield* user(chat.id, "keep trying")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle
          .process({ ...input(chat.id, parent, mdl), tools: { lookup: sdkDoom.lookup } })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const result = yield* Fiber.join(run)

        // The denied call never reached the tool; the previous two did.
        expect(sdkDoom.order.filter((entry) => entry.startsWith("run:")).toSorted()).toEqual([
          "run:call-a",
          "run:call-b",
        ])
        // The model still sees the denial as that call's tool error, and the
        // turn continues instead of stopping.
        expect(result).toBe("continue")
        expect(msg.error).toBeUndefined()
        const calls = toolParts(yield* MessageV2.parts(msg.id))
        expect(calls).toHaveLength(3)
        expect(calls.find((part) => part.callID === "call-a")?.state.status).toBe("completed")
        expect(calls.find((part) => part.callID === "call-b")?.state.status).toBe("completed")
        const denied = calls.find((part) => part.callID === "call-c")
        expect(denied?.state.status).toBe("error")
        if (denied?.state.status === "error") expect(denied.state.error).toContain("dag_safety:SF-5")
      }),
    { config: cfg },
  ),
)

const sdkParked = sdkIdenticalCalls("hang", 0)

sdkParked.it.effect(
  "session.processor never runs an AI SDK call parked for its verdict once the turn is interrupted",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const unhandled: unknown[] = []
        const record = (reason: unknown) => unhandled.push(reason)
        process.on("unhandledRejection", record)
        yield* Effect.addFinalizer(() => Effect.sync(() => process.off("unhandledRejection", record)))
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        yield* childRun(chat.id, SessionID.make("ses_gate_root"), { ask: "auto" })
        const parent = yield* user(chat.id, "keep trying")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle
          .process({ ...input(chat.id, parent, mdl), tools: { lookup: sdkParked.lookup } })
          .pipe(Effect.forkChild)
        // The doom-loop check of the third call never settles: the SDK has
        // dispatched it and its `execute` is parked on the verdict.
        yield* Effect.promise(() => sdkParked.asked)
        yield* Effect.promise(() => Bun.sleep(100))
        const parked = sdkParked.order.toSorted()

        // The processor's cleanup waits on the test clock, so assert only once
        // the interruption has completed.
        const interrupting = yield* Fiber.interrupt(run).pipe(Effect.forkChild)
        yield* TestClock.adjust("90 seconds")
        yield* Fiber.join(interrupting)
        // The interrupted request is over: the parked call must not run late,
        // and abandoning its wait leaves nothing unhandled behind.
        yield* Effect.promise(() => Bun.sleep(100))
        expect(parked).toEqual(["run:call-a", "run:call-b"])
        expect(sdkParked.order.toSorted()).toEqual(["run:call-a", "run:call-b"])
        expect(unhandled).toEqual([])
      }),
    { config: cfg },
  ),
)

// Only a run nobody answers asks for can still receive a safety denial, so only
// such a run holds `execute` for the verdict. Every other session keeps running
// its tools while the doom-loop prompt (which may wait for a person) is open.
for (const item of [
  { name: "a DAG node run", permission: { ask: "auto" }, dagMode: undefined, held: true },
  { name: "a task child of a root in DAG mode", permission: { ask: "root-dag-mode" }, dagMode: "on", held: true },
  {
    name: "a task child of a root outside DAG mode",
    permission: { ask: "root-dag-mode" },
    dagMode: "off",
    held: false,
  },
  { name: "a child run that asks its user", permission: { ask: "user" }, dagMode: undefined, held: false },
  { name: "a session without a child run", permission: undefined, dagMode: undefined, held: false },
] satisfies ReadonlyArray<{
  name: string
  permission: ChildPermissionPolicy | undefined
  dagMode: "on" | "off" | undefined
  held: boolean
}>) {
  // A held call can only be seen to wait out the grace period; a call that runs
  // does so right after the response, so its grace period is never spent.
  const sdk = sdkIdenticalCalls("allow", item.held ? 250 : 5000)
  sdk.it.effect(
    `session.processor ${item.held ? "holds" : "does not hold"} AI SDK tool calls for the doom-loop verdict of ${item.name}`,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const root = yield* session.create(item.dagMode ? { dagMode: item.dagMode } : {})
          const chat = yield* session.create({})
          if (item.permission) yield* childRun(chat.id, root.id, item.permission)
          const parent = yield* user(chat.id, "keep trying")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const run = yield* handle
            .process({ ...input(chat.id, parent, mdl), tools: { lookup: sdk.lookup } })
            .pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust("90 seconds")
          const result = yield* Fiber.join(run)

          // The ask settled by itself in both cases and every call ran: what
          // differs is whether the third call ran before or after the ask.
          expect(result).toBe("continue")
          expect(sdk.order.filter((entry) => entry.startsWith("run:")).toSorted()).toEqual([
            "run:call-a",
            "run:call-b",
            "run:call-c",
          ])
          const calls = toolParts(yield* MessageV2.parts(msg.id))
          expect(calls.map((part) => part.state.status)).toEqual(["completed", "completed", "completed"])
          const ranBeforeAsk = sdk.order.indexOf("run:call-c") < sdk.order.indexOf("ask")
          expect(ranBeforeAsk).toBe(!item.held)
        }),
      { config: cfg },
    ),
  )
}
