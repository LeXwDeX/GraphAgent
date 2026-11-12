// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { isDeepStrictEqual } from "node:util"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { beginAttempt, initialAttemptState, type AttemptState } from "../../src/session/turn/attempt"
import { Provider } from "@/provider/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LLMEvent } from "@graphagent/llm"

/**
 * Issue #1019 (PR-b): attempt-scoped processor state.
 *
 * The first block exercises `beginAttempt` on a state whose every field the
 * previous attempt dirtied. The second proves the leak check itself notices a
 * reset that forgets one field (a built-in mutation check). The third pins the
 * wiring in `processor.ts`, and the last drives the real processor through two
 * attempts and two `process()` calls on one handle.
 */

const sessionID = SessionID.make("ses_attempt-state")
const messageID = MessageID.make("msg_attempt-state")

/**
 * What attempt 1 leaves behind: every field away from its initial value.
 * Typed as the full `AttemptState`, so adding a field to the type without
 * dirtying it here is a compile error, and the key list below follows the type.
 */
function dirtyAttempt(): AttemptState {
  const reasoning: SessionV1.ReasoningPart = {
    id: PartID.make("prt_attempt-state-reasoning"),
    messageID,
    sessionID,
    type: "reasoning",
    text: "thought",
    time: { start: 1 },
  }
  return {
    openText: {
      id: PartID.make("prt_attempt-state-text"),
      messageID,
      sessionID,
      type: "text",
      text: "partial",
      time: { start: 1 },
    },
    openTextID: "text-1",
    reasoningMap: { "reasoning-1": reasoning },
    anyToolCalled: true,
    admittedToolCalls: 2,
    pendingToolExecutions: new Set(["call-1"]),
    finish: "tool-calls",
    textLength: 7,
    reasoningLength: 7,
    reasoningActivity: true,
    opaqueReasoning: true,
    reasoningParts: new Set([reasoning.id]),
    toolActivity: true,
    suppressedActivity: true,
    retryBlockingSuppressedActivity: true,
    retryBlockedBy: "tool-executed",
  }
}

type Owner = { attempt: AttemptState }

/** Every field of the type: the dirty fixture is compile-time exhaustive. */
const fixtureKeys = Object.keys(dirtyAttempt())
const fields = fixtureKeys.filter((key): key is keyof AttemptState => key in initialAttemptState())

/** Fields still holding attempt 1's value after `begin` started attempt 2. */
function leaked(begin: (owner: Owner) => void): (keyof AttemptState)[] {
  const owner: Owner = { attempt: dirtyAttempt() }
  begin(owner)
  const initial = initialAttemptState()
  return fields.filter((key) => !isDeepStrictEqual(owner.attempt[key], initial[key]))
}

describe("attempt state reset", () => {
  test("the fixture dirties every field, so the checks below are not vacuous", () => {
    const initial = initialAttemptState()
    const dirty = dirtyAttempt()
    expect(fixtureKeys).toEqual(fields)
    for (const key of fields) expect(isDeepStrictEqual(dirty[key], initial[key])).toBe(false)
  })

  for (const key of fields) {
    test(`attempt 2 starts with ${key} at its initial value`, () => {
      const owner: Owner = { attempt: dirtyAttempt() }
      beginAttempt(owner)
      expect(owner.attempt[key]).toStrictEqual(initialAttemptState()[key])
    })
  }

  test("attempt 2 starts with the whole state equal to the initial state", () => {
    const owner: Owner = { attempt: dirtyAttempt() }
    beginAttempt(owner)
    expect(owner.attempt).toStrictEqual(initialAttemptState())
    expect(leaked(beginAttempt)).toEqual([])
  })

  test("replaces the state instead of clearing it, so no container is shared between attempts", () => {
    const previous = dirtyAttempt()
    const owner: Owner = { attempt: previous }
    beginAttempt(owner)
    expect(owner.attempt).not.toBe(previous)
    expect(owner.attempt.pendingToolExecutions).not.toBe(previous.pendingToolExecutions)
    expect(owner.attempt.reasoningParts).not.toBe(previous.reasoningParts)
    expect(owner.attempt.reasoningMap).not.toBe(previous.reasoningMap)
    // Whoever still holds attempt 1 keeps seeing attempt 1.
    expect([...previous.pendingToolExecutions]).toEqual(["call-1"])
    expect(previous.reasoningParts.size).toBe(1)
    expect(Object.keys(previous.reasoningMap)).toEqual(["reasoning-1"])
    // And two fresh states never alias each other.
    const first = initialAttemptState()
    const second = initialAttemptState()
    first.pendingToolExecutions.add("call-2")
    first.reasoningMap["reasoning-2"] = dirtyAttempt().reasoningMap["reasoning-1"]
    expect(second.pendingToolExecutions.size).toBe(0)
    expect(second.reasoningMap).toEqual({})
  })

  test("only attempt fields are reset: turn-level state on the owner survives", () => {
    const toolcalls = { "call-1": "in flight" }
    const owner = { attempt: dirtyAttempt(), blocked: true, needsCompaction: true, toolcalls, snapshot: "tree-1" }
    beginAttempt(owner)
    expect(owner.blocked).toBe(true)
    expect(owner.needsCompaction).toBe(true)
    expect(owner.toolcalls).toBe(toolcalls)
    expect(owner.snapshot).toBe("tree-1")
  })
})

describe("attempt state leak check sensitivity", () => {
  for (const key of fields) {
    test(`a reset that forgets ${key} is reported as a leak of exactly ${key}`, () => {
      const forgetting = (owner: Owner) => {
        const next = initialAttemptState()
        Object.assign(next, { [key]: owner.attempt[key] })
        owner.attempt = next
      }
      expect(leaked(forgetting)).toEqual([key])
    })
  }

  test("a field-by-field reset that misses one field is caught", () => {
    const partial = (owner: Owner) => {
      const initial = initialAttemptState()
      owner.attempt.anyToolCalled = initial.anyToolCalled
      owner.attempt.pendingToolExecutions = initial.pendingToolExecutions
      owner.attempt.retryBlockedBy = initial.retryBlockedBy
    }
    expect(leaked(partial)).toHaveLength(fields.length - 3)
  })

  test("the factory yields exactly the keys of the type, including undefined-valued ones", () => {
    expect(Object.keys(initialAttemptState()).sort()).toEqual([...fixtureKeys].sort())
    // `toEqual` ignores undefined-valued keys, so a factory that dropped
    // `retryBlockedBy` would pass it; the key list above is what catches it.
    expect("retryBlockedBy" in initialAttemptState()).toBe(true)
    expect("openText" in initialAttemptState()).toBe(true)
  })
})

describe("processor wiring", () => {
  // State of the whole handle (or of the current step), as opposed to one
  // attempt. A field added to `ProcessorContext` must either be listed here on
  // purpose or, when an attempt must not inherit it, live in `AttemptState`.
  const handleLevel = [
    "attempt",
    "toolcalls",
    "shouldBreak",
    "snapshot",
    "blocked",
    "needsCompaction",
    "stepToolActivity",
    "recentToolSignatures",
  ]

  test("ProcessorContext declares only handle-level fields next to the attempt state", async () => {
    const source = await Bun.file(new URL("../../src/session/processor.ts", import.meta.url)).text()
    const body = source.match(/interface ProcessorContext extends Input \{\n([\s\S]*?)\n\}\n/)?.[1]
    expect(body).toBeDefined()
    const declared = [...(body ?? "").matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1])
    expect(declared.sort()).toEqual([...handleLevel].sort())
  })

  test("processor.ts starts attempts through beginAttempt and keeps no flat attempt field", async () => {
    const source = await Bun.file(new URL("../../src/session/processor.ts", import.meta.url)).text()
    expect(source.match(/\bbeginAttempt\(ctx\)/g)).toHaveLength(1)
    expect(source).toContain("attempt: initialAttemptState()")
    // The old per-field reset assigned `ctx.<field> = ...`; every attempt field
    // now lives under `ctx.attempt`.
    for (const key of fields) expect(source).not.toMatch(new RegExp(`\\bctx\\.${key}\\b`))
    // A new `ctx.attemptFoo` field next to `ctx.attempt` would escape the reset.
    expect(source).not.toMatch(/\bctx\.attempt[A-Z]/)
  })
})

// ---------------------------------------------------------------------------
// The real processor with a scripted LLM
// ---------------------------------------------------------------------------

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

const user = Effect.fn("AttemptStateTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("AttemptStateTest.assistant")(function* (
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
const replacements = [LayerNode.replace(SessionSummary.node, summary)]

/**
 * Each processor attempt consumes the next script; the last script repeats.
 * `activity` reports provider activity before the events, the way the adapter
 * does for work that is not visible in the stream.
 */
type Script = LLMEvent[] | { activity: "tool-executed" | "suppressed" | "observational"; events: LLMEvent[] }
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

const boot = Effect.fn("AttemptStateTest.boot")(function* () {
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

const networkError = LLMEvent.providerError({ message: "network error", retryable: true })

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

// Attempt 1 leaves every retry-compatible detection field dirty -- opaque and
// visible reasoning, partial text, tool input, observational provider activity
// and an unknown finish -- and then fails with a retryable network error.
// Attempt 2 is a genuinely empty response. It is only recognized as empty (and
// retried into attempt 3) when none of those fields survived into attempt 2.
const dirtyThenEmpty = scripted([
  {
    activity: "observational",
    events: [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.reasoningStart({
        id: "reason-1",
        providerMetadata: { openai: { reasoningEncryptedContent: "test-encrypted-state" } },
      }),
      LLMEvent.reasoningDelta({ id: "reason-1", text: "thought" }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textDelta({ id: "text-1", text: "partial" }),
      LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
      LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
      networkError,
    ],
  },
  emptyStop,
  validScript,
])

dirtyThenEmpty.it.effect(
  "session.processor judges a retried attempt on its own state, not the dirty attempt before it",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "dirty then empty")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("10 minutes")
        const result = yield* Fiber.join(run)

        // Attempt 2 was recognized as empty and retried; a leaked field would
        // have accepted it and stopped at two calls.
        expect(result).toBe("continue")
        expect(dirtyThenEmpty.count()).toBe(3)
        expect(msg.error).toBeUndefined()
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(parts.some((part) => part.type === "reasoning")).toBe(false)
      }),
    { config: cfg },
  ),
)

// process() call 1 ends a tool-bearing step whose finish metadata reports
// suppressed activity: anyToolCalled, pendingToolExecutions and the
// retry-blocking suppressed flag are all left set on the handle. Call 2 starts
// a new attempt on the same handle and hits a retryable network error. The
// retry gate refuses to replay while any of those three is set, so the retry
// (and its third script) only happens when call 2 began from a fresh state.
const toolThenNetworkFailure = scripted([
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
    LLMEvent.stepFinish({
      index: 0,
      reason: "tool-calls",
      providerMetadata: { graphagent: { suppressedActivity: true } },
    }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
  [LLMEvent.stepStart({ index: 0 }), networkError],
  validScript,
])

toolThenNetworkFailure.it.effect(
  "session.processor starts the next process() call with a clean retry gate",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool then network failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(yield* handle.process(input(chat.id, parent, mdl))).toBe("continue")
        expect(toolThenNetworkFailure.count()).toBe(1)

        const run = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("90 seconds")
        const second = yield* Fiber.join(run)

        expect(second).toBe("continue")
        expect(toolThenNetworkFailure.count()).toBe(3)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)
