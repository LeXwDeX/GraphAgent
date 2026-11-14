// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { DagSummary } from "@graphagent/schema/dag-summary"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
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
  // D12: durable suspend reason; absent for a plain pause and for rows
  // written before the column existed.
  pause_reason: Schema.optional(Schema.String),
  config: Schema.String,
  seq: Schema.Number,
  started_at: Schema.optional(Schema.Number),
  completed_at: Schema.optional(Schema.Number),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "Dag.Workflow" })

// Reuse the event contract so HTTP `dag.nodes` rows and the incremental
// `dag.workflow.nodes.updated` push cannot drift.
export const NodeResponse = DagSummary.NodeView
export type NodeResponse = DagSummary.NodeView

export const DagListResponse = Schema.Array(WorkflowResponse)
export const DagNodeListResponse = Schema.Array(NodeResponse)

// Reuse the event/TUI contract so HTTP and push summaries cannot drift.
export const WorkflowSummaryResponse = DagSummary.WorkflowSummary

export const DagSummaryListResponse = Schema.Array(WorkflowSummaryResponse)

export const DagPaths = {
  list: `${root}`,
  bySession: `${root}/session/:sessionID`,
  summary: `${root}/session/:sessionID/summary`,
  nodes: `${root}/:dagID/nodes`,
} as const

// ============================================================================
// Route group
// ============================================================================

export const DagApi = HttpApi.make("dag").add(
  HttpApiGroup.make("dag")
    .add(
      HttpApiEndpoint.get("list", DagPaths.list, {
        success: described(DagListResponse, "All workflows"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.list", summary: "List all DAG workflows" })),
    )
    .add(
      HttpApiEndpoint.get("bySession", DagPaths.bySession, {
        params: { sessionID: Schema.String },
        success: described(DagListResponse, "Workflows for a session"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.bySession", summary: "List workflows by session" })),
    )
    .add(
      HttpApiEndpoint.get("summary", DagPaths.summary, {
        params: { sessionID: Schema.String },
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
      HttpApiEndpoint.get("nodes", DagPaths.nodes, {
        params: { dagID: Schema.String },
        success: described(DagNodeListResponse, "Nodes for a workflow"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "dag.nodes", summary: "List nodes for a workflow" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "dag", description: "DAG workflow inspector routes" }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
