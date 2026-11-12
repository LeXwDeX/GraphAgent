// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.

import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Queue, Stream } from "effect"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore, type NodeRow, type WorkflowRow } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagSummary } from "@graphagent/schema/dag-summary"
import { DagNodePublisher } from "@/dag/runtime/node-publisher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { it, pollWithTimeout } from "../lib/effect"

interface NodePatch {
  sessionID: string
  workflowID: string
  graphRev: number
  seq: number
  nodes: DagSummary.NodeView[]
  removed: string[]
  resync?: boolean
}

interface StoreControl {
  workflows: Map<string, WorkflowRow>
  nodes: Map<string, NodeRow[]>
  reads: Map<string, number>
}

interface EventControl {
  listener?: (event: never) => Effect.Effect<void>
}

const ts = (n: number) => DateTime.makeUnsafe(n)

function control(): StoreControl {
  return { workflows: new Map(), nodes: new Map(), reads: new Map() }
}

function workflow(id: string, sessionId: string, directory: string, graphRev = 1): WorkflowRow {
  return {
    id,
    projectId: "global",
    sessionId,
    directory,
    targetFingerprint: { kind: "none" },
    title: id,
    status: "running",
    pauseReason: null,
    config: "",
    seq: 0,
    wakeReported: false,
    graphRev,
    startedAt: null,
    completedAt: null,
    timeCreated: 0,
    timeUpdated: 0,
  }
}

function nodeRow(workflowId: string, id: string, status = "pending"): NodeRow {
  return {
    id,
    workflowId,
    name: id,
    workerType: "build",
    status,
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: null,
    output: null,
    capturedOutput: null,
    errorReason: null,
    errorClass: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    timeoutExtensions: 0,
    escalationPending: false,
    superseded: false,
    seq: 0,
    startedAt: null,
    completedAt: null,
  }
}

function runtime(state: StoreControl, messages?: Layer.Layer<DagMessages.Service>) {
  const store = Layer.mock(DagStore.Service, {
    getWorkflow: (dagID) => Effect.succeed(state.workflows.get(dagID)),
    getCurrentNodes: (workflowID) =>
      Effect.sync(() => {
        state.reads.set(workflowID, (state.reads.get(workflowID) ?? 0) + 1)
        return state.nodes.get(workflowID) ?? []
      }),
  })
  const events = Layer.mock(EventV2Bridge.Service, {
    listen: (listener) =>
      Effect.sync(() => {
        bus.listener = listener as never
        return Effect.void
      }),
  })
  const base = Layer.mergeAll(events, store)
  return Layer.provideMerge(DagNodePublisher.layer, messages ? Layer.merge(base, messages) : base)
}

const bus: EventControl = {}

function startCollector() {
  const patches: NodePatch[] = []
  const handler = (event: { payload?: { type?: string; properties?: NodePatch } }) => {
    if (event.payload?.type !== "dag.workflow.nodes.updated") return
    patches.push(event.payload.properties!)
  }
  GlobalBus.on("event", handler)
  return { patches, stop: () => GlobalBus.off("event", handler) }
}

function withCollector<A, E, R>(use: (collector: ReturnType<typeof startCollector>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(startCollector),
    use,
    (collector) => Effect.sync(collector.stop),
  )
}

function publishEvent(
  dagID: string,
  type: string,
  options: { directory?: string; workspaceID?: string; nodeID?: string } = {},
) {
  if (!bus.listener) return Effect.die(new Error("publisher listener is not ready"))
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    return yield* bus.listener!({
      type,
      data: { dagID, nodeID: options.nodeID ?? "n", timestamp: ts(1) },
      location: { directory: options.directory ?? instance.directory, ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}) },
    } as never)
  })
}

const waitPatches = (collector: ReturnType<typeof startCollector>, count: number) =>
  pollWithTimeout(
    Effect.sync(() => (collector.patches.length >= count ? collector.patches : undefined)),
    () => `expected ${count} node patches, got ${collector.patches.length}`,
  )

describe("DagNodePublisher behavior", () => {
  it.instance("the first publish is a resync and snapshots the current rows", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-one", workflow("dag-one", "ses-one", instance.directory))
        state.nodes.set("dag-one", [nodeRow("dag-one", "a")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-one", DagEvent.NodeRegistered.type)
        const patches = yield* waitPatches(collector, 1)
        expect(patches[0]).toEqual({
          sessionID: "ses-one",
          workflowID: "dag-one",
          graphRev: 1,
          seq: 1,
          nodes: [],
          removed: [],
          resync: true,
        })
        expect(state.reads.get("dag-one")).toBe(1)
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("pushes only the row that changed", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-two", workflow("dag-two", "ses-two", instance.directory))
        state.nodes.set("dag-two", [nodeRow("dag-two", "a"), nodeRow("dag-two", "b")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-two", DagEvent.NodeRegistered.type)
        yield* waitPatches(collector, 1)

        state.nodes.set("dag-two", [nodeRow("dag-two", "a", "running"), nodeRow("dag-two", "b")])
        yield* publishEvent("dag-two", DagEvent.NodeStarted.type, { nodeID: "a" })
        const patches = yield* waitPatches(collector, 2)
        expect(patches[1].seq).toBe(2)
        expect(patches[1].resync).toBeUndefined()
        expect(patches[1].nodes.map((node) => [node.id, node.status])).toEqual([["a", "running"]])
        expect(patches[1].removed).toEqual([])
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("skips events that do not change the current rows", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-still", workflow("dag-still", "ses-still", instance.directory))
        state.nodes.set("dag-still", [nodeRow("dag-still", "a")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-still", DagEvent.NodeRegistered.type)
        yield* waitPatches(collector, 1)
        yield* publishEvent("dag-still", DagEvent.NodeStarted.type)
        yield* publishEvent("dag-still", DagEvent.NodeStarted.type)
        yield* Effect.sleep("200 millis")
        expect(collector.patches).toHaveLength(1)
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("reports rows that left the current view as removed", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-drop", workflow("dag-drop", "ses-drop", instance.directory))
        state.nodes.set("dag-drop", [nodeRow("dag-drop", "a"), nodeRow("dag-drop", "b")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-drop", DagEvent.NodeRegistered.type)
        yield* waitPatches(collector, 1)

        state.nodes.set("dag-drop", [nodeRow("dag-drop", "a")])
        yield* publishEvent("dag-drop", DagEvent.NodeRestarted.type, { nodeID: "b" })
        const patches = yield* waitPatches(collector, 2)
        expect(patches[1].nodes).toEqual([])
        expect(patches[1].removed).toEqual(["b"])
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("a graph revision change asks for a refetch", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-rev", workflow("dag-rev", "ses-rev", instance.directory))
        state.nodes.set("dag-rev", [nodeRow("dag-rev", "a")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-rev", DagEvent.NodeRegistered.type)
        yield* waitPatches(collector, 1)

        state.workflows.set("dag-rev", workflow("dag-rev", "ses-rev", instance.directory, 2))
        yield* publishEvent("dag-rev", DagEvent.WorkflowReplanned.type)
        const patches = yield* waitPatches(collector, 2)
        expect(patches[1]).toMatchObject({ graphRev: 2, seq: 2, nodes: [], removed: [], resync: true })
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("a patch larger than the cap asks for a refetch", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-wide", workflow("dag-wide", "ses-wide", instance.directory))
        state.nodes.set("dag-wide", [])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-wide", DagEvent.WorkflowCreated.type)
        yield* waitPatches(collector, 1)

        state.nodes.set(
          "dag-wide",
          Array.from({ length: 65 }, (_, index) => nodeRow("dag-wide", `n${index}`)),
        )
        yield* publishEvent("dag-wide", DagEvent.NodeRegistered.type)
        const patches = yield* waitPatches(collector, 2)
        expect(patches[1]).toMatchObject({ seq: 2, nodes: [], removed: [], resync: true })
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("ignores events from another directory", () => {
    const state = control()
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-foreign", workflow("dag-foreign", "ses-foreign", instance.directory))
        state.nodes.set("dag-foreign", [nodeRow("dag-foreign", "a")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-foreign", DagEvent.NodeRegistered.type, { directory: `${instance.directory}-other` })
        yield* Effect.sleep("200 millis")
        expect(collector.patches).toHaveLength(0)
        expect(state.reads.get("dag-foreign")).toBeUndefined()
      }),
    ).pipe(Effect.provide(runtime(state)))
  })

  it.instance("a mailbox change refreshes the affected node's counters", () => {
    const state = control()
    const queue = Effect.runSync(Queue.unbounded<DagMessages.Change>())
    const metadata: DagMessages.Metadata = {
      endpoint: { id: "ep-a", kind: "node", sessionID: "ses-child", workflowID: "dag-mail", nodeID: "a", attemptID: "att-1" },
      accepted: 0,
      snapshot: 0,
      queued: 1,
      delivered: 0,
      undeliverable: 0,
    }
    const messages = Layer.mock(DagMessages.Service, {
      changed: Stream.fromQueue(queue),
      metadata: () => Effect.succeed({ ok: true as const, value: metadata }),
    })
    return withCollector((collector) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        state.workflows.set("dag-mail", workflow("dag-mail", "ses-mail", instance.directory))
        state.nodes.set("dag-mail", [nodeRow("dag-mail", "a"), nodeRow("dag-mail", "b")])
        yield* (yield* DagNodePublisher.Service).init()
        yield* publishEvent("dag-mail", DagEvent.NodeRegistered.type)
        yield* waitPatches(collector, 1)
        yield* Effect.sleep("100 millis")

        Queue.offerUnsafe(queue, {
          workflowID: "dag-mail",
          nodeID: "a",
          recipientSessionID: "ses-child",
          directory: instance.directory,
          kind: "queued",
          mailboxVersion: 1,
        })
        const patches = yield* waitPatches(collector, 2)
        expect(patches[1].nodes).toHaveLength(1)
        expect(patches[1].nodes[0]).toMatchObject({
          id: "a",
          attempt_id: "att-1",
          agent_messages: { queued: 1, delivered: 0, undeliverable: 0 },
        })
        expect(patches[1].removed).toEqual([])
        // One resync read plus the coalesced mailbox invalidation.
        expect(state.reads.get("dag-mail")).toBe(2)
      }),
    ).pipe(Effect.provide(runtime(state, messages)))
  })
})

describe("DagNodePublisher trigger coverage", () => {
  it.instance("every durable workflow/node event schedules a node-table read", () => {
    const state = control()
    return Effect.gen(function* () {
      const instance = yield* InstanceState.context
      state.workflows.set("dag-cov", workflow("dag-cov", "ses-cov", instance.directory))
      state.nodes.set("dag-cov", [nodeRow("dag-cov", "a")])
      yield* (yield* DagNodePublisher.Service).init()
      for (const def of DagEvent.DurableDefinitions) {
        const before = state.reads.get("dag-cov") ?? 0
        yield* publishEvent("dag-cov", def.type)
        yield* pollWithTimeout(
          Effect.sync(() => ((state.reads.get("dag-cov") ?? 0) > before ? true : undefined)),
          `no node-table read for ${def.type}`,
        )
        // Let the 50ms coalescing window close before the next event so each
        // event is observed as its own read.
        yield* Effect.sleep("80 millis")
      }
      expect(state.reads.get("dag-cov")).toBe(DagEvent.DurableDefinitions.length)
    }).pipe(Effect.provide(runtime(state)))
  })
})
