// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagWorkflowTerminal from "./workflow-terminal"

import { DateTime, Effect } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import {
  isNodeTerminalStatus,
  isTerminalWorkflowStatusValue,
  isTransitionRejection,
  InvalidTransitionError,
  WorkflowStatus,
} from "@graphagent/core/dag/core/types"
import type { NodeStatus } from "@graphagent/core/dag/core/types"
import { unresolvedReviewOutcomes } from "./review-lifecycle"
import { parseWorkflowConfig } from "./workflow-config"
import { CompletionGateError, ReviewGateError, requiredCompletionGaps } from "./completion-gate"
import { ID, NodeID, type DagCommandCore, type WorkflowLock } from "./command-core"
import type { DagWorkflowPause } from "./workflow-pause"
import { DagLocation } from "./location"
import type { Interface, WorkflowOwner } from "./dag"

/**
 * What the terminal commands take from the pause module: `failUnrecoverable`
 * resumes a paused workflow before it fails it.
 */
export type PauseCommands = Pick<Effect.Success<ReturnType<typeof DagWorkflowPause.make>>, "resume">

/**
 * The mailbox reason of `failUnrecoverable`: only a workflow it failed closes
 * its mailbox. An `ignored` outcome means the workflow moved or terminalized
 * concurrently: the transaction must not close a live mailbox.
 */
export const failUnrecoverableMailboxReason = (outcome: "failed" | "ignored") =>
  outcome === "failed" ? "failed" : undefined

/**
 * The terminal family: cancelling, completing and failing a workflow (the
 * orphan and the unrecoverable variants included), the natural settlement, and
 * the node cleanup they share. They run on the one `Core` the layer built, so
 * they see the same services and guards as every other command module.
 */
export const make = (environment: DagCommandCore.Core, { resume }: PauseCommands) =>
  Effect.gen(function* () {
    const { events, store, guardWorkflow, withMailbox, withWorkflowLock, transact } = environment
    // Publish terminal node events for any non-terminal nodes so the read
    // model stays consistent after workflow termination. Running nodes get
    // NodeFailed when the workflow fails, otherwise a distinct NodeAborted;
    // pending/queued nodes get NodeSkipped. The projector's status guards make this
    // safe against races — a node that transitioned between the read and the
    // publish is silently left at its current status.
    const terminateNonTerminalNodes = Effect.fnUntraced(function* (
      lock: WorkflowLock,
      dagID: string,
      skipReason: "agent_complete" | "workflow_cancelled" | "workflow_failed",
      failReason: string,
      failRunning: boolean,
    ) {
      const nodes = yield* store.getNodes(dagID)
      for (const node of nodes) {
        if (isNodeTerminalStatus(node.status as NodeStatus)) continue
        const ts = yield* DateTime.now
        if (failRunning && node.status === "running") {
          yield* events.publish(DagEvent.NodeFailed, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: failReason,
            trigger: "exec_failed" as never,
            timestamp: ts,
          })
        } else if (node.status === "running") {
          yield* events.publish(DagEvent.NodeAborted, {
            dagID: ID.make(dagID),
            nodeID: NodeID.make(node.id),
            reason: skipReason,
            timestamp: ts,
          })
        } else {
          yield* events.publish(DagEvent.NodeSkipped, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: skipReason,
            timestamp: ts,
          })
        }
      }
    })

    const cancel = Effect.fn("Dag.cancel")(function* (lock: WorkflowLock, dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.CANCELLED)
      yield* events.publish(DagEvent.WorkflowCancelled, { dagID: dagID as ID, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(lock, dagID, "workflow_cancelled", "workflow_cancelled", false)
    })
    const complete = Effect.fn("Dag.complete")(function* (
      lock: WorkflowLock,
      dagID: string,
      options?: { readonly skipReviewGate?: boolean; readonly allowAcceptedSkips?: boolean },
    ) {
      yield* guardWorkflow(dagID, WorkflowStatus.COMPLETED)
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      const config = workflow ? parseWorkflowConfig(workflow.config) : undefined
      const nodes = yield* store.getNodes(dagID)
      // The review gate guards EXPLICIT completion (tool/HTTP shortcuts). A
      // natural completion at a REJECT checkpoint must stay reachable so the
      // parent can dispose of the verdict via reopen-extend (issue #294); the
      // scheduling loop passes skipReviewGate for that path.
      const unresolvedReviews =
        !options?.skipReviewGate && config ? unresolvedReviewOutcomes(config, nodes) : []
      if (unresolvedReviews.length > 0) yield* Effect.fail(new ReviewGateError(dagID, unresolvedReviews))
      // Required verdict/skip gaps gate every completion, including the
      // natural path: a verify FAIL or an unaccepted required skip must never
      // be announced as success (issue #950). Explicit completion is strict
      // even for nodes that have not started: forced completion cannot bypass
      // the invariant. The loop opts into historical accepted skips only on
      // its natural completion path, where the runtime has already proved the
      // graph terminal. Superseded revisions cannot block the current graph.
      const completionGaps = requiredCompletionGaps(
        config,
        yield* store.getCurrentNodes(dagID),
        options?.allowAcceptedSkips ? "natural" : "strict",
      )
      if (completionGaps.length > 0) yield* Effect.fail(new CompletionGateError(dagID, completionGaps))
      yield* terminateNonTerminalNodes(lock, dagID, "agent_complete", "", false)
      yield* events.publish(DagEvent.WorkflowCompleted, {
        dagID: dagID as ID,
        durationMs: 0 as never,
        timestamp: yield* DateTime.now,
      })
    })

    const fail = Effect.fn("Dag.fail")(function* (lock: WorkflowLock, dagID: string, reason: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.FAILED)
      yield* events.publish(DagEvent.WorkflowFailed, {
        dagID: dagID as ID,
        reason,
        failedNodes: [] as never,
        timestamp: yield* DateTime.now,
      })
      yield* terminateNonTerminalNodes(lock, dagID, "workflow_failed", reason, true)
    })

    /**
     * The orphan's terminalization (ADR-0008 Amendment 3, 4b-C): `WorkflowStarted`
     * legalizes the pending -> running leg that the projector requires of a
     * `WorkflowFailed`, and `fail` takes it from there, in the one transaction
     * of the command. The guard admits `pending` alone: `guardWorkflow` would let a
     * `paused` workflow through (paused -> running is legal), which no create
     * sequence leaves behind.
     */
    const failOrphan = Effect.fn("Dag.failOrphan")(function* (lock: WorkflowLock, dagID: string, reason: string) {
      const workflow = yield* guardWorkflow(dagID, WorkflowStatus.RUNNING)
      if (workflow.status !== WorkflowStatus.PENDING)
        yield* Effect.fail(new InvalidTransitionError(dagID, workflow.status, WorkflowStatus.RUNNING))
      yield* events.publish(DagEvent.WorkflowStarted, { dagID: ID.make(dagID), timestamp: yield* DateTime.now })
      yield* fail(lock, dagID, reason)
    })

    /**
     * Terminalize a workflow that can never progress. The projector accepts
     * WorkflowFailed only from running/stepping, so a pending row takes the
     * legal pending→running leg and a paused row the paused→running leg
     * before failing. The whole sequence runs under the workflow lock; a
     * concurrent terminal transition makes one leg a no-op and the attempt
     * collapses to `ignored`.
     *
     * #1344: `observed` is the verdict on the execution location, read before
     * the transaction opens because it waits for git (ADR-0008 decision 3).
     */
    const failUnrecoverableIn = Effect.fn("Dag.failUnrecoverable")(function* (
      lock: WorkflowLock,
      dagID: string,
      reason: string,
      observed: DagLocation.ExecutionObservation | undefined,
    ) {
      return yield* Effect.gen(function* () {
        const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        if (!workflow || isTerminalWorkflowStatusValue(workflow.status)) return "ignored" as const
        // Revalidate inside the transaction: a SessionEvent.Moved may have
        // re-stamped the row to a valid directory after the caller observed it
        // missing. The moved workflow must continue, not be failed with a stale
        // verdict. The verdict was read before the transaction opened, so it
        // counts only while the row still names the directories it was read
        // against; a row that moved since is left to the next evaluation.
        if (!observed || !DagLocation.executionObservationHolds(observed, workflow) || observed.location._tag === "ok")
          return "ignored" as const
        if (workflow.status === "pending") {
          yield* events.publish(DagEvent.WorkflowStarted, { dagID: ID.make(dagID), timestamp: yield* DateTime.now })
        } else if (workflow.status === "paused") {
          yield* resume(lock, dagID)
        }
        yield* fail(lock, dagID, reason)
        return "failed" as const
      }).pipe(Effect.catchIf(isTransitionRejection, () => Effect.succeed("ignored" as const)))
    })

    // `command`, with the read that waits for git between the lock and the
    // transaction: ADR-0008 decision 3 keeps it out of the latter.
    const failUnrecoverable: Interface["failUnrecoverable"] = (dagID, reason) =>
      withWorkflowLock(dagID)((lock) =>
        Effect.gen(function* () {
          const row = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          const observed =
            row && !isTerminalWorkflowStatusValue(row.status) ? yield* DagLocation.observeExecution(row) : undefined
          return yield* transact(
            dagID,
            withMailbox(dagID, failUnrecoverableMailboxReason, failUnrecoverableIn(lock, dagID, reason, observed)),
          )
        }),
      )

/** Natural terminalization shared by the owning DagLoop and the host-level
 * supervision sweep. The decision and the transition run under the same
 * workflow lock, and an optional expectedGraphRev fences a stale runtime
 * snapshot: a recover/replan that bumped the revision wins instead of
 * being failed with the old graph's evidence.
 */
    const settleCompletion = Effect.fn("Dag.settleCompletion")(function* (
      lock: WorkflowLock,
      dagID: string,
      options?: {
        readonly expectedGraphRev?: number
        readonly allowAcceptedSkips?: boolean
        readonly skipReviewGate?: boolean
        readonly owner?: WorkflowOwner
      },
    ) {
      // The authoritative reads, outcome, and terminal event (plus its
      // read-model projection) must share one durable SQLite immediate
      // transaction. The command's `transact` owns that transaction; a nested
      // events.publish uses a savepoint on the same connection, so a recover
      // in another process cannot advance the graph between the reads and the
      // terminal write.
      const terminalize = Effect.gen(function* () {
        const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        if (!workflow || isTerminalWorkflowStatusValue(workflow.status))
          return { status: "ignored" as const }
        if (options?.expectedGraphRev !== undefined && workflow.graphRev !== options.expectedGraphRev)
          return { status: "stale" as const }
        if (workflow.status === "paused") return { status: "ignored" as const }
        if (options?.owner) {
          const owner = options.owner
          const owned =
            workflow.projectId === owner.projectID &&
            workflow.directory !== "" &&
            DagLocation.canonicalDirectory(workflow.directory) === DagLocation.canonicalDirectory(owner.directory)
          // Re-check inside the fence: a SessionEvent.Moved may have re-stamped
          // the row after the caller's precheck, and the old instance must not
          // publish a terminal outcome for the new owner's workflow.
          if (!owned) return { status: "ignored" as const }
        }
        const nodes = yield* store.getCurrentNodes(dagID)
        const config = parseWorkflowConfig(workflow.config)
        // A required failure terminalizes now, even when its dependents are
        // still mounted as pending rows: the failure cascade makes them
        // non-executable and `fail` terminalizes them durably.
        const failed = nodes.filter((node) => node.required && node.status === "failed").map((node) => node.id)
        if (failed.length > 0) {
          yield* fail(lock, dagID, `required node(s) failed: ${failed.join(", ")}`)
          return { status: "failed" as const }
        }
        if (nodes.length === 0 || nodes.some((node) => !isNodeTerminalStatus(node.status as NodeStatus)))
          return { status: "ignored" as const }
        const gaps = requiredCompletionGaps(
          config,
          nodes,
          options?.allowAcceptedSkips === false ? "strict" : "natural",
        )
        if (gaps.length > 0) {
          yield* fail(lock, dagID, `required node(s) did not complete: ${gaps.join(", ")}`)
          return { status: "failed" as const }
        }
        yield* complete(lock, dagID, {
          skipReviewGate: options?.skipReviewGate ?? true,
          allowAcceptedSkips: options?.allowAcceptedSkips ?? true,
        })
        return { status: "completed" as const }
      })
      return yield* withMailbox(
        dagID,
        (result) => (result.status === "completed" || result.status === "failed" ? result.status : undefined),
        terminalize,
      ).pipe(Effect.catchIf(isTransitionRejection, () => Effect.succeed({ status: "ignored" as const })))
    })

    return {
      cancel,
      complete,
      fail,
      failOrphan,
      failUnrecoverable,
      settleCompletion,
    }
  })
