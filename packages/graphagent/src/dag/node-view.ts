// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagNodeView from "./node-view"

import type { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import type { DagSummary } from "@graphagent/schema/dag-summary"
import { DagLocation } from "./location"

/**
 * The one node-row projection shared by the HTTP `dag.nodes` endpoints and the
 * incremental `dag.workflow.nodes.updated` push. Keeping it here means the
 * fetched table and the pushed rows cannot drift.
 */
export function base(row: DagStore.NodeRow): DagSummary.NodeView {
  return {
    id: row.id,
    workflow_id: row.workflowId,
    name: row.name,
    worker_type: row.workerType,
    status: row.status,
    required: row.required,
    depends_on: row.dependsOn,
    ...(row.modelId !== null ? { model_id: row.modelId } : {}),
    ...(row.modelProviderId !== null ? { model_provider_id: row.modelProviderId } : {}),
    ...(row.childSessionId !== null ? { child_session_id: row.childSessionId } : {}),
    // #949: per-attempt execution location. Optional so rows persisted before
    // #949 and pre-#949 clients decode exactly as before.
    ...DagLocation.nodeLocationView(row),
    ...(row.output !== null || row.status === "completed" ? { output: row.output } : {}),
    ...(row.errorReason !== null ? { error_reason: row.errorReason } : {}),
    ...(row.errorClass !== null ? { error_class: row.errorClass } : {}),
    ...(row.deadlineMs !== null ? { deadline_ms: row.deadlineMs } : {}),
    replan_attempts: row.replanAttempts,
    ...(row.startedAt !== null ? { started_at: row.startedAt } : {}),
    ...(row.completedAt !== null ? { completed_at: row.completedAt } : {}),
  }
}

/**
 * Attach the attempt identity and mailbox counters that live outside the node
 * row. Callers pass the metadata result only when it succeeded, so a missing
 * mailbox (or an unavailable DagMessages service) leaves the base view intact.
 */
export function observed(
  view: DagSummary.NodeView,
  metadata: DagMessages.Metadata | undefined,
): DagSummary.NodeView {
  if (metadata === undefined) return view
  return {
    ...view,
    attempt_id: metadata.endpoint.attemptID,
    accepted_input_revision: metadata.accepted,
    snapshot_revision: metadata.snapshot,
    agent_messages: {
      queued: metadata.queued,
      delivered: metadata.delivered,
      undeliverable: metadata.undeliverable,
      closed_reason: metadata.closedReason,
    },
  }
}
