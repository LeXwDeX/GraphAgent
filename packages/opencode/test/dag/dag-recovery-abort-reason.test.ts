// Issue #777 — diagnostic-loss regression (confirmed part only).
//
// A child assistant turn that persists an error (most importantly the
// `MessageAbortedError` shape written when a turn is interrupted) used to be
// collapsed by recovery into the generic reason "child session failed
// (recovered)" (recovery.ts failed branch) and by the live spawn path into
// "child model turn stopped before a successful result" (spawn.ts). The
// durable error identity was provably available (it survives the store
// round-trip) but was dropped.
//
// These tests pin the FIX, not a policy change: the classification stays
// "failed", the trigger stays "exec_failed", the attempt/ownership fences are
// untouched, and there is still no automatic restart or prompt call. Only the
// human-readable reason now carries the durable error.name.
import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "node:path"
import { Effect as Effect2, Layer as Layer2, Stream } from "effect"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  reconcileWorkflow,
  makeSessionStatusChecker,
  makeLastAssistantMessageReader,
} from "../../src/dag/runtime/recovery"
import { childFailureReason } from "../../src/dag/runtime/child-failure-reason"
import { Dag } from "@/dag/dag"
import { DagStore } from "@opencode-ai/core/dag/store"
import { makeNodeRow } from "./fixtures"

type TrackedEvent = {
  type: string
  nodeID: string
  reason?: string
  trigger?: string
  attempt?: unknown
}

// ---------------------------------------------------------------------------
// Part 1 — shared formatter (pure)
// ---------------------------------------------------------------------------

describe("childFailureReason", () => {
  it("keeps the base reason unchanged when there is no error", () => {
    expect(childFailureReason("child session failed (recovered)", undefined)).toBe("child session failed (recovered)")
  })

  it("appends the error name for ordinary failures", () => {
    expect(
      childFailureReason("child session failed (recovered)", {
        name: "UnknownError",
        data: { message: "provider exploded" },
      }),
    ).toBe("child session failed (recovered) (UnknownError)")
  })

  it("marks an aborted session explicitly and never copies error data", () => {
    const reason = childFailureReason("child session failed (recovered)", {
      name: "MessageAbortedError",
      data: { message: "provider circuit breaker tripped" },
    })
    expect(reason).toContain("child session failed (recovered)")
    expect(reason).toContain("(MessageAbortedError)")
    expect(reason).toContain("child session interrupted")
    expect(reason).toContain("source unknown")
    expect(reason).toContain("checking side effects")
    // Raw error data / provider payload must not leak into reasons.
    expect(reason).not.toContain("circuit breaker")
    // It must not claim a hook denial blocked or executed a tool.
    expect(reason).not.toContain("denied")
  })
})

// ---------------------------------------------------------------------------
// Part 2 — reconcileWorkflow failed branch (mock dag layer)
// ---------------------------------------------------------------------------

function makeDagLayer(nodes: DagStore.NodeRow[], trackedEvents: TrackedEvent[]) {
  const store = Layer.mock(DagStore.Service, {
    getNodes: () => Effect.succeed(nodes),
    getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
  })
  return Layer.unwrap(
    Effect.map(DagStore.Service, (store) =>
      Layer.mock(Dag.Service, {
        store,
        nodeFailed: (_dagID: string, nodeID: string, reason: string, trigger: string, attempt?: unknown) =>
          Effect.sync(() => {
            trackedEvents.push({ type: "nodeFailed", nodeID, reason, trigger, attempt })
          }),
        nodeCompleted: (_dagID: string, nodeID: string, _output: unknown) =>
          Effect.sync(() => trackedEvents.push({ type: "nodeCompleted", nodeID })),
      }),
    ),
  ).pipe(Layer.provide(store))
}

const ABORTED: SessionV1.Assistant["error"] = { name: "MessageAbortedError", data: { message: "Aborted" } }
const UNKNOWN: SessionV1.Assistant["error"] = { name: "UnknownError", data: { message: "provider exploded" } }

function assistantWith(error?: SessionV1.Assistant["error"]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make("ses_1"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      ...(error ? { error } : {}),
    },
    parts: [],
  }
}

describe("reconcileWorkflow — failed branch forwards the durable error identity (#777)", () => {
  it("records the abort identity and guidance when the reader returns a persisted abort", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)
    const reader = () => Effect.succeed(assistantWith(ABORTED))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(result.reconciled).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("nodeFailed")
    expect(events[0].trigger).toBe("exec_failed")
    expect(events[0].reason).toContain("child session failed (recovered)")
    expect(events[0].reason).toContain("(MessageAbortedError)")
    expect(events[0].reason).toContain("interrupted")
    expect(events[0].reason).toContain("source unknown")
    expect(events[0].reason).toContain("checking side effects")
    // Attempt fencing is untouched: the recorded attempt matches the node row.
    expect(events[0].attempt).toEqual({ replanAttempts: 0, childSessionID: "ses_1" })
  })

  it("records the generic prefix plus identity for genuine failures", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)
    const reader = () => Effect.succeed(assistantWith(UNKNOWN))

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe("child session failed (recovered) (UnknownError)")
    expect(events[0].trigger).toBe("exec_failed")
  })

  it("falls back to the exact historical reason when no reader is wired", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe("child session failed (recovered)")
  })

  it("falls back to the historical reason when the reader has no assistant message", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)
    const reader = () => Effect.succeed(undefined)

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe("child session failed (recovered)")
  })

  it("degrades to the historical reason on a safe diagnostic read error — documented conservative fallback", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)
    const reader = () => Effect.fail(new Error("transient store hiccup"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      ),
    )

    // The node still fails with the same classification; the diagnostic read
    // error must not abort the whole reconcile nor invent a different outcome.
    expect(result.reconciled).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe("child session failed (recovered)")
    expect(events[0].trigger).toBe("exec_failed")
  })

  it("propagates interruption of the diagnostic read instead of swallowing it", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)
    const reader = (): Effect.Effect<SessionV1.WithParts | undefined, Error> => Effect.interrupt

    const exit = await Effect.runPromiseExit(
      reconcileWorkflow("wf-1", checkStatus, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Part 3 — real persisted round-trip: checker + reader + reconcile
// ---------------------------------------------------------------------------

const summary = Layer2.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect2.void,
    diff: () => Effect2.succeed([]),
    computeDiff: () => Effect2.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// The LLM service is never invoked: recovery reads durable state only — there
// is no automatic prompt/restart call anywhere in this path.
const idleLLM = Layer2.succeed(
  LLM.Service,
  LLM.Service.of({
    organizer: () => Effect2.succeed(undefined),
    stream: () => Stream.empty,
  }),
)

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

const env = LayerNode.buildLayer(root, {
  replacements: [
    LayerNode.replace(SessionSummary.node, summary),
    LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    LayerNode.replace(LLM.node, idleLLM),
  ],
})

const itLive = testEffect(env)

const user = Effect.fn("issue777.user")(function* (sessionID: SessionID, text: string) {
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

const persistAssistant = Effect.fn("issue777.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  dir: string,
  overrides: { error?: SessionV1.Assistant["error"]; finish?: string } = {},
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: overrides.finish ?? "end_turn",
    ...overrides,
  }
  if (overrides.finish === undefined) delete msg.finish
  yield* session.updateMessage(msg)
  return msg
})

itLive.live("a persisted MessageAbortedError survives the durable round-trip into the recovered failure reason", () =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      // Persist the exact interrupted shape: assistant.error = AbortedError,
      // finish undefined (processor's durable abort shape).
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "verify the change")
      yield* persistAssistant(chat.id, parent.id, path.resolve(dir), {
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      })

      const checker = makeSessionStatusChecker(session)
      const reader = makeLastAssistantMessageReader(session)
      expect(yield* checker(chat.id)).toBe("failed")

      const events: TrackedEvent[] = []
      const dagLayer = makeDagLayer([makeNodeRow({ id: "n1", status: "running", childSessionId: chat.id })], events)
      yield* reconcileWorkflow("wf-1", checker, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(dagLayer),
      )

      expect(events).toHaveLength(1)
      expect(events[0].trigger).toBe("exec_failed")
      expect(events[0].reason).toContain("(MessageAbortedError)")
      expect(events[0].reason).toContain("interrupted")
      expect(events[0].reason).toContain("source unknown")
      expect(events[0].reason).toContain("checking side effects")

      // A genuine UnknownError keeps its identity too, without abort wording.
      const failedChat = yield* session.create({})
      const failedParent = yield* user(failedChat.id, "verify the change")
      yield* persistAssistant(failedChat.id, failedParent.id, path.resolve(dir), {
        error: { name: "UnknownError", data: { message: "provider exploded" } },
      })
      expect(yield* checker(failedChat.id)).toBe("failed")

      const failedEvents: TrackedEvent[] = []
      const failedDagLayer = makeDagLayer(
        [makeNodeRow({ id: "n2", status: "running", childSessionId: failedChat.id })],
        failedEvents,
      )
      yield* reconcileWorkflow("wf-1", checker, undefined, undefined, undefined, undefined, undefined, reader).pipe(
        Effect.provide(failedDagLayer),
      )
      expect(failedEvents).toHaveLength(1)
      expect(failedEvents[0].reason).toBe("child session failed (recovered) (UnknownError)")
      expect(failedEvents[0].reason).not.toContain("interrupted")
    }),
  ),
)
