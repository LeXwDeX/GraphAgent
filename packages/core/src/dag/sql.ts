// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
import { DagEvent } from "@graphagent/schema/dag-event"
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
    // No other writer may set it; R7-ext pins the whitelist. Required: create
    // always stamps the target session's durable directory.
    directory: text().notNull(),
    // Execution directory (#943): the bound workspace (absolute realpath) where
    // this workflow's child sessions run. Separate from `directory`, which
    // keeps deciding ownership, adoption, recovery and wake. NULL means "run in
    // the owner directory" — no workspace is configured.
    execution_directory: text(),
    // Target fingerprint (#944): the working-tree identity captured when the
    // workflow started. Create always writes it; `{ kind: "none" }` is the
    // explicit marker for a non-git directory.
    target_fingerprint: text({ mode: "json" }).$type<DagEvent.TargetFingerprint>().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    // D12: why the workflow is paused (e.g. "budget_exhausted"). NULL when the
    // pause carried no reason. Cleared by resume/terminal/replan projections so
    // a stale reason cannot outlive the pause episode.
    pause_reason: text(),
    config: text().notNull(), // YAML string
    seq: integer().notNull(), // latest durable event seq
    wake_reported: integer({ mode: "boolean" }).notNull().default(false), // D3: terminal or paused reminder reported to parent for this status episode?
    // Rev-view (v1.0.15 Train A): the current graph-revision counter. Bumped
    // by the WorkflowReplanned projection; audit/telemetry only — the view
    // predicate is the per-node `superseded` marker below. Default 1 is the
    // first graph revision.
    graph_rev: integer().notNull().default(1),
    // #1010 (E0): workflow-level worktree settlement, written by the E3
    // projection from `WorkflowWorktreeSettled`. NULL means the workflow has
    // no workflow-level worktree (all isolation is per node).
    worktree: text({ mode: "json" }).$type<DagEvent.NodeWorktree>(),
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
    // moves. Nullable: non-git directories have no HEAD.
    directory: text(),
    base_head: text(),
    // Target fingerprint (#944): the start fingerprint for target-sensitive
    // nodes, replaced by the completion fingerprint on NodeCompleted. NULL for
    // nodes that do not judge the working tree.
    target_fingerprint: text({ mode: "json" }).$type<DagEvent.TargetFingerprint>(),
    // True when a completed target-sensitive node saw a different tree than it
    // started with. NULL until evaluated; reads as false.
    stale_target: integer({ mode: "boolean" }),
    // #946: worktree isolation evidence. NULL for non-isolated rows.
    // `worktree_state` is active|removed|kept; kept rows are the ones a failed
    // node leaves for inspection.
    worktree_directory: text(),
    worktree_branch: text(),
    worktree_commit: text(),
    worktree_patch_path: text(),
    worktree_patch_sha256: text(),
    worktree_state: text(),
    worktree_conflicts_with: text({ mode: "json" }).$type<string[]>(),
    // #946: worktrees a later attempt on this node replaced. NodeStarted
    // archives the prior pointer here before overwriting it, so status can
    // still report a kept/active worktree the current row no longer names.
    // NULL for nodes that never restarted.
    worktree_history: text({ mode: "json" }).$type<DagEvent.NodeWorktree[]>(),
    // #946: paths this node changed at completion. Non-isolated nodes record
    // them from `git status --porcelain`; isolated nodes mirror the worktree
    // list here too so status can compare every writer uniformly.
    touched_paths: text({ mode: "json" }).$type<string[]>(),
    output: text({ mode: "json" }).$type<unknown>(),
    error_reason: text(),
    error_class: text(), // dag.node.failed trigger (timeout/exec_failed/verdict_fail/push_exhausted) for failure triage
    captured_output: text({ mode: "json" }).$type<unknown>(), // durable final-response payload, or a Train B file-ref record ({content_ref, size, sha256, summary}); survives a process crash, reset to null on a replan-restart via NodeStarted
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
    // true. Default false: the node is part of the current revision.
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
    // H3/E2 look nodes up by child session; keep the reverse lookup indexed.
    index("workflow_node_child_session_idx").on(table.child_session_id),
    uniqueIndex("workflow_node_workflow_id_seq_idx").on(table.workflow_id, table.id, table.seq),
  ],
)

/**
 * #1010 (E0): per-attempt ledger for node usage accounting, projected from
 * `dag.node.started` by E2. `child_session_id` intentionally has no foreign
 * key: child sessions may be cleaned up before the ledger row, and the row is
 * removed together with its workflow (ON DELETE CASCADE on `workflow_id`).
 */
export const DagNodeAttemptTable = sqliteTable(
  "dag_node_attempt",
  {
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    attempt: integer().notNull(),
    child_session_id: text().notNull(),
    started_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflow_id, table.node_id, table.attempt] }),
    index("dag_node_attempt_child_session_idx").on(table.child_session_id),
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
