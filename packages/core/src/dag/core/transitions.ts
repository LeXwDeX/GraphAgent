// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG scheduling core — transition-to-event mappings + status aggregation.
 *
 * Pure helpers extracted from the dag-iron-laws state-machine classes before
 * their deletion (capability reservoirs with zero production callers). These
 * encode transition→event-semantics and branch-status rollup that live
 * nowhere else and would otherwise be lost when the classes are deleted.
 *
 * The fourth helper from the old code (`buildStateSnapshot`) is intentionally
 * NOT ported: it constructs the dropped `WorkflowStateData` (state.json)
 * structure, which the EventV2-projection read-model replaces.
 *
 * These return event TYPE STRINGS (e.g. "node.started"), not EventV2 event
 * objects — Phase 1 defines the durable EventV2 events in schema/dag-event.ts
 * and the runtime constructs them. Layer A only carries the pure mapping.
 */

import { FallbackTrigger, NodeStatus, WorkflowStatus } from "./types"

/**
 * Aggregate a set of node statuses into a single branch/workflow-level status.
 *
 * Priority (highest wins): FAILED > RUNNING > QUEUED > all-COMPLETED >
 * all-SKIPPED > all-ABORTED > PENDING. Empty input → PENDING.
 *
 * Used by the runtime to derive a workflow's effective status from its nodes
 * (e.g. a workflow is RUNNING if any node is RUNNING, COMPLETED only when all
 * required nodes are COMPLETED).
 */
export function aggregateBranchStatus(statuses: NodeStatus[]): NodeStatus {
  if (statuses.length === 0) return NodeStatus.PENDING
  if (statuses.some((s) => s === NodeStatus.FAILED)) return NodeStatus.FAILED
  if (statuses.some((s) => s === NodeStatus.RUNNING)) return NodeStatus.RUNNING
  if (statuses.some((s) => s === NodeStatus.QUEUED)) return NodeStatus.QUEUED
  if (statuses.every((s) => s === NodeStatus.COMPLETED)) return NodeStatus.COMPLETED
  if (statuses.every((s) => s === NodeStatus.SKIPPED)) return NodeStatus.SKIPPED
  if (statuses.every((s) => s === NodeStatus.ABORTED)) return NodeStatus.ABORTED
  return NodeStatus.PENDING
}

/**
 * Map a node transition to its event type string, or null if the transition
 * produces no event.
 *
 * The from-status disambiguates semantically-identical transitions:
 * - PENDING|QUEUED → RUNNING emits "node.started"
 * - FAILED → RUNNING emits "node.restarted" (the replan restart path, D11)
 * - entering QUEUED emits "node.queued" (admission before permit, P0-2)
 *
 * Node-level PAUSED was removed in D11 (no NodePaused durable event exists),
 * so there is no "node.resumed" mapping.
 */
export function transitionToNodeEvent(from: NodeStatus, to: NodeStatus): string | null {
  switch (to) {
    case NodeStatus.RUNNING:
      if (from === NodeStatus.PENDING || from === NodeStatus.QUEUED) return "node.started"
      if (from === NodeStatus.FAILED) return "node.restarted"
      return null
    case NodeStatus.COMPLETED:
      return "node.completed"
    case NodeStatus.FAILED:
      return "node.failed"
    case NodeStatus.ABORTED:
      return "node.aborted"
    case NodeStatus.SKIPPED:
      return "node.skipped"
    case NodeStatus.QUEUED:
      return "node.queued"
    default:
      return null
  }
}

/**
 * Map a workflow transition to its event type string.
 *
 * Unlike nodes, workflow events are keyed solely on the target status (the
 * from-status doesn't disambiguate — a workflow reaching RUNNING is always
 * "workflow.started" or "workflow.resumed" depending on whether it came from
 * PAUSED; that distinction is made here).
 */
export function transitionToWorkflowEvent(from: WorkflowStatus, to: WorkflowStatus): string {
  switch (to) {
    case WorkflowStatus.RUNNING:
      return from === WorkflowStatus.PAUSED ? "workflow.resumed" : "workflow.started"
    case WorkflowStatus.PAUSED:
      return "workflow.paused"
    case WorkflowStatus.STEPPING:
      return "workflow.stepped"
    case WorkflowStatus.COMPLETED:
      return "workflow.completed"
    case WorkflowStatus.FAILED:
      return "workflow.failed"
    case WorkflowStatus.CANCELLED:
      return "workflow.cancelled"
    case WorkflowStatus.PENDING:
    default:
      return "workflow.created"
  }
}

/**
 * The default failure trigger for a node that failed without a specific reason.
 * Exported so the runtime can fall back to it when no explicit trigger is set.
 */
export const DEFAULT_FALLBACK_TRIGGER = FallbackTrigger.EXEC_FAILED
