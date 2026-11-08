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
export const Event = { Updated, Definitions: inventory(Updated) }
