// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagNodePublisher from "./node-publisher"

import { Cause, Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagSummary } from "@graphagent/schema/dag-summary"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { DagNodeView } from "../node-view"
import { DagLocation } from "../location"

/**
 * Incremental node publisher (D3).
 *
 * Keeps a per-workflow snapshot of the rows this instance already pushed and
 * emits `dag.workflow.nodes.updated` patches on GlobalBus. The snapshot is
 * request-coalescing state, not a second projection: the truth is re-read from
 * DagStore on every publish, and dropping the module only costs realtime push
 * (clients fall back to the full-table fetch).
 *
 * Invariants:
 * - Only the instance that owns the workflow's directory publishes.
 * - `seq` is monotonic per workflow for the lifetime of this instance; a
 *   client that (re)connects refetches the table and treats it as seq 0.
 * - A topology change (`graphRev`), a first publish, or a patch larger than
 *   `MAX_PATCH_NODES` emits `resync: true` instead of rows.
 * - Mailbox changes arrive on the process-level `DagMessages.changed` stream;
 *   they mark individual nodes dirty so `agent_messages` counters refresh
 *   without re-reading every mailbox.
 */

// The events that can change a workflow's current node table. Mirrors the
// summary trigger list: workflow lifecycle and every Node* transition.
const NODE_TRIGGER_EVENTS = [
  DagEvent.WorkflowCreated,
  DagEvent.WorkflowStarted,
  DagEvent.WorkflowPaused,
  DagEvent.WorkflowResumed,
  DagEvent.WorkflowStepped,
  DagEvent.WorkflowCompleted,
  DagEvent.WorkflowFailed,
  DagEvent.WorkflowCancelled,
  DagEvent.WorkflowReplanned,
  DagEvent.WorkflowConfigUpdated,
  // #1030 D9-g: metadata-only for the node table, but every durable workflow
  // event refreshes the push so consumers observe the settled worktree.
  DagEvent.WorkflowWorktreeSettled,
  DagEvent.NodeRegistered,
  DagEvent.NodeQueued,
  DagEvent.NodeStarted,
  DagEvent.NodeCompleted,
  DagEvent.NodeFailed,
  DagEvent.NodeSkipped,
  DagEvent.NodeAborted,
  DagEvent.NodeCancelled,
  DagEvent.NodeRestarted,
  DagEvent.NodeTimeoutEscalated,
  DagEvent.NodeDeadlineExtended,
] as const

// A patch this large means the consumer is far behind; shipping most of the
// table costs more than asking it to refetch.
const MAX_PATCH_NODES = 64

interface WorkflowState {
  readonly seq: number
  readonly graphRev: number
  /** Serialized full views, so a mailbox-only change still registers. */
  readonly rows: ReadonlyMap<string, string>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagNodePublisher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const messages = yield* Effect.serviceOption(DagMessages.Service)

    const state = yield* InstanceState.make(
      Effect.fn("DagNodePublisher.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        // Per-workflow debounce window, keyed by workflow id (instances are
        // already directory-scoped).
        const pending = new Map<string, boolean>()
        const states = new Map<string, WorkflowState>()
        // Mailbox-only changes: the row is unchanged, but agent_messages moved.
        const dirty = new Map<string, Set<string>>()

        const serialize = (view: DagSummary.NodeView) => JSON.stringify(view)

        const markDirty = (workflowID: string, nodeID: string) => {
          const set = dirty.get(workflowID) ?? new Set<string>()
          set.add(nodeID)
          dirty.set(workflowID, set)
        }

        const readViews = (rows: ReadonlyArray<DagStore.NodeRow>, ownerSessionID: string) =>
          Effect.gen(function* () {
            const views = new Map<string, DagSummary.NodeView>()
            if (rows.length === 0) return views
            if (messages._tag === "None") {
              for (const row of rows) views.set(row.id, DagNodeView.base(row))
              return views
            }
            const first = rows[0]
            if (first === undefined) return views
            // One batch read for every candidate row (D4): a coalesced publish
            // no longer costs four statements per changed node.
            const batch = yield* messages.value
              .metadataForWorkflow(
                { projectID: ctx.project.id, directory: ctx.directory, sessionID: ownerSessionID },
                first.workflowId,
                rows.map((row) => row.id),
                // The candidate rows were just read: skip the reader's own read.
                rows.map((row) => ({
                  id: row.id,
                  workflow_id: row.workflowId,
                  child_session_id: row.childSessionId,
                  replan_attempts: row.replanAttempts,
                })),
              )
              .pipe(Effect.catchCause(() => Effect.succeed({ ok: false as const })))
            const byNode: ReadonlyMap<string, DagMessages.Metadata> = batch.ok ? batch.value : new Map()
            for (const row of rows)
              views.set(row.id, DagNodeView.observed(DagNodeView.base(row), byNode.get(row.id)))
            return views
          })

        const emit = (
          workflowID: string,
          sessionID: string,
          graphRev: number,
          seq: number,
          nodes: ReadonlyArray<DagSummary.NodeView>,
          removed: ReadonlyArray<string>,
          resync: boolean,
          workspace: string | undefined,
        ) =>
          GlobalBus.emit("event", {
            directory: ctx.directory,
            project: ctx.project.id,
            workspace,
            payload: {
              type: "dag.workflow.nodes.updated",
              properties: {
                sessionID,
                workflowID,
                graphRev,
                seq,
                nodes,
                removed,
                ...(resync ? { resync: true } : {}),
              },
            },
          })

        const publish = (workflowID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const wf = yield* store.getWorkflow(workflowID)
            // Only the owning instance publishes; sibling worktrees share the
            // process-level event streams but must not duplicate the push.
            if (wf?.projectId !== ctx.project.id) {
              states.delete(workflowID)
              dirty.delete(workflowID)
              return
            }
            if (wf.directory !== "" && DagLocation.canonicalDirectory(wf.directory) !== DagLocation.canonicalDirectory(ctx.directory)) {
              states.delete(workflowID)
              dirty.delete(workflowID)
              return
            }
            const rows = yield* store.getCurrentNodes(workflowID)
            const previous = states.get(workflowID)
            const seq = (previous?.seq ?? 0) + 1
            const resync = previous === undefined || previous.graphRev !== wf.graphRev
            if (resync) {
              dirty.delete(workflowID)
              states.set(workflowID, {
                seq,
                graphRev: wf.graphRev,
                rows: new Map(rows.map((row) => [row.id, serialize(DagNodeView.base(row))])),
              })
              emit(workflowID, wf.sessionId, wf.graphRev, seq, [], [], true, workspace)
              return
            }

            const base = new Map(rows.map((row) => [row.id, serialize(DagNodeView.base(row))]))
            const rowByID = new Map(rows.map((row) => [row.id, row]))
            const removed = [...previous.rows.keys()].filter((id) => !base.has(id))
            // Candidates: rows whose durable projection changed, plus nodes a
            // mailbox change marked dirty (their row did not change).
            const candidates = new Set<string>()
            for (const [id, serialized] of base) {
              if (previous.rows.get(id) !== serialized) candidates.add(id)
            }
            for (const id of dirty.get(workflowID) ?? []) {
              if (base.has(id)) candidates.add(id)
            }
            dirty.delete(workflowID)

            const nodes: DagSummary.NodeView[] = []
            const nextRows = new Map(previous.rows)
            const candidateRows = [...candidates]
              .map((id) => rowByID.get(id))
              .filter((row): row is DagStore.NodeRow => row !== undefined)
            const views = yield* readViews(candidateRows, wf.sessionId)
            for (const row of candidateRows) {
              const view = views.get(row.id)!
              const serialized = serialize(view)
              if (serialized === previous.rows.get(row.id)) continue
              nodes.push(view)
              nextRows.set(row.id, serialized)
            }
            for (const id of removed) nextRows.delete(id)
            if (nodes.length === 0 && removed.length === 0) return

            if (nodes.length + removed.length > MAX_PATCH_NODES) {
              states.set(workflowID, { seq, graphRev: wf.graphRev, rows: base })
              emit(workflowID, wf.sessionId, wf.graphRev, seq, [], [], true, workspace)
              return
            }

            states.set(workflowID, { seq, graphRev: wf.graphRev, rows: nextRows })
            emit(workflowID, wf.sessionId, wf.graphRev, seq, nodes, removed, false, workspace)
          })

        const coalesceLatest = <E, R>(key: string, body: () => Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            if (pending.has(key)) {
              pending.set(key, true)
              return
            }
            pending.set(key, false)
            yield* Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep("50 millis")
                pending.set(key, false)
                const outcome = yield* body().pipe(Effect.exit)
                const repeat = yield* Effect.sync(() => {
                  if (pending.get(key)) return true
                  pending.delete(key)
                  return false
                })
                if (Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)) {
                  yield* Effect.failCause(outcome.cause)
                }
                if (repeat) continue
                if (Exit.isFailure(outcome)) yield* Effect.failCause(outcome.cause)
                return
              }
            }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(key))))
          })

        const schedule = (workflowID: string, workspace: string | undefined) =>
          coalesceLatest(workflowID, () => publish(workflowID, workspace))

        const unsubscribe = yield* events.listen((evt) => {
          if (!NODE_TRIGGER_EVENTS.some((def) => def.type === evt.type)) return Effect.void
          if (evt.location?.directory !== ctx.directory) return Effect.void
          const data = evt.data
          if (
            typeof data !== "object"
            || data === null
            || !("dagID" in data)
            || typeof data.dagID !== "string"
          ) return Effect.void
          const dagID = data.dagID
          return schedule(dagID, evt.location.workspaceID).pipe(
            // Interrupt causes are the normal disposal path (same discipline
            // as the summary publisher); real failures still warn.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("DagNodePublisher: failed to publish nodes", { dagID, cause }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        if (messages._tag === "Some") {
          yield* messages.value.changed.pipe(
            Stream.filter(
              (change) => change.workflowID !== undefined && change.nodeID !== undefined && change.directory === ctx.directory,
            ),
            Stream.runForEach((change) =>
              Effect.sync(() => markDirty(change.workflowID!, change.nodeID!)).pipe(
                Effect.andThen(schedule(change.workflowID!, undefined)),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("DagNodePublisher: failed to publish mailbox change", {
                        workflowID: change.workflowID,
                        nodeID: change.nodeID,
                      }),
                ),
              ),
            ),
            Effect.forkIn(scope),
          )
        }

        return {}
      }),
    )

    const init = Effect.fn("DagNodePublisher.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node])
