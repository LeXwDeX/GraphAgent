// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopRecoverWorkflow from "./recover-workflow"

import { Cause, Effect, Semaphore } from "effect"
import type { DagLease } from "@graphagent/core/dag/lease"
import { DagMessages } from "@graphagent/core/dag/messages"
import { WorkflowRuntime, toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Logging } from "@graphagent/core/observability/logging"
import { boundedCancel } from "@/session/child/cancel"
import { SessionID } from "@/session/schema"
import { Dag, parseWorkflowConfig } from "../dag"
import { DagLocation } from "../location"
import { artifactPermissionBase, makeArtifactSourceAuthorizer } from "./artifact-permissions"
import { Checkpoint } from "./checkpoint"
import { childAbort } from "./child-failure-reason"
import type { DagLoopContext } from "./context"
import type { WorkflowEntry } from "./entry"
import type { DagLoopGates } from "./gates"
import type { DagLoopMessageContinuation } from "./message-continuation"
import { makeLastAssistantTextReader, makeSessionStatusChecker, reconcileWorkflow } from "./recovery"

/**
 * The adoption of a workflow (#1344): the `adopt` action of the reconciler, and the one place that creates a
 * runtime entry. `make` returns that one function. It claims the lease, reconciles the nodes a crash left running,
 * pauses the workflow when the reconciliation had to invent failures, rebuilds the runtime from the current graph
 * revision, publishes the entry, and starts scheduling. `lastAssistantMessage` is the reader that the delivery
 * scheduler shares, so it is made in the loop and handed in.
 */
export const make = (
  loop: Pick<
    DagLoopContext.Context,
    | "store"
    | "runtimes"
    | "ctx"
    | "stateScope"
    | "sessionSvc"
    | "agentSvc"
    | "permissionSvc"
    | "promptSvc"
    | "messageSvc"
    | "automation"
    | "nudge"
    | "runnerLease"
    | "portFor"
  >,
  operations: {
    readonly lastAssistantMessage: (childSessionID: string) => Effect.Effect<SessionV1.WithParts | undefined, Error>
    readonly checkpointDisposition: DagLoopGates.Interface["checkpointDisposition"]
    readonly startMessageContinuations: ReturnType<typeof DagLoopMessageContinuation.make>
    readonly spawnReady: DagLoopContext.SpawnReady
    readonly checkCompletion: DagLoopGates.Interface["checkCompletion"]
  },
) => {
  const {
    store,
    runtimes,
    ctx,
    stateScope,
    sessionSvc,
    agentSvc,
    permissionSvc,
    promptSvc,
    messageSvc,
    automation,
    nudge,
    runnerLease,
    portFor,
  } = loop
  const { lastAssistantMessage, checkpointDisposition, startMessageContinuations, spawnReady, checkCompletion } =
    operations

  const checkSessionStatus = makeSessionStatusChecker(sessionSvc)
  // #345: schemaless recovered nodes settle with the child's last
  // assistant text, mirroring the live spawn path.
  const lastAssistantText = makeLastAssistantTextReader(sessionSvc)

  // The `adopt` action of the reconciler (decision 6, row 10) and the one place that creates a runtime entry.
  // `observed` is older than the claim: the adoption works from the row it reads once it holds the claim.
  const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (observed: DagStore.WorkflowRow) {
    // Cross-instance guard: DagLoop is per-directory InstanceState but the
    // event bus and store are process-global. Only the instance whose
    // DIRECTORY owns the workflow may adopt it — otherwise a
    // multi-directory server spawns children under a foreign directory
    // context. The execution-location authority (dag/location.ts)
    // re-reads the durable row: the project id is a fast-reject, the
    // stamped directory is the deciding guard.
    if (!(yield* DagLocation.ownsWorkflow(observed.id, ctx.directory))) return
    const dagID = observed.id
    // Idempotency guard: the single flight of the reconciler keeps two adoptions from reconciling twice and
    // overwriting the entry (orphaning the first entry's fibers from every interrupt sweep); an entry that is
    // there already is left alone as the last line of defense.
    if (runtimes.has(dagID)) return
    let claimed: DagLease.Token | undefined
    // Effect.onExit gives the claim back even when a fiber interrupt cuts
    // the adoption sequence — a finally block does not survive interruption.
    yield* Effect.gen(function* () {
      // ADR-0008 decision 6: the claim comes first. Another runner's live
      // lease ends the adoption before any of its nodes is judged lost.
      const token = yield* runnerLease.claim(dagID)
      if (!token) return
      claimed = token
      // The row given is as old as the observation: adopt from the one read now (status, config, graph
      // revision, execution directory). A workflow that ended or was deleted since is not adopted.
      const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (wf === undefined || isTerminalWorkflowStatusValue(wf.status)) return
      // ADR-0008 decision 4: the node-level reconciliation, its recovery pause and the checkpoint gate
      // are runner writes under this claim, ahead of the entry that will carry the same port.
      const port = portFor(dagID, token)
      const config = parseWorkflowConfig(wf.config)
      const recovery = yield* reconcileWorkflow(
        dagID,
        checkSessionStatus,
        (sid) =>
          Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
            source: "dag.recovery.cancel",
            workflowID: dagID,
            childSessionID: sid,
          }).pipe(
            Effect.andThen(
              boundedCancel(
                promptSvc.cancel(sid as never, { reason: childAbort("recovery", "recovery") }),
                "dag.recovery.cancel",
              ).pipe(Effect.forkIn(stateScope, { startImmediately: true }), Effect.asVoid),
            ),
          ),
        // null (not undefined) marks an unparseable row so recovery
        // fails such nodes loudly instead of undefined-completing them.
        config ?? null,
        lastAssistantText,
        wf.executionDirectory ?? wf.directory,
        (executionDirectory) => {
          const { worktree, boundary } = artifactPermissionBase(ctx.directory, ctx.worktree, executionDirectory)
          return makeArtifactSourceAuthorizer(sessionSvc, agentSvc, worktree, permissionSvc, boundary)
        },
        lastAssistantMessage,
      ).pipe(Effect.provideService(Dag.Service, port), (self) =>
        messageSvc ? Effect.provideService(self, DagMessages.Service, messageSvc) : self,
      )
      // P2-2 recovery-pause: reconciliation invented failures (ownership
      // lost / no child session / deadline enforced offline) without any
      // durable proof of the child's outcome. Letting spawnReady cascade
      // skips and checkCompletion terminalize now would weld the workflow
      // into a terminal status the parent never sanctioned — and terminal
      // nodes are immutable, so replan could no longer rewire downstream.
      // Pause instead: pending nodes stay replannable, the durable
      // NodeFailed wake rows reach the parent at the paused delivery
      // boundary, and disposition (replan / resume / cancel) stays under
      // explicit workflow control.
      const pausedForRecovery = recovery.ownershipLost > 0 && wf.status === "running"
      if (pausedForRecovery) {
        // #349/NEW-2: a pause rejected by a CONCURRENT TERMINAL control
        // op means this instance no longer controls the workflow —
        // abandoning adoption is correct. But a lock-timeout or store
        // defect used to take the same silent path: the invented
        // NodeFailed rows were persisted with no runtime entry, events
        // filtered by runtimes.has, wake boundaries requiring an entry —
        // the workflow stalled until a process restart. Mirror the
        // replan-verdict gate: retry twice, fold defects in, and only
        // abandon when the durable row is genuinely terminal.
        const pauseAccepted = yield* Effect.gen(function* () {
          const attemptPause = port.pause(dagID).pipe(
            Effect.map(() => true),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
            ),
          )
          if (yield* attemptPause) return true
          if (yield* attemptPause) return true
          const row = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (row && row.status !== "paused") {
            yield* Effect.logError(
              "DagLoop recovery pause failed after retries — workflow stays unadopted; it will be re-adopted on the next instance load",
              { dagID, status: row.status },
            )
          }
          return row?.status === "paused"
        })
        if (!pauseAccepted) return
        yield* Effect.logWarning("DagLoop paused workflow after recovery invented node failures", {
          dagID,
          reconciled: recovery.reconciled,
          ownershipLost: recovery.ownershipLost,
        })
      }
      if (recovery.ownershipLost > 0 && !pausedForRecovery) {
        yield* Effect.logWarning("DagLoop terminalized recovered nodes after execution ownership loss", {
          dagID,
          reconciled: recovery.reconciled,
          ownershipLost: recovery.ownershipLost,
        })
      }
      // Rev-view (v1.0.15 Train A): the recovery runtime rebuilds from
      // the CURRENT graph revision — a crash must not revive the
      // replaced segment's failures (same rebuild input as the
      // WorkflowReplanned handler). Durable truth (the unfiltered read
      // in recovery reconcile above) is untouched.
      const nodes = yield* store.getCurrentNodes(dagID)
      const checkpoint = Checkpoint.latestReplanCheckpoint(config, nodes)
      const checkpointState = checkpoint ? yield* checkpointDisposition(dagID, checkpoint, port) : undefined
      const pausedForCheckpoint = checkpointState === "paused" || checkpointState === "held"
      if (pausedForCheckpoint) {
        yield* Effect.logWarning("DagLoop recovered unresolved checkpoint verdict: replan", {
          dagID,
          nodeID: checkpoint?.id,
          checkpointSeq: checkpoint?.seq,
          durable: checkpointState === "paused",
        })
      }
      const currentWorkflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
      const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
      const isPaused = currentWorkflow?.status === "paused" || pausedForRecovery || pausedForCheckpoint
      const isStepping = currentWorkflow?.status === "stepping" && !isPaused
      if (isPaused) runtime.setPaused(true)
      if (isStepping) runtime.setStepMode(true)
      const entry: WorkflowEntry = {
        token,
        port,
        runtime,
        concurrency: maxConcurrency,
        evalLock: Semaphore.makeUnsafe(1),
        parentSessionID: wf.sessionId,
        config,
        executionDirectory: currentWorkflow?.executionDirectory ?? wf.executionDirectory ?? wf.directory,
        graphRev: currentWorkflow?.graphRev ?? wf.graphRev,
        fibers: new Map(),
        watchers: new Map(),
        attemptChild: new WeakMap(),
        messageContinuations: new Set(recovery.continuations ?? []),
        vetoHold: checkpointState === "held",
      }
      // P2-E deletion-race re-check: the SessionV1.Event.Deleted sweep
      // only removes entries already published into `runtimes`. If the
      // FK cascade deleted this workflow's row while reconciliation ran,
      // publishing now would leak an inert entry the sweep can no longer
      // reach.
      if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
      // #270 atomic-admission fence (C3): the durable read above and the
      // runtimes publish below are still two statements — a deletion can
      // commit between them. One statement re-reads the lease with its
      // workflow (must exist, be non-terminal, still be this claim): a
      // cascade or takeover committed in that window aborts the adoption.
      if (!(yield* runnerLease.confirm(dagID, token))) return
      runtimes.set(dagID, entry)
      yield* automation.register(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
      // Only accepted messages may continue their existing child attempt.
      // Paused workflows defer that continuation until explicit resume.
      if (!isPaused) yield* entry.evalLock.withPermits(1)(startMessageContinuations(dagID, entry))
      if (!isPaused && !isStepping) {
        yield* entry.evalLock.withPermits(1)(
          Effect.gen(function* () {
            yield* spawnReady(dagID)
            yield* checkCompletion(dagID)
          }),
        )
      }
      // Deliver the invented-failure wake rows now instead of waiting for
      // the next idle event — the workflow just paused itself and the
      // parent is the only actor that can dispose of it.
      if (pausedForRecovery || pausedForCheckpoint) {
        yield* nudge(wf.sessionId)
      }
    }).pipe(
      // No entry at the end: give the claim back instead of letting it run out.
      Effect.onExit(() => runnerLease.abandon(dagID, claimed)),
    )
  })

  return recoverWorkflow
}
