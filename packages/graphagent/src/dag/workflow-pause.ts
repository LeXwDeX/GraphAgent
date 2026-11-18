// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagWorkflowPause from "./workflow-pause"

import { DateTime, Effect } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagStore } from "@graphagent/core/dag/store"
import { WorkflowRuntime, toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import {
  isTerminalWorkflowStatusValue,
  WorkflowStatus,
  PAUSE_REASON_ARCHIVED,
  PAUSE_REASON_CHECKPOINT,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  ERROR_CLASS_BUDGET_EXHAUSTED,
} from "@graphagent/core/dag/core/types"
import type { PauseReason } from "@graphagent/core/dag/core/types"
import type { DagCommandCore, ID, WorkflowLock } from "./command-core"
import { DEFAULT_WORKFLOW_CONFIG, parseWorkflowConfig } from "./workflow-config"

/**
 * The pause family: pausing a workflow (manual, checkpoint, budget, archive),
 * resuming and stepping it, and requeueing the nodes a budget pause cancelled.
 * They run on the one `Core` the layer built, so they see the same services and
 * guards as every other command module. `resume` is returned for the modules
 * that lift a pause as part of their own command.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store, guardWorkflow } = environment
    const pause = Effect.fn("Dag.pause")(function* (lock: WorkflowLock, dagID: string, reason?: PauseReason) {
      yield* guardWorkflow(dagID, WorkflowStatus.PAUSED)
      yield* events.publish(DagEvent.WorkflowPaused, {
        dagID: dagID as ID,
        timestamp: yield* DateTime.now,
        ...(reason !== undefined ? { reason } : {}),
      })
    })
    const pauseForCheckpoint = Effect.fn("Dag.pauseForCheckpoint")(function* (
      lock: WorkflowLock,
      dagID: string,
      checkpointSeq: number,
    ) {
      const acknowledgedSeq = yield* store.getLatestCheckpointControlSeq(dagID)
      if (acknowledgedSeq !== undefined && acknowledgedSeq >= checkpointSeq) return "acknowledged" as const

      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (
        !workflow ||
        workflow.status === "completed" ||
        workflow.status === "failed" ||
        workflow.status === "cancelled"
      )
        return "inactive" as const
      if (workflow.status === "paused") return "paused" as const
      if (workflow.status !== "running" && workflow.status !== "stepping") {
        return "inactive" as const
      }

      // #1027 D6: stamp the durable reason so the summary can tell a
      // checkpoint pause (waiting for the main agent) from a manual one.
      yield* pause(lock, dagID, PAUSE_REASON_CHECKPOINT)
      return "paused" as const
    })
    const resume = Effect.fn("Dag.resume")(function* (lock: WorkflowLock, dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.RUNNING)
      yield* events.publish(DagEvent.WorkflowResumed, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    // Whether the workflow is still the pause episode the caller means to lift.
    const stillPausedFor = (workflow: DagStore.WorkflowRow, reason: PauseReason) =>
      workflow.status === "paused" && workflow.pauseReason === reason
    const resumeIfPausedFor = Effect.fn("Dag.resumeIfPausedFor")(function* (
      lock: WorkflowLock,
      dagID: string,
      reason: PauseReason,
    ) {
      // The transaction's own read: the policy check that precedes it ran outside
      // it, and what the caller read before that may be older still.
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow || !stillPausedFor(workflow, reason)) return "skipped" as const
      yield* resume(lock, dagID)
      return "resumed" as const
    })

    const step = Effect.fn("Dag.step")(function* (lock: WorkflowLock, dagID: string) {
      // Guard: only `running` → `stepping` is valid.
      yield* guardWorkflow(dagID, WorkflowStatus.STEPPING)
      // Reject if a node is still in-flight (one-at-a-time stepping). Queued
      // counts as in-flight: the node is durably admitted and will start once
      // a permit frees (P0-2) — stepping alongside it would put two nodes in
      // flight.
      // Rev-view (v1.0.15 Train A): step computes readiness over the CURRENT
      // graph revision — superseded rows must not re-seed their failures or
      // edges into the transient runtime. Superseded rows are terminal, so
      // the in-flight check is unaffected by the filter.
      const nodes = yield* store.getCurrentNodes(dagID)
      const hasInFlight = nodes.some((n) => n.status === "running" || n.status === "queued")
      if (hasInFlight) return yield* Effect.fail(new Error(`Node still in-flight: cannot step ${dagID}`))
      // Compute ready nodes using a transient WorkflowRuntime.
      const schedulingNodes = toSchedulingNodes(nodes)
      const config = parseWorkflowConfig((yield* store.getWorkflow(dagID))?.config ?? "")
      const maxConcurrency = Math.max(1, config?.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
      const runtime = new WorkflowRuntime(schedulingNodes, maxConcurrency)
      const ready = runtime.getReadyNodes()
      // A previously skipped dependency can leave a pending cascade node as
      // the only legal work. Give the loop a control event so it can converge
      // that non-executing state instead of stranding the workflow forever.
      const cascade = runtime.getCascadeSkipNodes()
      const nodeID = (ready.length > 0 ? ready : cascade).slice().sort()[0]
      if (!nodeID) return { status: "no_ready_nodes" as const }
      yield* events.publish(DagEvent.WorkflowStepped, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        timestamp: yield* DateTime.now,
      })
      return { status: "stepping" as const, nodeID }
    })

    const pauseForBudget = Effect.fn("Dag.pauseForBudget")(function* (lock: WorkflowLock, dagID: string) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow || isTerminalWorkflowStatusValue(workflow.status)) return "ignored" as const
      if (workflow.status === "pending") return "ignored" as const
      if (workflow.status !== "paused") {
        // D12: the durable pause reason is what survives a restart and what the
        // ResumeGuard consults before any resume/step.
        yield* pause(lock, dagID, PAUSE_REASON_BUDGET_EXHAUSTED)
      } else if (workflow.pauseReason !== PAUSE_REASON_BUDGET_EXHAUSTED) {
        // A manual/checkpoint pause owns its own in-flight policy; budget
        // exhaustion must not terminalize work this pause holds.
        return "ignored" as const
      }
      // In-flight attempts are cancelled now, not at the next scheduling round:
      // a child that already consumed a step would otherwise overshoot the
      // budget by roughly (in-flight nodes × one step). The loop's NodeFailed
      // handler aborts the child session; the durable event is the authority.
      //
      // Published directly, not through `nodeFailed`: that path consults the
      // mailbox fence, which can reject a failure when newer input arrived. A
      // workflow-level budget cancel must win over a stale-input race, exactly
      // like terminal workflow cleanup (`terminateNonTerminalNodes`). The
      // projector's status guard makes a racing completion a safe no-op.
      const nodes = yield* store.getCurrentNodes(dagID).pipe(Effect.orDie)
      for (const node of nodes) {
        if (node.status !== "running" && node.status !== "queued") continue
        yield* events.publish(DagEvent.NodeFailed, {
          dagID: DagEvent.DagID.make(dagID),
          nodeID: DagEvent.NodeID.make(node.id),
          reason: "DAG token budget exhausted",
          trigger: "exec_failed",
          errorClass: ERROR_CLASS_BUDGET_EXHAUSTED,
          timestamp: yield* DateTime.now,
        })
      }
      return "paused" as const
    })

    const requeueNodes = Effect.fn("Dag.requeueNodes")(function* (
      _lock: WorkflowLock,
      dagID: string,
      nodeIDs: readonly string[],
      reason: string,
    ) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      // Only a budget pause has an episode that can be requeued; any other
      // state leaves the request a no-op instead of touching terminal rows.
      if (workflow.status !== "paused" || workflow.pauseReason !== PAUSE_REASON_BUDGET_EXHAUSTED) {
        return { requeued: [] as readonly string[] }
      }
      const nodes = yield* store.getCurrentNodes(dagID).pipe(Effect.orDie)
      const byID = new Map(nodes.map((node) => [node.id, node]))
      const ids = [...new Set(nodeIDs)]
      for (const id of ids) {
        if (!byID.has(id)) return yield* Effect.fail(new Error(`Node not found: ${id}`))
      }
      // The error_class guard is the safety boundary: a terminal row cancelled
      // for any other reason stays immutable (the projector enforces it too).
      const eligible = ids.filter((id) => {
        const node = byID.get(id)!
        return node.status === "failed" && node.errorClass === ERROR_CLASS_BUDGET_EXHAUSTED
      })
      if (eligible.length === 0) return { requeued: [] as readonly string[] }
      const timestamp = yield* DateTime.now
      yield* events.publishMany(
        eligible.map((id) => ({
          definition: DagEvent.NodeRequeued,
          data: {
            dagID: DagEvent.DagID.make(dagID),
            nodeID: DagEvent.NodeID.make(id),
            reason,
            timestamp,
          },
        })),
      )
      return { requeued: eligible }
    })

    const pauseForArchive = Effect.fn("Dag.pauseForArchive")(function* (lock: WorkflowLock, dagID: string) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow || workflow.status === "pending" || isTerminalWorkflowStatusValue(workflow.status))
        return "ignored" as const
      if (workflow.status !== "paused") {
        yield* pause(lock, dagID, PAUSE_REASON_ARCHIVED)
        return "paused" as const
      }
      if (workflow.pauseReason === PAUSE_REASON_ARCHIVED) return "ignored" as const
      // A budget pause cancelled its in-flight attempts, and only the budget's
      // own resume requeues them (`DagBudget`, which stops seeing the workflow
      // once its reason changes). Requeue them with the relabel, so the main
      // agent's resume reruns them instead of settling the workflow on required
      // nodes the budget, not an agent, failed.
      if (workflow.pauseReason === PAUSE_REASON_BUDGET_EXHAUSTED) {
        const cancelled = (yield* store.getCurrentNodes(dagID).pipe(Effect.orDie))
          .filter((node) => node.status === "failed" && node.errorClass === ERROR_CLASS_BUDGET_EXHAUSTED)
          .map((node) => node.id)
        if (cancelled.length > 0) yield* requeueNodes(lock, dagID, cancelled, "session archived")
      }
      // Already paused (a budget, checkpoint, recovery or manual pause): the
      // state machine has no paused -> paused transition, so this is not
      // `pause`. The projector accepts the pause event from `paused` for this
      // reason alone and changes only the reason.
      yield* events.publish(DagEvent.WorkflowPaused, {
        dagID: DagEvent.DagID.make(dagID),
        timestamp: yield* DateTime.now,
        reason: PAUSE_REASON_ARCHIVED,
      })
      return "relabeled" as const
    })

    return {
      pause,
      pauseForCheckpoint,
      resume,
      stillPausedFor,
      resumeIfPausedFor,
      step,
      pauseForBudget,
      requeueNodes,
      pauseForArchive,
    }
  })
