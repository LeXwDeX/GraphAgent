// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagNodeEvents from "./node-events"

import { Clock, DateTime, Effect, Option, Schema } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import {
  isNodeTerminalStatus,
  StaleNodeAttemptError,
  TerminalViolationError,
  NodeStatus,
} from "@graphagent/core/dag/core/types"
import type { DagCommandCore, ID, WorkflowLock } from "./command-core"
import { DagLocation } from "./location"
import { DagIsolation } from "./isolation"
import type { NodeExecutionAttempt } from "./dag"

export class StaleMessageInputError extends Schema.TaggedError<StaleMessageInputError>()(
  "StaleMessageInputError",
  {
    dagID: Schema.String,
    nodeID: Schema.String,
    reason: Schema.String,
  },
) {}
export const isStaleMessageInput = (error: unknown): error is StaleMessageInputError =>
  error instanceof StaleMessageInputError

/**
 * The node event commands: queueing, starting, completing, failing, skipping,
 * cancelling and restarting one node. They run on the one `Core` the layer
 * built, so they see the same services and guards as every other command
 * module.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store, mailboxService, transact, guardNode, guardWorkflowNotTerminal } = environment
    const nodeQueued = Effect.fn("Dag.nodeQueued")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      deadlineMs?: number,
      attempt?: NodeExecutionAttempt,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.QUEUED, attempt)
      yield* events.publish(DagEvent.NodeQueued, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        deadlineMs,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeStarted = Effect.fn("Dag.nodeStarted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
      deadlineMs?: number,
      wakeEligible?: boolean,
      attempt?: NodeExecutionAttempt,
      directory?: string,
      baseHead?: string,
      targetFingerprint?: DagEvent.TargetFingerprint,
      worktree?: DagEvent.NodeWorktree,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.RUNNING, attempt)
      yield* events.publish(DagEvent.NodeStarted, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        deadlineMs,
        wakeEligible,
        ...(directory !== undefined ? { directory } : {}),
        ...(baseHead !== undefined ? { baseHead } : {}),
        ...(targetFingerprint !== undefined ? { targetFingerprint } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        timestamp: yield* DateTime.now,
      })
    })
    const nodeCompleted = Effect.fn("Dag.nodeCompleted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      output: unknown,
      attempt?: NodeExecutionAttempt,
      capturedOutput?: unknown,
      worktree?: DagEvent.NodeWorktree,
      touchedPaths?: readonly string[],
    ) {
      const node = yield* guardNode(dagID, nodeID, NodeStatus.COMPLETED, attempt)
      const workflow = yield* store.getWorkflow(dagID)
      // #944: recompute the target identity for a node that recorded a start
      // fingerprint. Nodes persisted before #944 and target-insensitive nodes
      // carry none and are never stale. The computation is the bounded git
      // fingerprint from DagLocation (#1344: asynchronous, so the process keeps
      // running while the workflow lock waits for git). It stays inside the lock
      // because its directory and start fingerprint are this attempt's rows,
      // and before the transaction below because that takes database work only.
      const startFingerprint = node.targetFingerprint ?? undefined
      const executionDirectory =
        node.directory || workflow?.executionDirectory || workflow?.directory || undefined
      const completionFingerprint =
        startFingerprint && executionDirectory ? yield* DagLocation.fingerprintTarget(executionDirectory) : undefined
      const staleTarget = startFingerprint ? !DagLocation.sameFingerprint(startFingerprint, completionFingerprint) : false
      // #946: compare an isolated node's touched paths with the completed
      // isolated nodes already in this workflow. This is a report, never an
      // auto-merge: integration stays a normal downstream node.
      const completedNodes = worktree
        ? yield* Effect.suspend(() => store.getCurrentNodes(dagID)).pipe(
            Effect.catchCause(() => Effect.succeed([] as DagStore.NodeRow[])),
          )
        : []
      const conflicts = worktree
        ? DagIsolation.conflictsFor(
            worktree.touchedPaths,
            completedNodes
              .filter(
                (candidate) =>
                  candidate.id !== nodeID &&
                  candidate.status === "completed" &&
                  candidate.worktreeState !== null &&
                  candidate.worktreeState !== undefined &&
                  (candidate.touchedPaths?.length ?? 0) > 0,
              )
              .map((candidate) => ({ id: candidate.id, touchedPaths: candidate.touchedPaths ?? [] })),
          )
        : []
      const finalWorktree = worktree
        ? {
            ...worktree,
            conflictsWith: conflicts.map((conflict) => conflict.nodeID),
          }
        : undefined
      const messages = mailboxService
      const commit = Effect.gen(function* () {
        yield* guardNode(dagID, nodeID, NodeStatus.COMPLETED, attempt)
        yield* events.publish(
          DagEvent.NodeCompleted,
          Schema.decodeUnknownSync(DagEvent.NodeCompleted.data)({
            dagID,
            nodeID,
            output,
            ...(capturedOutput !== undefined ? { capturedOutput } : {}),
            ...(completionFingerprint !== undefined ? { targetFingerprint: completionFingerprint } : {}),
            ...(staleTarget ? { staleTarget: true } : {}),
            ...(finalWorktree !== undefined ? { worktree: finalWorktree } : {}),
            ...(touchedPaths !== undefined || finalWorktree !== undefined
              ? { touchedPaths: touchedPaths ?? finalWorktree?.touchedPaths ?? [] }
              : {}),
            durationMs: 0,
            timestamp: yield* Clock.currentTimeMillis,
          }),
        )
      })
      // The completion fingerprint (git) above ran before this point: the
      // transaction holds the write reservation and takes database work only.
      if (Option.isNone(messages) || !workflow?.directory || !node.childSessionId) {
        yield* transact(dagID, commit)
        return
      }
      const guarded = yield* transact(
        dagID,
        messages.value.guard(
          { projectID: workflow.projectId, directory: workflow.directory, sessionID: workflow.sessionId },
          {
            workflowID: dagID,
            nodeID,
            attemptID: DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts),
            snapshotID: attempt?.inputSnapshotID ?? node.capturedSnapshotID ?? undefined,
          },
          commit,
        ),
      )
      if (!guarded.ok) {
        if (guarded.reason === "stale_input" || guarded.reason === "unassociated")
          yield* new StaleMessageInputError({ dagID, nodeID, reason: guarded.reason })
        if (guarded.reason === "stopped")
          yield* Effect.fail(new Error("The node input snapshot was blocked or failed; it cannot complete"))
        yield* Effect.fail(
          new StaleNodeAttemptError(nodeID, attempt ?? { replanAttempts: node.replanAttempts }, {
            replanAttempts: node.replanAttempts,
            childSessionID: node.childSessionId,
            nodeSeq: node.seq,
            graphRev: workflow.graphRev,
          }),
        )
      }
    })
    const nodeFailed = Effect.fn("Dag.nodeFailed")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      reason: string,
      trigger: string,
      attempt?: NodeExecutionAttempt,
      errorClass?: string,
      worktree?: DagEvent.NodeWorktree,
    ) {
      const node = yield* guardNode(dagID, nodeID, NodeStatus.FAILED, attempt)
      const workflow = yield* store.getWorkflow(dagID)
      const messages = mailboxService
      const commit = Effect.gen(function* () {
        yield* guardNode(dagID, nodeID, NodeStatus.FAILED, attempt)
        yield* events.publish(
          DagEvent.NodeFailed,
          Schema.decodeUnknownSync(DagEvent.NodeFailed.data)({
            dagID,
            nodeID,
            reason,
            trigger,
            ...(errorClass ? { errorClass } : {}),
            ...(worktree !== undefined ? { worktree } : {}),
            timestamp: yield* Clock.currentTimeMillis,
          }),
        )
      })
      if (Option.isNone(messages) || !workflow?.directory || !node.childSessionId || node.status !== "running") {
        yield* transact(dagID, commit)
        return
      }
      const guarded = yield* transact(
        dagID,
        messages.value.guard(
          { projectID: workflow.projectId, directory: workflow.directory, sessionID: workflow.sessionId },
          {
            workflowID: dagID,
            nodeID,
            attemptID: DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts),
            failureReason: trigger,
            snapshotID: attempt?.inputSnapshotID,
            requireCurrentInput: trigger === "verdict_fail",
            expectedAcceptedRevision: attempt?.expectedAcceptedRevision,
          },
          commit,
        ),
      )
      if (!guarded.ok) {
        if (guarded.reason === "stale_input" || guarded.reason === "unassociated")
          yield* Effect.fail(new StaleMessageInputError({ dagID, nodeID, reason: guarded.reason }))
        yield* Effect.fail(new TerminalViolationError(nodeID, node.status, "failed"))
      }
    })

    const nodeSkipped = Effect.fn("Dag.nodeSkipped")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      reason: string,
      attempt?: NodeExecutionAttempt,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.SKIPPED, attempt)
      yield* events.publish(DagEvent.NodeSkipped, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        reason: reason as never,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeCancelled = Effect.fn("Dag.nodeCancelled")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      reason?: string,
    ) {
      // Cancellation is valid from any non-terminal status. NodeCancelled
      // projects to `failed`, a legal target from pending/queued/running, but
      // no single declared transition covers all three, so guard on terminality.
      yield* guardWorkflowNotTerminal(dagID, "cancelled")
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      if (isNodeTerminalStatus(node.status as NodeStatus)) {
        return yield* Effect.fail(new TerminalViolationError(nodeID, node.status, "cancelled"))
      }
      yield* events.publish(DagEvent.NodeCancelled, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        source: "control",
        ...(reason ? { reason } : {}),
        timestamp: yield* DateTime.now,
      })
    })
    const nodeRestarted = Effect.fn("Dag.nodeRestarted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.PENDING)
      yield* events.publish(DagEvent.NodeRestarted, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        timestamp: yield* DateTime.now,
      })
    })

    return { nodeQueued, nodeStarted, nodeCompleted, nodeFailed, nodeSkipped, nodeCancelled, nodeRestarted }
  })
