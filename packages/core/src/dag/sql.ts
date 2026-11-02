// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"

/**
 * DAG read-model tables (CQRS projection from EventV2 events).
 *
 * Three tables: workflow (current state per DAG), workflow_node (current state
 * per node), workflow_violation (audit). History comes from EventV2 replay, not
 * a log table — mirroring SessionProjector's session_message pattern.
 *
 * `seq` columns carry the durable event sequence number (event.durable.seq) so
 * history queries can orderBy(seq) for correct replay ordering.
 */

export const WorkflowTable = sqliteTable(
  "workflow",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // Execution-location key (DAG-LOC-01): the directory that owns this workflow.
    // Only the instance whose directory matches may adopt, recover, wake, or spawn
    // for it. TWO-WRITER WHITELIST (#269): the stamp is written at dag.create
    // (WorkflowCreated projection INSERT, onConflictDoNothing — a replay can never
    // rewrite an existing stamp) and re-stamped ONLY by the session projector's
    // SessionEvent.Moved projection (the stamp moves WITH the session in one
    // transaction, payload-sourced from the Moved event — no SessionTable read).
    // No other writer may set it; R7-ext pins the whitelist. Nullable: legacy rows
    // predating the column match no instance (fail-closed — never adopted until
    // recreated).
    directory: text(),
    // Execution directory (#943): the bound workspace (absolute realpath) where
    // this workflow's child sessions run. Separate from `directory`, which
    // keeps deciding ownership, adoption, recovery and wake. NULL means "run in
    // the owner directory" — the pre-#943 behavior for every legacy row.
    execution_directory: text(),
    title: text().notNull(),
    status: text().notNull(),
    config: text().notNull(), // YAML string
    seq: integer().notNull(), // latest durable event seq
    wake_reported: integer({ mode: "boolean" }).notNull().default(false), // D3: terminal or paused reminder reported to parent for this status episode?
    // Rev-view (v1.0.15 Train A): the current graph-revision counter. Bumped
    // by the WorkflowReplanned projection; audit/telemetry only — the view
    // predicate is the per-node `superseded` marker below. Default 1: legacy
    // rows predate the concept and render exactly as before.
    graph_rev: integer().notNull().default(1),
    started_at: integer(),
    completed_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_project_idx").on(table.project_id),
    index("workflow_session_idx").on(table.session_id),
    index("workflow_status_idx").on(table.status),
    uniqueIndex("workflow_id_seq_idx").on(table.id, table.seq),
  ],
)

export const WorkflowNodeTable = sqliteTable(
  "workflow_node",
  {
    id: text().notNull(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    worker_type: text().notNull(),
    status: text().notNull(),
    required: integer({ mode: "boolean" }).notNull().default(true),
    depends_on: text({ mode: "json" }).$type<string[]>().notNull(),
    model_id: text(), // optional model override (modelID from DagEvent.NodeModel)
    model_provider_id: text(), // optional model override (providerID)
    child_session_id: text(),
    // Per-attempt execution location (#949): the directory this node ran in
    // and the repo HEAD observed when it started. Snapshotted on NodeStarted
    // so status/observe keep reporting the attempt's origin after the branch
    // moves. Nullable: legacy rows and non-git directories have no HEAD.
    directory: text(),
    base_head: text(),
    output: text({ mode: "json" }).$type<unknown>(),
    error_reason: text(),
    error_class: text(), // dag.node.failed trigger (timeout/exec_failed/verdict_fail/push_exhausted) for failure triage
    captured_output: text({ mode: "json" }).$type<unknown>(), // durable payload from submit_result, or a Train B file-ref record ({content_ref, size, sha256, summary}); survives a process crash, reset to null on a replan-restart via NodeStarted
    captured_output_present: integer({ mode: "boolean" }).notNull().default(false),
    captured_snapshot_id: text(),
    deadline_ms: integer(), // absolute deadline (spawnedAt + timeout_ms) for D0 termination boundary
    wake_eligible: integer({ mode: "boolean" }).notNull().default(false), // D6: node has report_to_parent=true
    wake_reported: integer({ mode: "boolean" }).notNull().default(false), // D3: has this node's terminal event been injected into the parent session?
    replan_attempts: integer().notNull().default(0), // D4: per-node replan counter for circuit breaker
    timeout_extensions: integer().notNull().default(0), // timeout escalation count (node stays running; main agent adjudicates)
    escalation_pending: integer({ mode: "boolean" }).notNull().default(false), // set on escalate, cleared on adjudication (extend) or new attempt — "awaiting main-agent adjudication"
    // Rev-view (v1.0.15 Train A): this node was pushed OUT of the current
    // graph revision by a replan (cancelled via replan, or a terminal row the
    // fragment bypassed). Durable data is untouched — the marker only filters
    // VIEW/aggregation reads (summaries, status, node lists, rebuild input,
    // wake attribution) to the current revision. Monotonic: once true, stays
    // true. Default false: legacy rows render exactly as before.
    superseded: integer({ mode: "boolean" }).notNull().default(false),
    seq: integer().notNull(), // latest durable event seq for this node
    started_at: integer(),
    completed_at: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.workflow_id, table.id] }),
    index("workflow_node_workflow_idx").on(table.workflow_id),
    index("workflow_node_workflow_status_idx").on(table.workflow_id, table.status),
    uniqueIndex("workflow_node_workflow_id_seq_idx").on(table.workflow_id, table.id, table.seq),
  ],
)

/**
 * Reserved audit table. The physical table exists via the 20260702 migration
 * but NOTHING writes or reads it yet — the read surface was removed from
 * DagStore as dead code. Keep the definition so the drizzle schema matches
 * the database; wire producers (sanitizer hits, ceiling rejections,
 * orchestrator_unresponsive verdicts) before adding any query surface back.
 */
export const WorkflowViolationTable = sqliteTable(
  "workflow_violation",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    node_id: text(),
    type: text().notNull(),
    severity: text().notNull(),
    message: text().notNull(),
    details: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_violation_workflow_idx").on(table.workflow_id),
    index("workflow_violation_severity_idx").on(table.workflow_id, table.severity),
  ],
)
