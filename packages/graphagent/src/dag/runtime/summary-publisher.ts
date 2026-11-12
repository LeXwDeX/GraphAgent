// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagSummaryPublisher from "./summary-publisher"

import { Cause, Clock, Effect, Exit, Layer, Option, Scope, Context } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DagStore } from "@graphagent/core/dag/store"
import { SessionV1 } from "@graphagent/core/v1/session"
import { AgentScheduler } from "@/session/agent-scheduler"
import { GlobalBus } from "@/bus/global"

/**
 * Stateless derived-view publisher for DAG workflow summaries.
 *
 * Subscribes to all `dag.*` events and to child-session step-finish usage
 * events. On each trigger, reads the affected session's workflow summaries
 * from DagStore (the single source of truth) and emits a
 * `dag.workflow.summary.updated` event on GlobalBus carrying the full
 * `WorkflowSummary[]` payload for that session.
 *
 * #1027 D6: a DAG child session's usage is written by the session projector on
 * step-finish, not by any `dag.*` event, so this publisher also routes those
 * child-session events to the owning parent session. The child ledger below is
 * routing state (childSessionID → parent session); it never caches a summary.
 *
 * Invariants (enforced by the "stateless derived view" contract):
 * - No cached summary is ever served; every emission is a full recompute.
 * - The child ledger, debounce, and throttle maps only deduplicate I/O and
 *   route events; removing them changes freshness, not correctness.
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

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagSummaryPublisher") {}

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
        // #1027 D6 routing ledger: child session → the parent session whose
        // summary it feeds. Populated from NodeStarted/NodeRestarted, and
        // lazily from the durable attempt ledger for children spawned before a
        // restart. It holds no summary data.
        const children = new Map<string, { parentSessionID: string; workspace: string | undefined }>()
        // Sessions proven absent from the attempt ledger; skip repeat probes.
        // A later NodeStarted still registers the session (and clears this).
        const notChildren = new Set<string>()
        // Usage events for one parent are emitted at most once per second:
        // leading emit when the window is open, one trailing emit at its end.
        const USAGE_WINDOW_MS = 1_000
        const usageLast = new Map<string, number>()
        const usageQueued = new Set<string>()

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
            // Optional: headless graphs build the publisher without a
            // scheduler, and the field is optional in the schema.
            const scheduler = Option.getOrUndefined(yield* Effect.serviceOption(AgentScheduler.Service))
            const concurrencyRunning =
              scheduler === undefined ? undefined : (yield* scheduler.capacity()).children.dagRunning
            GlobalBus.emit("event", {
              directory: ctx.directory,
              project: ctx.project.id,
              workspace,
              payload: {
                type: "dag.workflow.summary.updated",
                properties: {
                  sessionID,
                  summaries: summaries.map((summary) => ({
                    ...summary,
                    // D6b computes the real values once their owner Issues
                    // define the sources; D6a fixes the consumer-facing shape.
                    coverageCount: 0,
                    quality: null,
                    ...(concurrencyRunning === undefined ? {} : { concurrencyRunning }),
                  })),
                },
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

        const rememberChild = (childSessionID: string, parentSessionID: string, workspace: string | undefined) =>
          Effect.sync(() => {
            children.set(childSessionID, { parentSessionID, workspace })
            notChildren.delete(childSessionID)
          })

        // #1027 D6: attribute a child step-finish to its owning parent session.
        // The child's own location may be a worktree directory, so ownership
        // comes from the ledger (live NodeStarted or the durable attempt table),
        // never from the event's directory.
        const onChildUsage = (childSessionID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            let owner = children.get(childSessionID)
            if (owner === undefined) {
              if (notChildren.has(childSessionID)) return
              const resolve = store.getWorkflowByChildSession
              if (resolve === undefined) return
              const wf = yield* resolve(childSessionID)
              if (wf === undefined || wf.projectId !== ctx.project.id || wf.directory !== ctx.directory) {
                notChildren.add(childSessionID)
                return
              }
              owner = { parentSessionID: wf.sessionId, workspace }
              children.set(childSessionID, owner)
            }
            yield* scheduleUsagePublish(owner.parentSessionID, owner.workspace ?? workspace)
          })

        // One emission per parent session per second: a leading publish while
        // the window is open, otherwise one trailing publish at its end. The
        // trailing loop re-checks the window because a leading publish may have
        // moved it while this fiber slept.
        const scheduleUsagePublish = (sessionID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const key = `${workspace ?? ""}\0${sessionID}`
            if (usageQueued.has(key)) return
            const now = yield* Clock.currentTimeMillis
            const last = usageLast.get(key)
            if (last === undefined || now - last >= USAGE_WINDOW_MS) {
              usageLast.set(key, now)
              yield* schedulePublish(sessionID, workspace)
              return
            }
            usageQueued.add(key)
            yield* Effect.gen(function* () {
              for (;;) {
                const at = yield* Clock.currentTimeMillis
                const lastAt = usageLast.get(key)
                if (lastAt === undefined || at - lastAt >= USAGE_WINDOW_MS) break
                yield* Effect.sleep(lastAt + USAGE_WINDOW_MS - at)
              }
              const at = yield* Clock.currentTimeMillis
              usageLast.set(key, at)
              yield* schedulePublish(sessionID, workspace)
            }).pipe(
              Effect.ensuring(Effect.sync(() => usageQueued.delete(key))),
              Effect.forkIn(scope),
            )
          })

        const unsubscribe = yield* events.listen((evt) => {
          if (evt.type === SessionV1.Event.PartUpdated.type) {
            const data = evt.data
            if (
              typeof data !== "object"
              || data === null
              || !("sessionID" in data)
              || typeof data.sessionID !== "string"
              || !("part" in data)
              || typeof data.part !== "object"
              || data.part === null
              || !("type" in data.part)
              || data.part.type !== "step-finish"
            ) return Effect.void
            return onChildUsage(data.sessionID, evt.location?.workspaceID).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("DagSummaryPublisher: failed to publish child usage", {
                      sessionID: data.sessionID,
                      cause,
                    }),
              ),
              Effect.forkIn(scope),
              Effect.asVoid,
            )
          }
          if (!SUMMARY_TRIGGER_EVENTS.some((def) => def.type === evt.type)) return Effect.void
          const location = evt.location
          if (location?.directory !== ctx.directory) return Effect.void
          const data = evt.data
          if (
            typeof data !== "object"
            || data === null
            || !("dagID" in data)
            || typeof data.dagID !== "string"
          ) return Effect.void
          const dagID = data.dagID
          const childSessionID =
            "childSessionID" in data && typeof data.childSessionID === "string" ? data.childSessionID : undefined
          return Effect.gen(function* () {
            if (childSessionID !== undefined) {
              const wf = yield* store.getWorkflow(dagID)
              if (wf?.projectId === ctx.project.id) {
                yield* rememberChild(childSessionID, wf.sessionId, location.workspaceID)
              }
            }
            yield* schedulePublishByDag(dagID, location.workspaceID)
          }).pipe(
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
