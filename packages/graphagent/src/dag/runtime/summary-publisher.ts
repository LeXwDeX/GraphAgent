// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagSummaryPublisher from "./summary-publisher"

import { Cause, Effect, Exit, Layer, Scope, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { GlobalBus } from "@/bus/global"

/**
 * Stateless derived-view publisher for DAG workflow summaries.
 *
 * Subscribes to all `dag.*` events. On each event, reads the affected session's
 * workflow summaries from DagStore (the single source of truth) and emits a
 * `dag.workflow.summary.updated` event on GlobalBus carrying the full
 * `WorkflowSummary[]` payload for that session.
 *
 * Invariants (enforced by the "stateless derived view" contract):
 * - No module-level Map, Set, counter, or cached state.
 * - Every emission is a full recompute from DagStore.
 * - Emits ONLY through the ephemeral GlobalBus path — no EventV2 durable
 *   registration, no SQL writes.
 * - Removing this module has no effect on correctness; only realtime push is lost.
 */

// The events that can change a workflow's visible progress or topology.
// WorkflowCreated/Started/Replanned/ConfigUpdated/Paused/Resumed/Stepped/Completed/Failed/Cancelled
// and every Node* event can all alter the aggregated summary.
const SUMMARY_TRIGGER_EVENTS = [
  DagEvent.WorkflowCreated,
  DagEvent.WorkflowStarted,
  DagEvent.WorkflowPaused,
  DagEvent.WorkflowResumed,
  // running → stepping changes summary.status.
  DagEvent.WorkflowStepped,
  DagEvent.WorkflowCompleted,
  DagEvent.WorkflowFailed,
  DagEvent.WorkflowCancelled,
  DagEvent.WorkflowReplanned,
  DagEvent.WorkflowConfigUpdated,
  DagEvent.NodeRegistered,
  // pending → queued raises summary.queuedNodes.
  DagEvent.NodeQueued,
  DagEvent.NodeStarted,
  DagEvent.NodeCompleted,
  DagEvent.NodeFailed,
  DagEvent.NodeSkipped,
  DagEvent.NodeAborted,
  DagEvent.NodeCancelled,
  DagEvent.NodeRestarted,
  // F10: escalation changes the visible summary (escalatedNodes rises from 0)
  // without any status transition — without this trigger the TUI would keep
  // showing a plain RUNNING node until some unrelated node event fires.
  DagEvent.NodeTimeoutEscalated,
  // An extension clears escalation_pending, so escalatedNodes drops back.
  DagEvent.NodeDeadlineExtended,
] as const

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSummaryPublisher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagSummaryPublisher.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        // Per workspace/session debounce map. Keys identify a routed session
        // with an in-flight recompute; a bounded window collapses a burst.
        //
        // NOTE: This is request-coalescing state for I/O deduplication, NOT
        // a parallel projection of DAG state. The summary is always recomputed
        // fresh from DagStore on emission; this map only prevents redundant
        // reads when many events fire in a tight window. If the map were
        // removed entirely, correctness is unchanged — only more DagStore
        // reads would occur. This satisfies the "stateless derived view"
        // contract: no cached summary is ever served from this map.
        const pending = new Map<string, boolean>()
        // Second coalescing tier keyed by workspace/dagID: node events don't
        // carry a sessionID, and resolving it eagerly meant one getWorkflow
        // query PER EVENT before the debounce window could absorb the burst
        // (P1-4). Resolve the sessionID once after the window, then hand off
        // to the workspace/session debounce.
        const pendingByDag = new Map<string, boolean>()

        const coalesceLatest = <E, R>(
          active: Map<string, boolean>,
          key: string,
          body: () => Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            if (active.has(key)) {
              active.set(key, true)
              return
            }
            active.set(key, false)
            yield* Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep("50 millis")
                // Events during the debounce window are absorbed by the read
                // that follows; only events racing the read require a rerun.
                active.set(key, false)
                const outcome = yield* body().pipe(Effect.exit)
                const repeat = yield* Effect.sync(() => {
                  if (active.get(key)) return true
                  active.delete(key)
                  return false
                })
                if (Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)) {
                  return yield* Effect.failCause(outcome.cause)
                }
                if (repeat) continue
                if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
                return
              }
            }).pipe(Effect.ensuring(Effect.sync(() => active.delete(key))))
          })

        const publishForSession = (sessionID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const summaries = yield* store.getWorkflowSummaries(sessionID)
            GlobalBus.emit("event", {
              directory: ctx.directory,
              project: ctx.project.id,
              workspace,
              payload: {
                type: "dag.workflow.summary.updated",
                properties: { sessionID, summaries },
              },
            })
          })

        const schedulePublish = (sessionID: string, workspace: string | undefined) =>
          coalesceLatest(pending, `${workspace ?? ""}\0${sessionID}`, () => publishForSession(sessionID, workspace))

        const schedulePublishByDag = (dagID: string, workspace: string | undefined) =>
          coalesceLatest(pendingByDag, `${workspace ?? ""}\0${dagID}`, () =>
            Effect.gen(function* () {
              const wf = yield* store.getWorkflow(dagID)
              if (wf?.projectId !== ctx.project.id) return
              // Hand off to the session-level debounce (not publishForSession
              // directly) so a concurrent session-keyed window absorbs this
              // trigger instead of producing a duplicate read.
              yield* schedulePublish(wf.sessionId, workspace)
            }),
          )

        const unsubscribe = yield* events.listen((evt) => {
          if (!SUMMARY_TRIGGER_EVENTS.some((def) => def.type === evt.type)) return Effect.void
          if (evt.location?.directory !== ctx.directory) return Effect.void
          const data = evt.data
          if (
            typeof data !== "object"
            || data === null
            || !("dagID" in data)
            || typeof data.dagID !== "string"
          ) return Effect.void
          const dagID = data.dagID
          return schedulePublishByDag(dagID, evt.location.workspaceID).pipe(
            // DAG-04 (#316): interrupt causes are the normal disposal path —
            // the inner coalescer deliberately rethrows them (a scoped
            // shutdown mid-publish must unwind, not masquerade as a failure).
            // Swallowing them here logged a spurious "failed to publish" on
            // every normal shutdown; rethrow per F1 discipline (same shape as
            // spawn.ts / loop.ts). Real failures still warn.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("DagSummaryPublisher: failed to publish summaries", { dagID, cause }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return {}
      }),
    )

    const init = Effect.fn("DagSummaryPublisher.init")(function* () {
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
