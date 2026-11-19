// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoop from "./loop"

import { Effect, Layer, Context, Option, Scope } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import { DagLocation } from "../location"
import { isWorkflowTerminalStatus, isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { Dag, parseWorkflowConfig } from "../dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionInbox } from "@/session/inbox"
import { ExclusiveRegistry } from "@/session/engine-process"
import { AgentScheduler } from "@/session/agent-scheduler"
import { makeLastAssistantMessageReader } from "./recovery"
import { childAbort } from "./child-failure-reason"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { DagDelivery } from "./delivery"
import { RunnerLease } from "./runner-lease"
import { RunnerPort } from "./runner-port"
import { DagReconciler } from "./reconciler"
import { workflowWorktreeSettlementPending } from "./worktree-completion"
import type { WorkflowEntry } from "./entry"
import type { DagLoopContext } from "./context"
import { DagLoopControlHandlers } from "./control-handlers"
import { DagLoopGates } from "./gates"
import { DagLoopLifecycleHandlers } from "./lifecycle-handlers"
import { DagLoopMessageContinuation } from "./message-continuation"
import { DagLoopNodeHandlers } from "./node-handlers"
import { DagLoopRecoverWorkflow } from "./recover-workflow"
import { DagLoopReplanHandler } from "./replan-handler"
import { DagLoopSpawnReady } from "./spawn-ready"
import { DagLoopTeardown } from "./teardown"

export { PAUSED_REMINDER_DELAY_MS, isPausedReminderDue, wakeBatchIdentity } from "./delivery"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagLoop") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const messageSvc = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const dag = yield* Dag.Service
    const agentSvc = yield* Agent.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const childRuns = yield* promptSvc.children
    const permissionSvc = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    // #1453: spills an oversized upstream string to disk. Optional: without it a value is handed over whole.
    const truncate = Option.getOrUndefined(yield* Effect.serviceOption(Truncate.Service))
    const statusSvc = yield* SessionStatus.Service
    // The shared per-instance inbox: it owns the one idle subscription and is
    // the only way a wake or a queued agent message reaches the parent session
    // (#1344). Every graph that builds DagLoop provides one.
    const inbox = yield* SessionInbox.Service
    const automation = yield* ExclusiveRegistry.Service
    const scheduler = yield* AgentScheduler.Service
    const database = yield* Database.Service
    const { leases, runnerID } = yield* RunnerLease.resolve(database)

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const stateScope = yield* Scope.Scope
        const runtimes = new Map<string, WorkflowEntry>()
        // ADR-0008: this instance's runner leases. Made before any fiber is
        // forked below, so its release at exit runs after they are interrupted.
        // The eviction and the reconciler are made below, once what they need exists; the first tick is a period away.
        let evictEntry:
          ((dagID: string, entry: WorkflowEntry, stillLost?: Effect.Effect<boolean>) => Effect.Effect<void>) | undefined
        // ADR-0008 decision 6: the renewal tick starts the instance's reconcile round, in a fiber of its own.
        let reconciler: DagReconciler.Interface | undefined
        const runnerLease = yield* RunnerLease.make({
          leases,
          runnerID,
          entries: runtimes,
          evict: (dagID, entry, stillLost) => evictEntry?.(dagID, entry, stillLost) ?? Effect.void,
          round: (input) => reconciler?.round(input) ?? Effect.void,
          // A lease found lost (a renewal, a spawn's re-read) is news for the reconciler (Amendment 3, 4b-C): it
          // evicts the entry when another holder shows, and retires one of a workflow that ended (row 1).
          reconcile: (dagID) => reconciler?.reconcileAfter(dagID) ?? Effect.void,
        })
        // ADR-0008 decision 5: runner writes go through the port of the entry (or of the claim, before its
        // entry exists). A refused token drops the workflow: nothing to drop while there is no entry yet,
        // and the adoption ends at its own `confirm`.
        const portFor = (dagID: string, token: DagLease.Token) =>
          RunnerPort.make({ dag, token, lost: runnerLease.refused(dagID, token) })
        // D7: all delivery scheduling (wake + agent mailbox) lives in
        // DagDelivery, the `dag.delivery` source of the inbox. Every event
        // source below only nudges the session through the inbox; the nudge is
        // forked (`inbox.nudge` resolves after the drain it joins), so a handler
        // never waits for a delivery.
        const nudge = DagDelivery.nudger(inbox, stateScope)

        // #1344: what the modules split out of this closure share (DagLoopContext).
        const loop: DagLoopContext.Context = {
          events,
          store,
          dag,
          messageSvc,
          agentSvc,
          sessionSvc,
          promptSvc,
          childRuns,
          permissionSvc,
          truncate,
          automation,
          scheduler,
          ctx,
          stateScope,
          runtimes,
          runnerLease,
          portFor,
          nudge,
        }
        const { checkpointDisposition, enforceCheckpointGate, convergeSkippedNodes, checkCompletion } =
          DagLoopGates.make(loop)

        const startMessageContinuations = DagLoopMessageContinuation.make(loop)
        const { failUnusableWorkspace, abortChild, settleWorkflowTerminal, retireTerminal } = DagLoopTeardown.make(loop)
        const spawnReady = DagLoopSpawnReady.make(loop, {
          abortChild,
          failUnusableWorkspace,
          enforceCheckpointGate,
          convergeSkippedNodes,
          startMessageContinuations,
        })

        const lastAssistantMessage = makeLastAssistantMessageReader(sessionSvc)

        // ADR-0008 decision 2: a lost runner lease evicts the entry and writes
        // nothing for the workflow (runner-lease.ts). It cancels the children the
        // entry's own attempts recorded (`attemptChild`); the node row may
        // already name an attempt of the runner that took the lease over.
        evictEntry = RunnerLease.evictor({
          entries: runtimes,
          abort: (dagID, nodeID, childSessionID) =>
            abortChild(dagID, nodeID, childSessionID, "dag.loop.leaseLost", childAbort("lease-lost", "dag-lease")).pipe(
              Effect.ignore,
            ),
          unregister: (entry, dagID) =>
            automation.unregister(SessionID.make(entry.parentSessionID), { kind: "dag", id: dagID }),
        })

        const recoverWorkflow = DagLoopRecoverWorkflow.make(loop, {
          lastAssistantMessage,
          checkpointDisposition,
          startMessageContinuations,
          spawnReady,
          checkCompletion,
        })

        // ADR-0008 decision 6: this instance's reconciler. Startup and the renewal tick run its rounds (`reconcile`;
        // the tick's in a fiber of its own, so the renewals never wait for it), and the event triggers below (a first
        // wave, a replan with no entry, a session move) and a lease found lost (the renewal, a spawn's re-read: wired
        // into `runnerLease` above) call `reconcileAfter`, which re-evaluates behind an evaluation under way instead
        // of joining it. Every adoption runs in an evaluation, which is single-flight per workflow. It also disposes of
        // the orphan `pending` rows an older version left behind (`Dag.create` is one transaction now): after a grace
        // period, claim, then fail them in one command. It reads every observation's clock into the instance's clock
        // watch, which the lease owns (decision 2).
        const evictMoved = DagReconciler.movedEvictor({
          entries: runtimes,
          store,
          abort: (dagID, nodeID, childSessionID) =>
            abortChild(
              dagID,
              nodeID,
              childSessionID,
              "dag.loop.locationMoved",
              childAbort("location-moved", "dag-location"),
            ).pipe(Effect.ignore),
        })
        reconciler = DagReconciler.make({
          store,
          leases,
          runnerID,
          directory: ctx.directory,
          entries: runtimes,
          lease: runnerLease,
          noteClock: runnerLease.noteClock,
          portFor,
          // The scope is the instance's, as it is for the startup scan: a round runs in a fiber of its own.
          adopt: (wf) => recoverWorkflow(wf).pipe(Effect.provideService(Scope.Scope, stateScope), Effect.orDie),
          failUnusable: failUnusableWorkspace,
          evictMoved,
          // Row 1: the entry of a workflow that ended, which no terminal handler here is going to hear of when another
          // process ended it.
          retire: (dagID, entry) =>
            retireTerminal(dagID, entry, "reconcile").pipe(
              Effect.flatMap((retired) =>
                retired
                  ? Effect.logInfo("DagLoop retired the runtime entry of a workflow that ended", { dagID })
                  : Effect.void,
              ),
            ),
        })
        const { reconcileAfter } = reconciler

        yield* DagLoopControlHandlers.subscribeStarted(loop, { reconcileAfter })

        yield* DagLoopNodeHandlers.subscribe(loop, { abortChild, spawnReady, enforceCheckpointGate, checkCompletion })

        yield* DagLoopControlHandlers.subscribeControl(loop, { spawnReady, convergeSkippedNodes, checkCompletion })

        yield* DagLoopReplanHandler.subscribe(loop, { abortChild, spawnReady, checkCompletion, reconcileAfter })

        yield* DagLoopLifecycleHandlers.subscribeTerminal(loop, { retireTerminal, settleWorkflowTerminal })

        // D7: one delivery scheduler owns the durable wake ledger and the
        // agent mailbox ledger (see DagDelivery). The inbox drain calls
        // `deliver`; node-terminal handlers, pause recovery, escalation,
        // moves, and the startup sweep nudge the inbox, which serializes them
        // per session with every other source. Delivery keeps the fixed
        // order — wake first, mailbox second — and returns true only when it
        // consumed the boundary.
        const delivery = yield* DagDelivery.make({
          directory: ctx.directory,
          projectID: ctx.project.id,
          scope: stateScope,
          store,
          sessions: sessionSvc,
          prompts: promptSvc,
          status: statusSvc,
          automation,
          database,
          events,
          messages: messageSvc,
          inbox,
          entries: (dagID) => runtimes.get(dagID),
          lastAssistantMessage,
        })
        // The idle subscription lives in SessionInbox (one per instance); this
        // delivery registers itself as the `dag.delivery` source there. The
        // remaining event handlers below nudge the inbox.

        yield* DagLoopLifecycleHandlers.subscribeSession(loop, { abortChild, reconcileAfter })

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        // The first reconcile round: orphan `pending` rows first (the
        // WorkflowStarted of their terminalization finds them failed, never
        // adopted), then every running/paused/stepping workflow is adopted or
        // left to its holder.
        yield* reconciler.round({ afterClockJump: false })
        // Re-scan after recovery adopted the durable rows: the construction
        // scan ran before adoption, so this is where paused reminders become
        // deliverable against the reconciled runtimes.
        yield* delivery.scan()

        // Terminal rows can survive a process crash after projection but before
        // parent delivery. Re-enter the normal serialized drain for every
        // affected parent session without waiting for a new status event.
        // Store failures here are defects (the store's error channel is never);
        // absorb them with a warning so layer construction survives, but never
        // silently — a swallowed failure means wake redelivery is lost until
        // the next process restart.
        const pendingWakeSessions = yield* store
          .getSessionsWithUnreportedWakes()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop failed to list sessions with unreported wakes", { cause }).pipe(
                Effect.as([] as string[]),
              ),
            ),
          )
        for (const sessionID of pendingWakeSessions) {
          // Cross-instance guard via the execution-location authority: wake
          // redelivery is store-global. Only drain sessions whose workflows
          // belong to this instance's DIRECTORY — sibling worktrees of the
          // same project share the project id and must not deliver each
          // other's wakes.
          if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) continue
          // The wake snapshot's own workflow rows carry a second ownership
          // proof — only drain sessions whose unreported workflows belong to
          // this project.
          const snapshot = yield* store
            .getWakeSnapshot(sessionID)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("DagLoop failed to read wake snapshot", { sessionID, cause }).pipe(
                  Effect.as({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
                ),
              ),
            )
          if (!snapshot.workflows.some((wf) => wf.projectId === ctx.project.id)) continue
          // #1030 D9-g: a crash can land between the terminal transition and
          // the settlement projection. Delivery is gated on that pointer, so
          // settle the durable terminal rows before the first wake scan (the
          // seam is idempotent and owner-gated; a not-owned row is a no-op).
          for (const workflow of snapshot.workflows) {
            if (!isTerminalWorkflowStatusValue(workflow.status)) continue
            if (!workflowWorktreeSettlementPending(workflow, parseWorkflowConfig(workflow.config))) continue
            yield* settleWorkflowTerminal(workflow.id)
          }
          // GOAL-FP-01-01: register only NON-terminal workflows. Terminal
          // workflows with wake_reported=true would otherwise be re-registered
          // on every restart and never unregistered (the only unregister for
          // them lives in the wake-delivery SUCCESS path, whose batch only
          // carries unreported workflows) — permanently leaking a dag
          // registration and blocking the goal. Terminal-but-unreported
          // workflows are safe to skip here too: the delivery drain registers
          // every workflow in its batch itself right before claiming the wake
          // lease, so wake redelivery does not depend on this sweep.
          yield* Effect.forEach(
            snapshot.workflows.filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never)),
            (workflow) => automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
            { discard: true },
          )
          yield* nudge(sessionID)
        }

        return {}
      }),
    )

    const init = Effect.fn("DagLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(ExclusiveRegistry.defaultLayer))

export const defaultLayer = layer.pipe(
  // The shared per-instance inbox owns the idle subscription. It is the
  // innermost provide so its own EventV2Bridge/SessionStatus defaults are
  // built in the same memoMap graph as the rest of this layer's deps.
  Layer.provide(SessionInbox.defaultLayer),
  Layer.provide(AgentScheduler.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagLease.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Permission.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
  Layer.provide(HookLifecycle.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Database.node,
  EventV2Bridge.node,
  DagStore.node,
  DagLease.node,
  DagMessages.node,
  Dag.node,
  Agent.node,
  AgentScheduler.node,
  Session.node,
  SessionPrompt.node,
  Permission.node,
  Truncate.node,
  SessionStatus.node,
  SessionInbox.node,
  HookStartContext.node,
  HookLifecycle.node,
])
