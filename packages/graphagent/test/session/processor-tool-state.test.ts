// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import type { Part } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
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
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { InvalidToolInputError, NoSuchToolError } from "ai"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"
import { Tool } from "../../src/tool/tool"

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

const user = Effect.fn("ToolStateTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("ToolStateTest.assistant")(function* (
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

/** Counts processor-side part reads and can gate a persisted transition. */
type Probe = {
  getPart: number
  /** Runs inside the call lock, before the part write; used to hold a transition. */
  beforeUpdatePart?: (part: Part) => Effect.Effect<void>
}

/**
 * Replaces the real Session service with one that observes `getPart` (the
 * processor's only DB read for tool state) and `updatePart` before delegating.
 */
function sessionNode(probe: Probe) {
  const implementation = Layer.effect(
    Session.Service,
    Effect.gen(function* () {
      const real = yield* Session.Service
      return Session.Service.of({
        ...real,
        getPart: (input) =>
          Effect.tap(real.getPart(input), () =>
            Effect.sync(() => {
              probe.getPart += 1
            }),
          ),
        updatePart: <T extends Part>(part: T) =>
          Effect.flatMap(probe.beforeUpdatePart?.(part) ?? Effect.void, () => real.updatePart(part)),
      })
    }),
  ).pipe(Layer.provide(Session.layer))
  // Session.node exposes its dependencies as a widened array; the node itself
  // always has at least one. Reusing them keeps the wrapper's requirements
  // identical to the real service's.
  const dependencies = Session.node.dependencies as unknown as readonly [
    LayerNode.Node<unknown, unknown>,
    ...LayerNode.Node<unknown, unknown>[],
  ]
  return LayerNode.make(implementation, dependencies) as typeof Session.node
}

type Control = {
  /** Pause the scripted stream after `after` events until `wait` completes. */
  gate?: { after: number; wait: Deferred.Deferred<void> }
}

/**
 * Builds a processor environment backed by a scripted LLM.Service. Each
 * processor attempt consumes the next script; the last script repeats.
 */
function scripted(scripts: LLMEvent[][], probe: Probe = { getPart: 0 }) {
  let calls = 0
  const control: Control = {}
  const service = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: () => {
        const script = scripts[Math.min(calls, scripts.length - 1)]
        calls += 1
        const gate = control.gate
        return gate
          ? Stream.concat(
              Stream.fromIterable(script.slice(0, gate.after)),
              Stream.unwrap(Effect.map(Deferred.await(gate.wait), () => Stream.fromIterable(script.slice(gate.after)))),
            )
          : Stream.fromIterable(script)
      },
    }),
  )
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [
        LayerNode.replace(SessionSummary.node, summary),
        LayerNode.replace(LLM.node, service),
        LayerNode.replaceWithNode(Session.node, sessionNode(probe)),
      ],
    }),
  )
  return { count: () => calls, control, probe, it }
}

const boot = Effect.fn("ToolStateTest.boot")(function* () {
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

/** Polls the persisted part without going through Session.getPart. */
const runningPart = Effect.fn("ToolStateTest.runningPart")(function* (messageID: MessageID) {
  for (;;) {
    const parts = yield* MessageV2.parts(messageID)
    const call = toolParts(parts).find((part) => part.callID === "call-1")
    if (call?.state.status === "running") return call
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
})

const lifecycle: LLMEvent[] = [
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
]

// ---------------------------------------------------------------------------
// HS8: the in-memory tool-call state serves every transition without reads
// ---------------------------------------------------------------------------

const noReads = scripted([lifecycle])

noReads.it.effect(
  "session.processor settles a streamed tool call without any part read",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run the lookup")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        // No clock advance: every transition must be served by the cached part.
        const result = yield* handle.process(input(chat.id, parent, mdl))

        expect(result).toBe("continue")
        expect(noReads.count()).toBe(1)
        expect(noReads.probe.getPart).toBe(0)
        const part = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(part?.state.status).toBe("completed")
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// HS8: an unregistered write invalidates the cached copy exactly once
// ---------------------------------------------------------------------------

const external = scripted([lifecycle])

external.it.effect(
  "session.processor reloads once after an unregistered part write and keeps the external change",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run the lookup")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        // Hold the stream after the tool-call admission, so the write below
        // lands between two processor transitions.
        const gate = yield* Deferred.make<void>()
        external.control.gate = { after: 5, wait: gate }
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)

        const running = yield* runningPart(msg.id)
        yield* session.updatePart({ ...running, metadata: { ...running.metadata, external: "kept" } })
        yield* Deferred.succeed(gate, undefined)
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        expect(external.probe.getPart).toBe(1)
        const part = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(part?.state.status).toBe("completed")
        expect(part?.metadata?.external).toBe("kept")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// HS8: forceAbortToolCall vs completeToolCall — exactly one terminal state
// ---------------------------------------------------------------------------

// The stream ends while the call is still running, so cleanup's 250ms grace
// window is the only thing between the call and a forced abort.
const hanging: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
  LLMEvent.toolInputDelta({ id: "call-1", name: "lookup", text: '{"query":"x"}' }),
  LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
  LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { query: "x" } }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const persistedStatus = Effect.fn("ToolStateTest.persistedStatus")(function* (messageID: MessageID) {
  return toolParts(yield* MessageV2.parts(messageID))[0]?.state.status
})

/** Real-time pause so resumed fibers can finish filesystem-backed commits. */
const realYield = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

/** Holds the stream before its final event, so every tool event has settled. */
const gateAtLast = Effect.fnUntraced(function* (control: Control, script: LLMEvent[]) {
  const gate = yield* Deferred.make<void>()
  control.gate = { after: script.length - 1, wait: gate }
  return gate
})

// ---------------------------------------------------------------------------
// HS8: completion inside the cleanup grace window keeps the call completed
// ---------------------------------------------------------------------------

const completionWithinGrace = scripted([hanging])

completionWithinGrace.it.effect(
  "session.processor keeps a tool call completed inside the cleanup grace window",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "late completion")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const gate = yield* gateAtLast(completionWithinGrace.control, hanging)
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* runningPart(msg.id)
        yield* handle.completeToolCall("call-1", { title: "Lookup", metadata: {}, output: "ok" })
        yield* Deferred.succeed(gate, undefined)
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        const part = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(part?.state.status).toBe("completed")
        if (part?.state.status === "completed") expect(part.state.output).toBe("ok")
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// HS8: a result after the grace window cannot overwrite the forced abort
// ---------------------------------------------------------------------------

const abortWins = scripted([hanging])

abortWins.it.effect(
  "session.processor forces the abort when completion arrives after the cleanup grace window",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "late completion")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const gate = yield* gateAtLast(abortWins.control, hanging)
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* runningPart(msg.id)
        yield* Deferred.succeed(gate, undefined)

        // Expire the 250ms grace window. The timeout only fires once the
        // cleanup fiber has registered its deadline, so advance until the
        // forced abort has actually persisted.
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* persistedStatus(msg.id)) === "error") break
          yield* TestClock.adjust("300 millis")
          yield* realYield
        }
        expect(yield* persistedStatus(msg.id)).toBe("error")

        // The late result must not resurrect or overwrite the aborted part.
        yield* handle.completeToolCall("call-1", { title: "Lookup", metadata: {}, output: "late" })
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        const part = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(part?.state.status).toBe("error")
        if (part?.state.status === "error") {
          expect(part.state.error).toBe("Tool execution aborted")
          expect(part.state.metadata?.interrupted).toBe(true)
          expect(part.state.metadata?.outcome).toBe("aborted")
        }
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// HS8: a forced abort waits for a completion that already holds the call lock
// ---------------------------------------------------------------------------

const abortWaits = scripted([hanging])

abortWaits.it.effect(
  "session.processor does not force an abort while a completion holds the call lock",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "held completion")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const completing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        abortWaits.probe.beforeUpdatePart = (part) =>
          part.type === "tool" && part.state.status === "completed"
            ? Effect.flatMap(Deferred.succeed(completing, undefined), () => Deferred.await(release))
            : Effect.void

        const gate = yield* gateAtLast(abortWaits.control, hanging)
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* runningPart(msg.id)
        yield* Deferred.succeed(gate, undefined)

        // The completion acquires the call lock and stalls at the final write.
        const completion = yield* handle
          .completeToolCall("call-1", { title: "Lookup", metadata: {}, output: "ok" })
          .pipe(Effect.forkChild)
        yield* Deferred.await(completing)

        // Expire the grace window while the lock is held: the forced abort
        // cannot claim or overwrite the call, so its part stays running.
        for (let attempt = 0; attempt < 20; attempt++) {
          yield* TestClock.adjust("300 millis")
          yield* realYield
        }
        expect(yield* persistedStatus(msg.id)).toBe("running")

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(completion)
        const result = yield* Fiber.join(run)

        expect(result).toBe("continue")
        const part = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(part?.state.status).toBe("completed")
        if (part?.state.status === "completed") expect(part.state.output).toBe("ok")
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// #1473: a failed call records its class in `metadata.outcome`
// ---------------------------------------------------------------------------

const failedCall = (id: string, tool: string, error: unknown): LLMEvent[] => [
  LLMEvent.toolInputStart({ id, name: tool }),
  LLMEvent.toolInputDelta({ id, name: tool, text: `{"query":"${id}"}` }),
  LLMEvent.toolInputEnd({ id, name: tool }),
  LLMEvent.toolCall({ id, name: tool, input: { query: id } }),
  error instanceof Error
    ? LLMEvent.toolError({ id, name: tool, message: error.message, error })
    : LLMEvent.toolResult({ id, name: tool, result: { type: "error", value: error } }),
]

const failures = scripted([
  [
    LLMEvent.stepStart({ index: 0 }),
    ...failedCall("call-invalid", "lookup", new Tool.InvalidArgumentsError({ tool: "lookup", detail: "bad" })),
    ...failedCall("call-denied", "fetch", new PermissionV1.RejectedError()),
    ...failedCall("call-thrown", "search", new Error("boom")),
    ...failedCall("call-text", "grep", "plain text failure"),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

failures.it.effect(
  "session.processor records the failure class of each failed call in metadata.outcome",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fail four ways")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process(input(chat.id, parent, mdl))

        const parts = toolParts(yield* MessageV2.parts(msg.id))
        const outcomes = Object.fromEntries(
          parts.map((part) => [part.callID, part.state.status === "error" ? part.state.metadata : undefined]),
        )
        expect(outcomes).toEqual({
          "call-invalid": { outcome: "validation_error" },
          "call-denied": { outcome: "denied" },
          "call-thrown": { outcome: "execution_error" },
          "call-text": { outcome: "execution_error" },
        })
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// #1473: corrections made before a call failed or was aborted stay on its error part
// ---------------------------------------------------------------------------

/** The running part of `call-1`, narrowed for a test that rewrites its state. */
const runningState = Effect.fn("ToolStateTest.runningState")(function* (messageID: MessageID) {
  const part = yield* runningPart(messageID)
  if (part.state.status !== "running") return yield* Effect.die(new Error("expected a running call"))
  return { part, state: part.state }
})

const repairedThenFailed = scripted([
  [
    ...lifecycle.slice(0, 5),
    LLMEvent.toolError({ id: "call-1", name: "lookup", message: "boom", error: new Error("boom") }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
])

repairedThenFailed.it.effect(
  "session.processor keeps the corrections of the running part when the call fails",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fail after repair")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        // Hold the stream after the tool call, as the real tool wrapper writes its mark while the call runs.
        const gate = yield* Deferred.make<void>()
        repairedThenFailed.control.gate = { after: 5, wait: gate }
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        const { part, state } = yield* runningState(msg.id)
        yield* session.updatePart({ ...part, state: { ...state, metadata: { corrections: ["args_repaired"] } } })
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(run)

        const failed = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(failed?.state.status).toBe("error")
        if (failed?.state.status === "error") {
          expect(failed.state.metadata).toEqual({ corrections: ["args_repaired"], outcome: "execution_error" })
        }
        // The projection books the same corrections under the failure class.
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ToolOutcomeTable).all()
        expect(rows).toMatchObject([{ tool: "lookup", outcome: "execution_error", corrections: ["args_repaired"] }])
      }),
    { config: cfg },
  ),
)

const repairedThenAborted = scripted([hanging])

repairedThenAborted.it.effect(
  "session.processor keeps the corrections of the running part when the call is force-aborted",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort after repair")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const gate = yield* gateAtLast(repairedThenAborted.control, hanging)
        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        const { part, state } = yield* runningState(msg.id)
        yield* session.updatePart({ ...part, state: { ...state, metadata: { corrections: ["args_repaired"] } } })
        yield* Deferred.succeed(gate, undefined)

        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* persistedStatus(msg.id)) === "error") break
          yield* TestClock.adjust("300 millis")
          yield* realYield
        }
        yield* Fiber.join(run)

        const aborted = toolParts(yield* MessageV2.parts(msg.id))[0]
        expect(aborted?.state.status).toBe("error")
        if (aborted?.state.status === "error") {
          expect(aborted.state.metadata).toEqual({
            corrections: ["args_repaired"],
            interrupted: true,
            outcome: "aborted",
          })
        }
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// #1473: a call whose rejected input was cut off by the output limit is arguments_truncated
// ---------------------------------------------------------------------------

type SDKChunk = Parameters<typeof LLMAISDK.toLLMEvents>[1]

/** Runs chunks written in the AI SDK's shape through the real adapter, as a provider stream reaches the processor. */
const adapted = (chunks: ReadonlyArray<unknown>): LLMEvent[] => {
  const state = LLMAISDK.adapterState()
  return Effect.runSync(
    Effect.forEach(chunks, (chunk) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the chunks are written in the SDK's shape, outside its typed surface
      LLMAISDK.toLLMEvents(state, chunk as SDKChunk),
    ).pipe(Effect.map((events) => events.flat())),
  )
}

/**
 * A call the SDK refused to run, in the order it emits it: an invalid tool-call that carries the typed error,
 * then a tool-error that carries only the text. The finish reason of the step comes later.
 */
const sdkRefusal = (id: string, error: Error, input: string): unknown[] => [
  { type: "tool-input-start", id, toolName: "lookup" },
  { type: "tool-input-delta", id, delta: input },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: "lookup", input, dynamic: true, invalid: true, error },
  { type: "tool-error", toolCallId: id, toolName: "lookup", error: error.message, dynamic: true },
]

/** Input that does not parse: the SDK's InvalidToolInputError, which is what a cut-off call turns into. */
const unparsableCall = (id: string) =>
  sdkRefusal(
    id,
    new InvalidToolInputError({ toolName: "lookup", toolInput: '{"que', cause: new Error("bad json") }),
    '{"que',
  )

/** A call to a tool that does not exist: the SDK's NoSuchToolError. */
const unknownToolCall = (id: string) =>
  sdkRefusal(id, new NoSuchToolError({ toolName: "nope", availableTools: ["lookup"] }), "{}")

const sdkStep = (reason: "length" | "tool-calls", ...calls: unknown[][]): unknown[] => [
  { type: "start-step", request: {}, warnings: [] },
  ...calls.flat(),
  { type: "finish-step", finishReason: reason, rawFinishReason: reason },
]

const sdkFinish = (reason: "length" | "tool-calls"): unknown => ({ type: "finish", finishReason: reason })

/** Runs the scripted stream and returns the failure class of each call, as its part and its projected row hold it. */
const rejectedRun = Effect.fn("ToolStateTest.rejectedRun")(function* (dir: string) {
  const { processors, session, provider } = yield* boot()
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, "rejected input")
  const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  yield* handle.process(input(chat.id, parent, mdl))
  const parts = toolParts(yield* MessageV2.parts(msg.id))
  const { db } = yield* Database.Service
  const rows = yield* db.select().from(ToolOutcomeTable).all()
  const calls = new Map(parts.map((part) => [part.id, part.callID]))
  return {
    parts: Object.fromEntries(
      parts.map((part) => [part.callID, part.state.status === "error" ? part.state.metadata?.outcome : undefined]),
    ),
    rows: Object.fromEntries(rows.map((row) => [calls.get(row.part_id), row.outcome])),
  }
})

const lengthCut = scripted([adapted([...sdkStep("length", unparsableCall("call-cut")), sdkFinish("length")])])

lengthCut.it.effect(
  "session.processor books a rejected input in a step that stopped on length as arguments_truncated",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-cut": "arguments_truncated" })
        expect(result.rows).toEqual({ "call-cut": "arguments_truncated" })
      }),
    { config: cfg },
  ),
)

const notCut = scripted([adapted([...sdkStep("tool-calls", unparsableCall("call-bad")), sdkFinish("tool-calls")])])

notCut.it.effect(
  "session.processor keeps a rejected input in a step that did not stop on length as validation_error",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-bad": "validation_error" })
        expect(result.rows).toEqual({ "call-bad": "validation_error" })
      }),
    { config: cfg },
  ),
)

const twoRejected = scripted([
  adapted([...sdkStep("length", unparsableCall("call-first"), unparsableCall("call-last")), sdkFinish("length")]),
])

twoRejected.it.effect(
  "session.processor books only the last rejected input of a length step as truncated",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-first": "validation_error", "call-last": "arguments_truncated" })
        expect(result.rows).toEqual({ "call-first": "validation_error", "call-last": "arguments_truncated" })
      }),
    { config: cfg },
  ),
)

// The SDK reports a refused unknown tool as a plain string at the tool-error; the adapter keeps what it saw on the
// tool-call, so the call stays a validation error even when its step stopped on length.
const unknownToolCut = scripted([adapted([...sdkStep("length", unknownToolCall("call-unknown")), sdkFinish("length")])])

unknownToolCut.it.effect(
  "session.processor does not book an unknown tool name as truncated arguments",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-unknown": "validation_error" })
        expect(result.rows).toEqual({ "call-unknown": "validation_error" })
      }),
    { config: cfg },
  ),
)

const unknownThenUnparsable = scripted([
  adapted([...sdkStep("length", unknownToolCall("call-unknown"), unparsableCall("call-cut")), sdkFinish("length")]),
])

unknownThenUnparsable.it.effect(
  "session.processor books the unparsable call of a length step as truncated and leaves an unknown tool alone",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-unknown": "validation_error", "call-cut": "arguments_truncated" })
      }),
    { config: cfg },
  ),
)

const unparsableThenUnknown = scripted([
  adapted([...sdkStep("length", unparsableCall("call-cut"), unknownToolCall("call-unknown")), sdkFinish("length")]),
])

unparsableThenUnknown.it.effect(
  "session.processor books the unparsable call as truncated even when an unknown tool call follows it",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-cut": "arguments_truncated", "call-unknown": "validation_error" })
      }),
    { config: cfg },
  ),
)

const acrossSteps = scripted([
  adapted([
    ...sdkStep("tool-calls", unparsableCall("call-early")),
    ...sdkStep("length", unparsableCall("call-late")),
    sdkFinish("length"),
  ]),
])

acrossSteps.it.effect(
  "session.processor settles the rejected inputs of each step by that step's finish reason",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-early": "validation_error", "call-late": "arguments_truncated" })
        expect(result.rows).toEqual({ "call-early": "validation_error", "call-late": "arguments_truncated" })
      }),
    { config: cfg },
  ),
)

const lengthWithoutRejection = scripted([
  adapted([...sdkStep("tool-calls", unparsableCall("call-early")), ...sdkStep("length"), sdkFinish("length")]),
])

lengthWithoutRejection.it.effect(
  "session.processor does not carry a rejected input over to a later step that stopped on length",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* rejectedRun(dir)
        expect(result.parts).toEqual({ "call-early": "validation_error" })
      }),
    { config: cfg },
  ),
)
