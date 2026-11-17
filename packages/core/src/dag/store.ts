// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagStore from "./store"

import { and, asc, count, desc, eq, gt, inArray, lte, max, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Database } from "../database/database"
import { versionedType } from "../event"
import { EventTable } from "../event/sql"
import { LayerNode } from "../effect/layer-node"
import { DagNodeAttemptTable, WorkflowNodeTable, WorkflowTable } from "./sql"
import { SessionTable } from "../session/sql"
import { isTerminalWorkflowStatusValue, WORKFLOW_TERMINAL_STATUS_VALUES } from "./core/types"

// ============================================================================
// Row → domain types
// ============================================================================

export interface WorkflowRow {
  id: string
  projectId: string
  sessionId: string
  /** Execution-location key (DAG-LOC-01): the creating instance's directory. */
  directory: string
  /** #943: bound workspace where children run; NULL/absent means the owner directory. */
  executionDirectory?: string | null
  /** #944: working-tree identity captured at workflow start. */
  targetFingerprint: DagEvent.TargetFingerprint
  title: string
  status: string
  /** D12: why the workflow is paused (e.g. "budget_exhausted"); null outside a pause episode. */
  pauseReason: string | null
  config: string
  seq: number
  wakeReported: boolean
  /** Rev-view (v1.0.15 Train A): current graph-revision counter (audit/telemetry). */
  graphRev: number
  /** #1030 D9-g: workflow-level worktree settlement evidence. NULL/absent
   * means no workflow-level worktree (or no settlement yet). */
  worktree?: DagEvent.WorkflowWorktree | null
  startedAt: number | null
  completedAt: number | null
  timeCreated: number
  timeUpdated: number
}

export interface NodeRow {
  id: string
  workflowId: string
  name: string
  workerType: string
  status: string
  required: boolean
  dependsOn: string[]
  modelId: string | null
  modelProviderId: string | null
  childSessionId: string | null
  output: unknown
  capturedOutput: unknown
  /** Submission presence is independent of the JSON value (which may be null). */
  capturedOutputPresent?: boolean
  capturedSnapshotID?: string | null
  errorReason: string | null
  errorClass: string | null
  deadlineMs: number | null
  wakeEligible: boolean
  wakeReported: boolean
  replanAttempts: number
  timeoutExtensions: number
  escalationPending: boolean
  /** Rev-view (v1.0.15 Train A): pushed out of the current graph revision by a replan. */
  superseded: boolean
  seq: number
  startedAt: number | null
  completedAt: number | null
  /** #949: execution directory and HEAD snapshotted by NodeStarted. */
  directory?: string | null
  baseHead?: string | null
  /** #944: start/completion target fingerprint and the mismatch verdict. */
  targetFingerprint?: DagEvent.TargetFingerprint | null
  staleTarget?: boolean | null
  /** #1031 M7: bounded DAG safety denials recorded for this node. */
  safetyDenials?: DagEvent.NodeSafetyDenials | null
  /** #946: isolated worktree evidence and the paths this node changed. */
  worktreeDirectory?: string | null
  worktreeBranch?: string | null
  worktreeCommit?: string | null
  worktreePatchPath?: string | null
  worktreePatchSha256?: string | null
  worktreeState?: string | null
  worktreeConflictsWith?: string[] | null
  /** #946: superseded worktree pointers, oldest first. */
  worktreeHistory?: DagEvent.NodeWorktree[] | null
  touchedPaths?: string[] | null
  /** Projection timestamps. Optional so hand-built rows in tests keep a
   * minimal shape; the database read always projects them. */
  timeCreated?: number
  timeUpdated?: number
}

export interface WakeBatch {
  readonly nodes: readonly NodeRow[]
  readonly workflows: readonly WorkflowRow[]
}

export interface WakeSnapshot {
  readonly nodes: readonly NodeRow[]
  readonly workflows: readonly WorkflowRow[]
}

/** #1026: the sessions `getSessionsWithDueWakes` lists, split by the ledger
 * that listed them. Each array is distinct and in session ID order (SQLite's
 * binary collation); one session can appear in both. */
export interface DueWakeSessions {
  /** An unreported wake: a terminal workflow, or a wake-deliverable node. */
  readonly wake: readonly string[]
  /** A paused workflow whose once-per-episode reminder is due. */
  readonly paused: readonly string[]
}

/** The ledger a `getSessionsWithDueWakes` arm reads, carried as a literal column. */
type DueWakeSource = keyof DueWakeSessions

const byCodeUnit = (a: string, b: string) => Number(a > b) - Number(a < b)

/** #945: the durable target change carried by the latest retarget replan. */
export type RetargetData = NonNullable<(typeof DagEvent.WorkflowReplanned.data)["Type"]["retarget"]>

export interface RetargetRecord {
  readonly seq: number
  readonly retarget: RetargetData
}

/** Aggregated per-workflow progress for UI display. Shape matches the TUI's DagWorkflowSummary. */
export interface WorkflowSummary {
  id: string
  title: string
  status: string
  /** Topology invalidation token (#468): bumped by replan, so TUI refresh signatures can detect equal-count replans. */
  graphRev: number
  nodeCount: number
  completedNodes: number
  runningNodes: number
  failedNodes: number
  skippedNodes: number
  /** D11: aborted is a distinct terminal count (not part of completed+skipped settled progress). */
  abortedNodes: number
  queuedNodes: number
  /** Running nodes with a not-yet-adjudicated timeout escalation (escalation_pending). */
  escalatedNodes: number
  /** #1027 D6: Σ over every attempt's child session of input + cache write +
   * output + reasoning tokens; cache read is reported separately because it
   * is not part of the budget. Attempts come from the durable ledger, so a
   * retried node's earlier attempts stay counted after the node row moves on
   * to its latest child session. */
  tokens: number
  tokensCacheRead: number
  /** #1027 D6: durable checkpoint pause awaiting the main agent. */
  checkpointPending: boolean
}

/**
 * #1027 D6b: one current-revision node row as summary derivation reads it.
 * Only the fields coverage and review quality consume, so a large report
 * output is never loaded for a node that does not need it. `output` is the
 * parsed JSON value like `NodeRow.output` and is present only where
 * `getSummaryNodes` was asked for it.
 */
export interface SummaryNodeRow {
  id: string
  workflowId: string
  status: string
  dependsOn: string[]
  errorReason: string | null
  errorClass: string | null
  safetyDenials: DagEvent.NodeSafetyDenials | null
  staleTarget: boolean | null
  /** Always false: only the current graph revision is read. */
  superseded: false
  output?: unknown
}

/** The key a `getSummaryNodes` `outputs` entry is matched against. */
export const summaryNodeKey = (workflowId: string, nodeId: string) => `${workflowId}\u001f${nodeId}`

const mapWorkflow = (r: typeof WorkflowTable.$inferSelect): WorkflowRow => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  directory: r.directory,
  executionDirectory: r.execution_directory,
  targetFingerprint: r.target_fingerprint,
  title: r.title,
  status: r.status,
  pauseReason: r.pause_reason,
  config: r.config,
  seq: r.seq,
  wakeReported: r.wake_reported,
  graphRev: r.graph_rev,
  worktree: r.worktree,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  timeCreated: r.time_created,
  timeUpdated: r.time_updated,
})

const mapNode = (r: typeof WorkflowNodeTable.$inferSelect): NodeRow => ({
  id: r.id,
  workflowId: r.workflow_id,
  name: r.name,
  workerType: r.worker_type,
  status: r.status,
  required: r.required,
  dependsOn: r.depends_on,
  modelId: r.model_id,
  modelProviderId: r.model_provider_id,
  childSessionId: r.child_session_id,
  directory: r.directory,
  baseHead: r.base_head,
  targetFingerprint: r.target_fingerprint,
  staleTarget: r.stale_target,
  safetyDenials: r.safety_denials,
  worktreeDirectory: r.worktree_directory,
  worktreeBranch: r.worktree_branch,
  worktreeCommit: r.worktree_commit,
  worktreePatchPath: r.worktree_patch_path,
  worktreePatchSha256: r.worktree_patch_sha256,
  worktreeState: r.worktree_state,
  worktreeConflictsWith: r.worktree_conflicts_with,
  worktreeHistory: r.worktree_history,
  touchedPaths: r.touched_paths,
  output: r.output,
  capturedOutput: r.captured_output,
  capturedOutputPresent: r.captured_output_present,
  capturedSnapshotID: r.captured_snapshot_id,
  errorReason: r.error_reason,
  errorClass: r.error_class,
  deadlineMs: r.deadline_ms,
  wakeEligible: r.wake_eligible,
  wakeReported: r.wake_reported,
  replanAttempts: r.replan_attempts,
  timeoutExtensions: r.timeout_extensions,
  escalationPending: r.escalation_pending,
  superseded: r.superseded,
  seq: r.seq,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  timeCreated: r.time_created,
  timeUpdated: r.time_updated,
})

// F11: wake eligibility gates TERMINAL notifications (the report_to_parent
// contract) — but a timeout-escalated node must reach the main agent
// REGARDLESS of report_to_parent AND regardless of its current status: the
// escalation wake is the only force behind the extension cap, and a
// non-eligible node (default config) would otherwise never be adjudicated.
// Escalated-then-terminalized nodes (cap-exhausted force-cancel) still need
// delivery, and so do escalated-then-COMPLETED nodes: the main agent already
// spent turns adjudicating this node (the extend path), so its result is the
// receipt for those turns — withholding it behind report_to_parent would
// silently lose adjudicated work. Single source of truth for snapshot /
// unreported / bootstrap-sweep wake queries.
const wakeDeliverableNodePredicate = or(
  and(
    eq(WorkflowNodeTable.wake_eligible, true),
    inArray(WorkflowNodeTable.status, ["completed", "failed"]),
  ),
  gt(WorkflowNodeTable.timeout_extensions, 0),
)

// The two arms of the unreported-wake ledger, one predicate per table. The
// startup list (`getSessionsWithUnreportedWakes`) and the inbox tick read
// (`getSessionsWithDueWakes`) share them, so the two cannot disagree on what
// counts as an unreported wake.
const unreportedWakeWorkflowPredicate = and(
  eq(WorkflowTable.wake_reported, false),
  inArray(WorkflowTable.status, [...WORKFLOW_TERMINAL_STATUS_VALUES]),
)
const unreportedWakeNodePredicate = and(eq(WorkflowNodeTable.wake_reported, false), wakeDeliverableNodePredicate)

const checkpointControlTypes = [DagEvent.WorkflowResumed, DagEvent.WorkflowReplanned, DagEvent.WorkflowStepped].map(
  (definition) => {
    if (!definition.durable) throw new Error(`Checkpoint control event is not durable: ${definition.type}`)
    return versionedType(definition.type, definition.durable.version)
  },
)

const workflowFailedType = (() => {
  if (!DagEvent.WorkflowFailed.durable) throw new Error("WorkflowFailed event is not durable")
  return versionedType(DagEvent.WorkflowFailed.type, DagEvent.WorkflowFailed.durable.version)
})()

const workflowReplannedType = (() => {
  if (!DagEvent.WorkflowReplanned.durable) throw new Error("WorkflowReplanned event is not durable")
  return versionedType(DagEvent.WorkflowReplanned.type, DagEvent.WorkflowReplanned.durable.version)
})()

// ============================================================================
// Service interface
// ============================================================================

export interface Interface {
  readonly getWorkflow: (id: string) => Effect.Effect<WorkflowRow | undefined>
  readonly listWorkflows: () => Effect.Effect<WorkflowRow[]>
  readonly listBySession: (sessionId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByProject: (projectId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByStatus: (status: string) => Effect.Effect<WorkflowRow[]>
  readonly getWorkflowSummaries: (sessionId: string) => Effect.Effect<WorkflowSummary[]>
  /** Parent-session view of `getWorkflowSummaries`; same aggregation and ordering. */
  readonly listSummariesByParent: (sessionId: string) => Effect.Effect<WorkflowSummary[]>
  /**
   * #1027 D6b: an opaque change marker per workflow of one session, in one
   * statement. It differs whenever an event was projected for the workflow
   * (the workflow row and every current node row carry the latest durable
   * event seq and update time), so a value derived from the workflow's config
   * and node rows stays valid exactly as long as the marker does. The marker
   * is only ever compared for equality.
   */
  readonly getWorkflowRevisions: (sessionId: string) => Effect.Effect<ReadonlyMap<string, string>>
  /**
   * #1027 D6b: the current-graph node rows summary-derived values (coverage
   * count, review quality) are computed from, for several workflows, in one
   * statement regardless of how many workflows or nodes they hold. Light
   * columns come back for every node. A node's `output` is loaded only when
   * its `summaryNodeKey` is in `outputs`, or when its stored output mentions
   * `not_examined` (a coverage source on any node); a large report node is
   * otherwise never read.
   */
  readonly getSummaryNodes: (input: {
    readonly workflowIds: readonly string[]
    readonly outputs: ReadonlySet<string>
  }) => Effect.Effect<SummaryNodeRow[]>
  /**
   * #1027 D6: the workflow whose attempt ledger owns this child session.
   * Optional for lightweight store doubles. The summary publisher uses it to
   * attribute a child's step-finish usage to its parent session after a
   * restart, when no NodeStarted was observed by this process.
   */
  readonly getWorkflowByChildSession?: (
    childSessionID: string,
  ) => Effect.Effect<
    { workflowId: string; sessionId: string; projectId: string; directory: string } | undefined
  >
  /** Latest explicit parent control that can dispose of a checkpoint veto. */
  readonly getLatestCheckpointControlSeq: (workflowId: string) => Effect.Effect<number | undefined>
  /**
   * The reason carried by the latest durable WorkflowFailed event. Optional
   * for lightweight store doubles; `workflow status` includes it when
   * present, so a terminal failure explains itself without a new column.
   */
  readonly getWorkflowFailureReason?: (workflowId: string) => Effect.Effect<string | undefined>
  /**
   * #945: the latest durable WorkflowReplanned event that carried a target
   * change. Optional for lightweight store doubles; `workflow status` includes
   * it when present. The event seq is the audit reference.
   */
  readonly getLatestRetarget?: (workflowId: string) => Effect.Effect<RetargetRecord | undefined>

  readonly getNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  /** Latest node-row update time for one workflow (optional for lightweight test doubles). */
  readonly getLastNodeChange?: (workflowId: string) => Effect.Effect<number | undefined>
  /** Current row update time for one exact node (optional for lightweight test doubles). */
  readonly getNodeTime?: (workflowId: string, nodeId: string) => Effect.Effect<number | undefined>
  /**
   * Rev-view (v1.0.15 Train A): the CURRENT graph revision only — rows the
   * replan pushed out of the graph (superseded) are filtered out. This is the
   * read for VIEW and terminal-aggregation consumers: summaries, status/node
   * listings, the loop's rebuild/recovery/completion input, and wake failure
   * attribution. Durable truth is untouched — getNodes still returns every
   * row, and completed old-rev outputs stay resolvable for input mapping.
   */
  readonly getCurrentNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly getNode: (workflowId: string, nodeId: string) => Effect.Effect<NodeRow | undefined>
  readonly getRunningNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly setCapturedOutput: (childSessionID: string, payload: unknown, snapshotID?: string) => Effect.Effect<void>

  readonly markWakeBatchReported: (batch: WakeBatch) => Effect.Effect<void>
  readonly getWakeSnapshot: (sessionID: string) => Effect.Effect<WakeSnapshot>
  readonly getUnreportedWakeNodes: (sessionID: string) => Effect.Effect<NodeRow[]>
  readonly getUnreportedWakeWorkflows: (sessionID: string) => Effect.Effect<WorkflowRow[]>
  readonly getSessionsWithUnreportedWakes: () => Effect.Effect<string[]>
  /**
   * #1026: one read for the inbox tick's two durable ledgers. `wake` is what
   * `getSessionsWithUnreportedWakes` lists; `paused` is the sessions of paused
   * workflows whose reminder is due: `wake_reported = 0` and
   * `time_updated <= pausedDueCutoff`. The cutoff is inclusive, matching
   * `isPausedReminderDue`'s `now - timeUpdated >= delay`. The caller computes
   * it from its own `Clock` (`now - delay`) and it is bound as a parameter;
   * the SQL clock is never consulted, so a virtual clock decides what is due.
   * Only the session ID is read, never the workflow row or its YAML config.
   */
  readonly getSessionsWithDueWakes: (input: { readonly pausedDueCutoff: number }) => Effect.Effect<DueWakeSessions>
  readonly hasReportedWakeNodes: (sessionID: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/DagStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // One parent-session aggregation serves both the historical name and the
    // H3-facing listSummariesByParent query; keep their semantics identical.
    const summariesByParent = Effect.fn("DagStore.listSummariesByParent")(function* (sessionId: string) {
      const wfRows = yield* db
        .select()
        .from(WorkflowTable)
        .where(eq(WorkflowTable.session_id, sessionId))
        .orderBy(desc(WorkflowTable.time_created))
        .all()
        .pipe(Effect.orDie)
      if (wfRows.length === 0) return []
      // P1-4: aggregate in SQL — pulling every node row into JS made each
      // dag.* event burst scale with total node count across the session.
      // Rev-view (v1.0.15 Train A): superseded rows are filtered out so the
      // counts reflect ONLY the current graph revision — a replaced segment
      // neither counts toward nodeCount nor inflates failedNodes.
      const countRows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          status: WorkflowNodeTable.status,
          total: count(),
        })
        .from(WorkflowNodeTable)
        .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
        .where(and(eq(WorkflowTable.session_id, sessionId), eq(WorkflowNodeTable.superseded, false)))
        .groupBy(WorkflowNodeTable.workflow_id, WorkflowNodeTable.status)
        .all()
        .pipe(Effect.orDie)
      // F10: separate aggregation for running nodes with a not-yet-adjudicated
      // timeout escalation (the status grouping above cannot see the flag).
      // escalation_pending is set on escalate and cleared on adjudication, so
      // this counts only nodes genuinely awaiting main-agent action.
      const escalatedRows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          total: count(),
        })
        .from(WorkflowNodeTable)
        .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
        .where(and(
          eq(WorkflowTable.session_id, sessionId),
          eq(WorkflowNodeTable.status, "running"),
          eq(WorkflowNodeTable.escalation_pending, true),
          eq(WorkflowNodeTable.superseded, false),
        ))
        .groupBy(WorkflowNodeTable.workflow_id)
        .all()
        .pipe(Effect.orDie)
      const escalatedByWorkflow = new Map(escalatedRows.map((row) => [row.workflowId, row.total]))
      // #1027 D6: per-attempt usage comes from the durable ledger, not from
      // workflow_node.child_session_id (which only names the latest attempt).
      // LEFT JOIN keeps an attempt whose session row was already cleaned up;
      // its usage then contributes nothing instead of dropping the workflow.
      // One constant query, like the two aggregations above.
      const usageRows = yield* db
        .select({
          workflowId: DagNodeAttemptTable.workflow_id,
          tokens: sql<number>`coalesce(sum(${SessionTable.tokens_input} + ${SessionTable.tokens_cache_write} + ${SessionTable.tokens_output} + ${SessionTable.tokens_reasoning}), 0)`,
          tokensCacheRead: sql<number>`coalesce(sum(${SessionTable.tokens_cache_read}), 0)`,
        })
        .from(DagNodeAttemptTable)
        .innerJoin(WorkflowTable, eq(DagNodeAttemptTable.workflow_id, WorkflowTable.id))
        .leftJoin(SessionTable, eq(DagNodeAttemptTable.child_session_id, SessionTable.id))
        .where(eq(WorkflowTable.session_id, sessionId))
        .groupBy(DagNodeAttemptTable.workflow_id)
        .all()
        .pipe(Effect.orDie)
      const usageByWorkflow = new Map(usageRows.map((row) => [row.workflowId, row]))
      const counts = countRows.reduce((all, row) => {
        const current = all.get(row.workflowId) ?? { nodeCount: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0, skippedNodes: 0, abortedNodes: 0, queuedNodes: 0 }
        current.nodeCount += row.total
        if (row.status === "completed") current.completedNodes += row.total
        if (row.status === "running") current.runningNodes += row.total
        if (row.status === "failed") current.failedNodes += row.total
        if (row.status === "skipped") current.skippedNodes += row.total
        if (row.status === "aborted") current.abortedNodes += row.total
        if (row.status === "queued") current.queuedNodes += row.total
        all.set(row.workflowId, current)
        return all
      }, new Map<string, { nodeCount: number; completedNodes: number; runningNodes: number; failedNodes: number; skippedNodes: number; abortedNodes: number; queuedNodes: number }>())
      return wfRows.map((wf) => ({
        id: wf.id,
        title: wf.title,
        status: wf.status,
        graphRev: wf.graph_rev,
        ...(counts.get(wf.id) ?? { nodeCount: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0, skippedNodes: 0, abortedNodes: 0, queuedNodes: 0 }),
        escalatedNodes: escalatedByWorkflow.get(wf.id) ?? 0,
        tokens: usageByWorkflow.get(wf.id)?.tokens ?? 0,
        tokensCacheRead: usageByWorkflow.get(wf.id)?.tokensCacheRead ?? 0,
        // A checkpoint pause is recorded with its own durable reason, so a
        // plain manual pause is not reported as waiting for the main agent.
        checkpointPending: wf.status === "paused" && wf.pause_reason === "checkpoint",
      }))
    })

    return Service.of({
      getWorkflow: Effect.fn("DagStore.getWorkflow")(function* (id) {
        const row = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, id)).get().pipe(Effect.orDie)
        return row ? mapWorkflow(row) : undefined
      }),

      getWorkflowByChildSession: Effect.fn("DagStore.getWorkflowByChildSession")(function* (childSessionID) {
        // Index dag_node_attempt_child_session_idx backs this lookup. A child
        // session belongs to at most one row per attempt; order defensively by
        // the latest start in case a retry reused the same session.
        const row = yield* db
          .select({
            workflowId: DagNodeAttemptTable.workflow_id,
            sessionId: WorkflowTable.session_id,
            projectId: WorkflowTable.project_id,
            directory: WorkflowTable.directory,
          })
          .from(DagNodeAttemptTable)
          .innerJoin(WorkflowTable, eq(DagNodeAttemptTable.workflow_id, WorkflowTable.id))
          .where(eq(DagNodeAttemptTable.child_session_id, childSessionID))
          .orderBy(desc(DagNodeAttemptTable.started_at))
          .get()
          .pipe(Effect.orDie)
        return row
      }),

      getLatestCheckpointControlSeq: Effect.fn("DagStore.getLatestCheckpointControlSeq")(function* (workflowId) {
        const row = yield* db
          .select({ seq: EventTable.seq })
          .from(EventTable)
          .where(and(eq(EventTable.aggregate_id, workflowId), inArray(EventTable.type, checkpointControlTypes)))
          .orderBy(desc(EventTable.seq))
          .get()
          .pipe(Effect.orDie)
        return row?.seq
      }),

      getWorkflowFailureReason: Effect.fn("DagStore.getWorkflowFailureReason")(function* (workflowId) {
        const row = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(and(eq(EventTable.aggregate_id, workflowId), eq(EventTable.type, workflowFailedType)))
          .orderBy(desc(EventTable.seq))
          .get()
          .pipe(Effect.orDie)
        const reason = row?.data.reason
        return typeof reason === "string" ? reason : undefined
      }),

      getLatestRetarget: Effect.fn("DagStore.getLatestRetarget")(function* (workflowId) {
        const rows = yield* db
          .select({ seq: EventTable.seq, data: EventTable.data })
          .from(EventTable)
          .where(and(
            eq(EventTable.aggregate_id, workflowId),
            eq(EventTable.type, workflowReplannedType),
            sql`json_extract(${EventTable.data}, '$.retarget') IS NOT NULL`,
          ))
          .orderBy(desc(EventTable.seq))
          .limit(1)
          .all()
          .pipe(Effect.orDie)
        const row = rows[0]
        if (!row) return undefined
        const decoded = Schema.decodeUnknownOption(DagEvent.WorkflowReplanned.data)(row.data)
        if (Option.isNone(decoded) || !decoded.value.retarget) return undefined
        return { seq: row.seq, retarget: decoded.value.retarget }
      }),

      listWorkflows: Effect.fn("DagStore.listWorkflows")(function* () {
        const rows = yield* db.select().from(WorkflowTable).orderBy(desc(WorkflowTable.time_created)).all().pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listBySession: Effect.fn("DagStore.listBySession")(function* (sessionId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.session_id, sessionId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByProject: Effect.fn("DagStore.listByProject")(function* (projectId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.project_id, projectId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByStatus: Effect.fn("DagStore.listByStatus")(function* (status) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.status, status))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      getWorkflowSummaries: summariesByParent,
      listSummariesByParent: summariesByParent,

      // One grouped pass over the session's workflows and their current nodes.
      // Both seq and update time are folded in: every projection stamps the
      // event seq and the event time on the row it writes, so either moving
      // is enough to invalidate a derived value.
      getWorkflowRevisions: Effect.fn("DagStore.getWorkflowRevisions")(function* (sessionId) {
        const rows = yield* db
          .select({
            id: WorkflowTable.id,
            seq: WorkflowTable.seq,
            timeUpdated: WorkflowTable.time_updated,
            nodeSeq: max(WorkflowNodeTable.seq),
            nodeTimeUpdated: max(WorkflowNodeTable.time_updated),
          })
          .from(WorkflowTable)
          .leftJoin(
            WorkflowNodeTable,
            and(eq(WorkflowNodeTable.workflow_id, WorkflowTable.id), eq(WorkflowNodeTable.superseded, false)),
          )
          .where(eq(WorkflowTable.session_id, sessionId))
          .groupBy(WorkflowTable.id)
          .all()
          .pipe(Effect.orDie)
        return new Map(
          rows.map((row) => [row.id, `${row.seq}.${row.nodeSeq ?? 0}.${row.timeUpdated}.${row.nodeTimeUpdated ?? 0}`]),
        )
      }),

      // The CASE keeps the (possibly large) output column out of the result
      // for every node the caller did not name: the coverage prefilter is a
      // plain substring test, and `workflowCoverage` re-checks exactly.
      getSummaryNodes: Effect.fn("DagStore.getSummaryNodes")(function* (input) {
        if (input.workflowIds.length === 0) return []
        const named =
          input.outputs.size === 0
            ? sql`0`
            : inArray(sql`${WorkflowNodeTable.workflow_id} || char(31) || ${WorkflowNodeTable.id}`, [...input.outputs])
        const mentionsGap = sql`instr(${WorkflowNodeTable.output}, 'not_examined') > 0`
        const rows = yield* db
          .select({
            id: WorkflowNodeTable.id,
            workflowId: WorkflowNodeTable.workflow_id,
            status: WorkflowNodeTable.status,
            dependsOn: WorkflowNodeTable.depends_on,
            errorReason: WorkflowNodeTable.error_reason,
            errorClass: WorkflowNodeTable.error_class,
            safetyDenials: WorkflowNodeTable.safety_denials,
            staleTarget: WorkflowNodeTable.stale_target,
            output: sql<string | null>`CASE WHEN ${named} OR ${mentionsGap} THEN ${WorkflowNodeTable.output} END`,
          })
          .from(WorkflowNodeTable)
          .where(
            and(
              inArray(WorkflowNodeTable.workflow_id, [...input.workflowIds]),
              eq(WorkflowNodeTable.superseded, false),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        return rows.map((row): SummaryNodeRow => ({
          id: row.id,
          workflowId: row.workflowId,
          status: row.status,
          dependsOn: row.dependsOn,
          errorReason: row.errorReason,
          errorClass: row.errorClass,
          safetyDenials: row.safetyDenials,
          staleTarget: row.staleTarget,
          superseded: false,
          ...(row.output === null ? {} : { output: JSON.parse(row.output) as unknown }),
        }))
      }),

      getNodes: Effect.fn("DagStore.getNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(eq(WorkflowNodeTable.workflow_id, workflowId))
          .orderBy(desc(WorkflowNodeTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      getCurrentNodes: Effect.fn("DagStore.getCurrentNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.superseded, false)))
          .orderBy(desc(WorkflowNodeTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      getLastNodeChange: Effect.fn("DagStore.getLastNodeChange")(function* (workflowId) {
        const row = yield* db
          .select({ at: max(WorkflowNodeTable.time_updated) })
          .from(WorkflowNodeTable)
          .where(eq(WorkflowNodeTable.workflow_id, workflowId))
          .get()
          .pipe(Effect.orDie)
        return row?.at ?? undefined
      }),

      getNodeTime: Effect.fn("DagStore.getNodeTime")(function* (workflowId, nodeId) {
        const row = yield* db
          .select({ at: WorkflowNodeTable.time_updated })
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.id, nodeId)))
          .get()
          .pipe(Effect.orDie)
        return row?.at ?? undefined
      }),

      getNode: Effect.fn("DagStore.getNode")(function* (workflowId, nodeId) {
        const row = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.id, nodeId)))
          .get()
          .pipe(Effect.orDie)
        return row ? mapNode(row) : undefined
      }),

      getRunningNodes: Effect.fn("DagStore.getRunningNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.status, "running")))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      setCapturedOutput: Effect.fn("DagStore.setCapturedOutput")(function* (childSessionID, payload, snapshotID) {
        yield* db
          .update(WorkflowNodeTable)
          .set({ captured_output: payload, captured_output_present: true, captured_snapshot_id: snapshotID ?? null })
          .where(and(eq(WorkflowNodeTable.child_session_id, childSessionID), eq(WorkflowNodeTable.status, "running")))
          .run()
          .pipe(Effect.orDie)
      }),

      markWakeBatchReported: Effect.fn("DagStore.markWakeBatchReported")(function* (batch) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* Effect.forEach(
                batch.nodes,
                (node) =>
                  tx
                    .update(WorkflowNodeTable)
                    .set({ wake_reported: true })
                    .where(and(
                      eq(WorkflowNodeTable.workflow_id, node.workflowId),
                      eq(WorkflowNodeTable.id, node.id),
                      eq(WorkflowNodeTable.seq, node.seq),
                      eq(WorkflowNodeTable.wake_reported, false),
                    ))
                    .run(),
                { discard: true },
              )
              yield* Effect.forEach(
                batch.workflows,
                (workflow) =>
                  tx
                    .update(WorkflowTable)
                    .set({ wake_reported: true })
                    .where(and(
                      eq(WorkflowTable.id, workflow.id),
                      eq(WorkflowTable.seq, workflow.seq),
                      eq(WorkflowTable.wake_reported, false),
                    ))
                    .run(),
                { discard: true },
              )
            }),
          )
          .pipe(Effect.orDie)
      }),

      getWakeSnapshot: Effect.fn("DagStore.getWakeSnapshot")(function* (sessionID) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const nodes = yield* tx
                .select()
                .from(WorkflowNodeTable)
                .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
                .where(and(
                  eq(WorkflowTable.session_id, sessionID),
                  eq(WorkflowNodeTable.wake_reported, false),
                  // Escalated nodes enter the snapshot unconditionally
                  // (timeout_extensions > 0), covering the escalated-then-
                  // terminal outcome too — the cap's terminal verdict is its
                  // enforceable force. Adjudication consumes the wake
                  // (wake_reported=true), so adjudicated nodes are already
                  // filtered out above.
                  wakeDeliverableNodePredicate,
                ))
                .orderBy(
                  asc(WorkflowTable.seq),
                  asc(WorkflowTable.id),
                  asc(WorkflowNodeTable.seq),
                  asc(WorkflowNodeTable.id),
                )
                .all()
              const workflows = yield* tx
                .select()
                .from(WorkflowTable)
                .where(eq(WorkflowTable.session_id, sessionID))
                .orderBy(asc(WorkflowTable.seq), asc(WorkflowTable.id))
                .all()
              return {
                nodes: nodes.map((row) => mapNode(row.workflow_node)),
                workflows: workflows.map(mapWorkflow),
              }
            }),
          )
          .pipe(Effect.orDie)
      }),

      getUnreportedWakeNodes: Effect.fn("DagStore.getUnreportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_reported, false),
            // See wakeDeliverableNodePredicate — escalated nodes are wake-
            // eligible regardless of report_to_parent and status.
            wakeDeliverableNodePredicate,
          ))
          .orderBy(
            asc(WorkflowTable.seq),
            asc(WorkflowTable.id),
            asc(WorkflowNodeTable.seq),
            asc(WorkflowNodeTable.id),
          )
          .all()
          .pipe(Effect.orDie)
        return rows.map((r) => mapNode(r.workflow_node))
      }),

      getUnreportedWakeWorkflows: Effect.fn("DagStore.getUnreportedWakeWorkflows")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowTable.wake_reported, false),
          ))
          .orderBy(asc(WorkflowTable.seq), asc(WorkflowTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows
          .filter((r) => isTerminalWorkflowStatusValue(r.status))
          .map(mapWorkflow)
      }),

      getSessionsWithUnreportedWakes: Effect.fn("DagStore.getSessionsWithUnreportedWakes")(function* () {
        // One UNION instead of two sequential scans: the inbox tick budgets
        // its reads, and both ledgers only need the owning session ID.
        const rows = yield* db
          .select({ sessionId: WorkflowTable.session_id })
          .from(WorkflowTable)
          .where(unreportedWakeWorkflowPredicate)
          .union(
            db
              .select({ sessionId: WorkflowTable.session_id })
              .from(WorkflowNodeTable)
              .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
              // See wakeDeliverableNodePredicate — escalated nodes count as
              // unreported wakes so the bootstrap sweep finds a session whose
              // only outstanding item is an escalation.
              .where(unreportedWakeNodePredicate),
          )
          .all()
          .pipe(Effect.orDie)
        return [...new Set(rows.map((row) => row.sessionId))]
      }),

      getSessionsWithDueWakes: Effect.fn("DagStore.getSessionsWithDueWakes")(function* (input) {
        // The wake UNION plus a paused arm in the same statement: the inbox
        // tick budgets its reads (#1026), and every arm needs only the owning
        // session ID. The arm tag rides along as a literal column so the two
        // ledgers stay distinguishable after the UNION. `pausedDueCutoff` is a
        // bound parameter; no SQL time function decides what is due.
        const rows = yield* db
          .select({ sessionId: WorkflowTable.session_id, source: sql<DueWakeSource>`'wake'` })
          .from(WorkflowTable)
          .where(unreportedWakeWorkflowPredicate)
          .union(
            db
              .select({ sessionId: WorkflowTable.session_id, source: sql<DueWakeSource>`'wake'` })
              .from(WorkflowNodeTable)
              .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
              .where(unreportedWakeNodePredicate),
          )
          .union(
            db
              .select({ sessionId: WorkflowTable.session_id, source: sql<DueWakeSource>`'paused'` })
              .from(WorkflowTable)
              .where(and(
                eq(WorkflowTable.status, "paused"),
                eq(WorkflowTable.wake_reported, false),
                lte(WorkflowTable.time_updated, input.pausedDueCutoff),
              )),
          )
          .all()
          .pipe(Effect.orDie)
        // The UNION already made each (session, source) pair distinct; sort so
        // the order does not depend on how SQLite happens to emit the rows.
        const sessionsOf = (source: DueWakeSource) =>
          rows
            .filter((row) => row.source === source)
            .map((row) => row.sessionId)
            .sort(byCodeUnit)
        return { wake: sessionsOf("wake"), paused: sessionsOf("paused") }
      }),

      hasReportedWakeNodes: Effect.fn("DagStore.hasReportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select({ id: WorkflowNodeTable.id })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, true),
          ))
          .all()
          .pipe(Effect.orDie)
        return rows.length > 0
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])
