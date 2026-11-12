// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagSummary from "./dag-summary"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { NonNegativeInt } from "./schema"

/** Aggregated per-workflow progress for TUI display. Mirrors DagStore.WorkflowSummary. */
export const WorkflowSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  // Topology invalidation token (#468): bumped by replan, so TUI refresh signatures can detect equal-count replans.
  graphRev: Schema.Number,
  nodeCount: Schema.Number,
  completedNodes: Schema.Number,
  runningNodes: Schema.Number,
  failedNodes: Schema.Number,
  // P2-9: skipped is a legitimate terminal state (condition gates) — progress
  // displays count completed+skipped as settled so a gated workflow doesn't
  // finish with a "3/9" denominator lie. queued surfaces true concurrency.
  skippedNodes: Schema.Number,
  // D11: aborted is terminal but not settled — the summary carries the count
  // as a required field now that the B2 compatibility window is closed.
  abortedNodes: NonNegativeInt,
  queuedNodes: Schema.Number,
  // F10: running nodes with a not-yet-adjudicated timeout escalation
  // (escalation_pending) — lets the TUI distinguish normal RUNNING from
  // timeout-pending. Already-adjudicated (extended) nodes are excluded.
  escalatedNodes: Schema.Number,
}).annotate({ identifier: "DagWorkflowSummary" })
export type WorkflowSummary = typeof WorkflowSummary.Type

/**
 * One node row, shared by the HTTP `dag.nodes` response and the incremental
 * `dag.workflow.nodes.updated` push so the two shapes cannot drift. Snake_case
 * mirrors the durable `workflow_node` projection, matching the HTTP contract.
 */
export const NodeView = Schema.Struct({
  id: Schema.String,
  workflow_id: Schema.String,
  name: Schema.String,
  worker_type: Schema.String,
  status: Schema.String,
  required: Schema.Boolean,
  depends_on: Schema.Array(Schema.String),
  model_id: Schema.optional(Schema.String),
  model_provider_id: Schema.optional(Schema.String),
  child_session_id: Schema.optional(Schema.String),
  // #949: per-attempt execution location. Optional so older servers and
  // legacy rows keep the same shape.
  directory: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  last_activity_at: Schema.optional(Schema.String),
  attempt_id: Schema.optional(Schema.String),
  accepted_input_revision: Schema.optional(NonNegativeInt),
  snapshot_revision: Schema.optional(NonNegativeInt),
  agent_messages: Schema.optional(
    Schema.Struct({
      queued: NonNegativeInt,
      delivered: NonNegativeInt,
      undeliverable: NonNegativeInt,
      closed_reason: Schema.optional(Schema.String),
    }),
  ),
  output: Schema.optional(Schema.Unknown),
  error_reason: Schema.optional(Schema.String),
  // Failed nodes only: the dag.node.failed trigger class
  // (timeout/exec_failed/verdict_fail/push_exhausted) for failure triage.
  error_class: Schema.optional(Schema.String),
  // Deadline (absolute epoch millis) fixed at admission; drives the running-
  // node countdown in the TUI inspector (P2-8).
  deadline_ms: Schema.optional(Schema.Number),
  // Incremented by replan restart — surfaces "restarted ×N" history in the TUI.
  replan_attempts: Schema.Number,
  started_at: Schema.optional(Schema.Number),
  completed_at: Schema.optional(Schema.Number),
}).annotate({ identifier: "Dag.Node" })
export type NodeView = typeof NodeView.Type


/**
 * Ephemeral (non-durable) event emitted by the stateless summary publisher
 * (packages/graphagent/src/dag/runtime/summary-publisher.ts). Carries the full
 * `WorkflowSummary[]` for a session, recomputed fresh from DagStore on every
 * emission. NOT registered in the durable-event manifest — consumers must
 * tolerate missed events during disconnects (the TUI re-fetches on bootstrap
 * as the safety net).
 */
const Updated = define({
  type: "dag.workflow.summary.updated",
  schema: {
    sessionID: SessionID,
    summaries: Schema.Array(WorkflowSummary),
  },
})

/**
 * Ephemeral node-level push (D3). Carries only the nodes a client has not seen
 * yet: `nodes` are full replacement rows for changed node ids, `removed` lists
 * ids that left the current view (for example superseded by a replan), and
 * `resync` asks the client to refetch the whole table instead of merging.
 * `seq` is monotonic per workflow; clients drop stale or duplicate pushes.
 */
const NodesUpdated = define({
  type: "dag.workflow.nodes.updated",
  schema: {
    sessionID: SessionID,
    workflowID: Schema.String,
    graphRev: Schema.Number,
    seq: NonNegativeInt,
    nodes: Schema.Array(NodeView),
    removed: Schema.Array(Schema.String),
    resync: Schema.optional(Schema.Boolean),
  },
})

export const Event = { Updated, NodesUpdated, Definitions: inventory(Updated, NodesUpdated) }
