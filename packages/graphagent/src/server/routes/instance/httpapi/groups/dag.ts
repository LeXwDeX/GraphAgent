// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { DagSummary } from "@graphagent/schema/dag-summary"
import { NonNegativeInt } from "@graphagent/schema/schema"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/dag"

// ============================================================================
// Response schemas
// ============================================================================

export const WorkflowResponse = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  session_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  config: Schema.String,
  seq: Schema.Number,
  started_at: Schema.optional(Schema.Number),
  completed_at: Schema.optional(Schema.Number),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "Dag.Workflow" })

export const NodeResponse = Schema.Struct({
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

export const DagListResponse = Schema.Array(WorkflowResponse)
export const DagNodeListResponse = Schema.Array(NodeResponse)

// Reuse the event/TUI contract so HTTP and push summaries cannot drift.
export const WorkflowSummaryResponse = DagSummary.WorkflowSummary

export const DagSummaryListResponse = Schema.Array(WorkflowSummaryResponse)

export const DagPaths = {
  list: `${root}`,
  bySession: `${root}/session/:sessionID`,
  summary: `${root}/session/:sessionID/summary`,
  detail: `${root}/:dagID`,
  nodes: `${root}/:dagID/nodes`,
  nodeDetail: `${root}/:dagID/nodes/:nodeID`,
} as const

// ============================================================================
// Route group
// ============================================================================

export const DagApi = HttpApi.make("dag").add(
  HttpApiGroup.make("dag")
    .add(
      HttpApiEndpoint.get("list", DagPaths.list, {
        query: WorkspaceRoutingQuery,
        success: described(DagListResponse, "All workflows"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.list", summary: "List all DAG workflows" })),
    )
    .add(
      HttpApiEndpoint.get("bySession", DagPaths.bySession, {
        params: { sessionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(DagListResponse, "Workflows for a session"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.bySession", summary: "List workflows by session" })),
    )
    .add(
      HttpApiEndpoint.get("summary", DagPaths.summary, {
        params: { sessionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(
          DagSummaryListResponse,
          "Aggregated per-workflow progress summaries for a session (server-side aggregation)",
        ),
        error: [ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "dag.summary", summary: "Aggregated workflow summaries by session" }),
      ),
    )
    .add(
      HttpApiEndpoint.get("detail", DagPaths.detail, {
        params: { dagID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(WorkflowResponse, "Workflow detail"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.detail", summary: "Get workflow by ID" })),
    )
    .add(
      HttpApiEndpoint.get("nodes", DagPaths.nodes, {
        params: { dagID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(DagNodeListResponse, "Nodes for a workflow"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.nodes", summary: "List nodes for a workflow" })),
    )
    .add(
      HttpApiEndpoint.get("nodeDetail", DagPaths.nodeDetail, {
        params: { dagID: Schema.String, nodeID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(NodeResponse, "Node detail"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.nodeDetail", summary: "Get node by ID" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "dag", description: "DAG workflow inspector routes" }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
