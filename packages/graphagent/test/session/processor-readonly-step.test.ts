// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "@/snapshot"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LLMEvent } from "@graphagent/llm"

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

const user = Effect.fn("ReadonlyStepTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("ReadonlyStepTest.assistant")(function* (
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

const snapshotCalls = { track: 0, patch: 0 }
let snapshotSeq = 0

const countingSnapshot = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () =>
      Effect.sync(() => {
        snapshotCalls.track += 1
        snapshotSeq += 1
        return `snap-${snapshotSeq}`
      }),
    patch: () =>
      Effect.sync(() => {
        snapshotCalls.patch += 1
        return { hash: "patch-1", files: ["a.txt"] }
      }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: () => Effect.succeed([]),
  }),
)

/**
 * Builds a processor environment backed by one scripted stream and a counting
 * Snapshot service. The counters reset per test after `processors.create`
 * so they only measure what the stream itself triggers.
 */
function scripted(script: LLMEvent[]) {
  const service = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: () => Stream.fromIterable(script),
    }),
  )
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [
        LayerNode.replace(SessionSummary.node, summary),
        LayerNode.replace(LLM.node, service),
        LayerNode.replace(Snapshot.node, countingSnapshot),
      ],
    }),
  )
  return it
}

const boot = Effect.fn("ReadonlyStepTest.boot")(function* () {
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
  messages: [{ role: "user", content: "hello" }],
  tools: {},
})

const textOnlyScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "plain answer" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const writeThenReadScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
  LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
  LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
  LLMEvent.toolResult({
    id: "call-1",
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

const partsOf = (parts: SessionV1.Part[]) => ({
  starts: parts.filter((part): part is SessionV1.StepStartPart => part.type === "step-start"),
  finishes: parts.filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish"),
  patches: parts.filter((part) => part.type === "patch"),
})

describe("processor snapshot scope per step", () => {
  scripted(textOnlyScript).effect(
    "a text-only step reuses its start snapshot and skips track and patch",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          snapshotSeq = 0
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hello")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          snapshotCalls.track = 0
          snapshotCalls.patch = 0

          const result = yield* handle.process(input(chat.id, parent, mdl))
          expect(result).toBe("continue")

          const { starts, finishes, patches } = partsOf(yield* MessageV2.parts(msg.id))
          expect(starts).toHaveLength(1)
          expect(finishes).toHaveLength(1)
          expect(patches).toHaveLength(0)
          expect(starts[0]?.snapshot).toBe("snap-1")
          // The finish reuses the start snapshot instead of taking a new track.
          expect(finishes[0]?.snapshot).toBe("snap-1")
          expect(snapshotCalls.track).toBe(0)
          expect(snapshotCalls.patch).toBe(0)
        }),
      { config: cfg },
    ),
  )

  scripted(writeThenReadScript).effect(
    "a tool step tracks and patches, and the following text-only step skips both",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          snapshotSeq = 0
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hello")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          snapshotCalls.track = 0
          snapshotCalls.patch = 0

          const result = yield* handle.process(input(chat.id, parent, mdl))
          expect(result).toBe("continue")

          const { starts, finishes, patches } = partsOf(yield* MessageV2.parts(msg.id))
          expect(starts).toHaveLength(2)
          expect(finishes).toHaveLength(2)
          expect(patches).toHaveLength(1)
          if (patches[0]?.type === "patch") expect(patches[0].files).toEqual(["a.txt"])

          // Step 0 has a tool signal: end track + patch. Step 1 also starts a
          // new track but reuses it for its finish.
          expect(snapshotCalls.track).toBe(2)
          expect(snapshotCalls.patch).toBe(1)
          expect(starts[0]?.snapshot).toBe("snap-1")
          expect(finishes[0]?.snapshot).toBe("snap-2")
          expect(starts[1]?.snapshot).toBe("snap-3")
          expect(finishes[1]?.snapshot).toBe("snap-3")
        }),
      { config: cfg },
    ),
  )
})
