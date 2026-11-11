// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagSummary from "./dag-summary"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { NonNegativeInt } from "./schema"

/** #1027 D6: review-quality counters for the `/dag` panel, computed by the
 * same rule as the workflow inspection status. `null` when the workflow is
 * not strict or has no reviews yet. */
export const WorkflowQuality = Schema.Struct({
  /** A binding ACCEPT decision exists for the final target fingerprint. */
  reviewBound: Schema.Boolean,
  reviews: NonNegativeInt,
  raised: NonNegativeInt,
  fixed: NonNegativeInt,
  refuted: NonNegativeInt,
  stillOpen: NonNegativeInt,
  skepticRefutations: NonNegativeInt,
  rounds: NonNegativeInt,
  quietRounds: NonNegativeInt,
  completeness: Schema.NullOr(
    Schema.Struct({
      covered: NonNegativeInt,
      total: NonNegativeInt,
      unlisted: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "DagWorkflowQuality" })
export type WorkflowQuality = typeof WorkflowQuality.Type

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
  // #1027 D6: optional so an older client still decodes a newer server's
  // event. The consumer contract fixes the names and types; D6b fills
  // `quality` and `coverageCount` once their owner Issues define the sources.
  /** Σ input + cache write + output + reasoning across every attempt's child session. */
  tokens: Schema.optional(NonNegativeInt),
  /** Cache reads tracked separately; they are not part of the token budget. */
  tokensCacheRead: Schema.optional(NonNegativeInt),
  /** DAG-wide running child slots in this process (not this workflow's). */
  concurrencyRunning: Schema.optional(NonNegativeInt),
  /** Coverage entries (skipped/failed/cancelled/aborted nodes and unread pages); 0 = none. */
  coverageCount: Schema.optional(NonNegativeInt),
  /** A durable checkpoint pause is waiting for the main agent. */
  checkpointPending: Schema.optional(Schema.Boolean),
  /** Review quality; null until the review-aggregation owner lands (D6b). */
  quality: Schema.optional(Schema.NullOr(WorkflowQuality)),
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
