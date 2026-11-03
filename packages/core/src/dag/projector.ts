// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagProjector from "./projector"

import { and, eq, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { LayerNode } from "../effect/layer-node"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { WorkflowNodeTable, WorkflowTable } from "./sql"

type WorkflowStatus = DagEvent.WorkflowStatus
const toMillis = (dt: DateTime.Utc) => DateTime.toEpochMillis(dt)

/** Keep workflow status values typed at the Drizzle boundary. */
const ws = (s: WorkflowStatus) => s

/**
 * Event → status projection guards — the single source the drift test checks
 * against the declared transition tables in core/types.ts. Every `from` entry
 * must be a legal predecessor of `to` (self-transitions are idempotent
 * re-application and exempt). Editing a guard here without updating the
 * declared table (or vice versa) fails the consistency test in
 * test/dag-projector-drift.test.ts instead of drifting silently.
 */
export const NodeStatusProjection = {
  queued: { to: "queued", from: ["pending", "queued"] },
  started: { to: "running", from: ["pending", "queued", "paused", "running"] },
  // Publisher-side guardNode admits NodeCompleted only from running; the
  // former pending/queued/paused tolerance had no producing path and
  // contradicted the declared table.
  completed: { to: "completed", from: ["running"] },
  failed: { to: "failed", from: ["running", "pending", "queued"] },
  skipped: { to: "skipped", from: ["pending", "queued", "running", "paused"] },
  aborted: { to: "aborted", from: ["running", "paused"] },
  // NodeCancelled has NO independent terminal status — the NodeStatus enum has
  // no CANCELLED and getValidNextNodeStatuses never returns it. A cancelled
  // node lands on `failed` with the cancellation carried by `error_reason`
  // ("cancelled via replan"), never on a phantom node-level "cancelled" status.
  // Workflow-level cancelled (WorkflowStatusProjection.cancelled below) is a
  // legitimate, separate terminal — this entry is node-scoped only.
  cancelled: { to: "failed", from: ["pending", "queued", "running", "paused"] },
  restarted: { to: "pending", from: ["running"] },
} as const

export const WorkflowStatusProjection = {
  started: { to: "running", from: ["pending"] },
  paused: { to: "paused", from: ["running", "stepping"] },
  resumed: { to: "running", from: ["paused", "stepping"] },
  stepped: { to: "stepping", from: ["running", "stepping"] },
  completed: { to: "completed", from: ["running", "stepping"] },
  failed: { to: "failed", from: ["running", "stepping"] },
  cancelled: { to: "cancelled", from: ["running", "paused", "stepping"] },
  /**
   * Additive-extend reopen: a naturally-completed workflow with a reporting leaf
   * checkpoint may be reopened by _extend (see dag.ts reopenCompleted).
   * The drift test exempts exactly this entry.
   */
  replanReopen: { to: "running", from: ["completed"] },
  /** Explicit fenced recovery creates new attempts; old node terminal states remain immutable. */
  recoveryReopen: { to: "running", from: ["failed", "cancelled"] },
} as const

/**
 * DAG projector: EventV2 → read-model tables (CQRS).
 *
 * Mirrors SessionProjector. One `Layer.effectDiscard` that yields many
 * `events.project(...)` calls. Each projector runs INSIDE the durable publish
 * transaction — keep them to DB writes only (no external I/O, no heavy logic).
 *
 * Many events mutate the SAME row (e.g. every workflow.* event updates
 * WorkflowTable[id]); this is the standard CQRS pattern, NOT one-table-per-event.
 */

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    // ---- Workflow lifecycle ----

    yield* events.project(DagEvent.WorkflowCreated, (event) =>
      db
        .insert(WorkflowTable)
        .values({
          id: event.data.dagID,
          project_id: event.data.projectID,
          session_id: event.data.sessionID,
          // DAG-LOC-01: the execution-location key, stamped at dag.create.
          // A legacy event without the field projects to NULL — a row that
          // matches no instance directory and is never adopted.
          directory: event.data.directory ?? null,
          // #943: NULL for legacy events and workflows without a workspace;
          // spawn then keeps executing in the owner directory.
          execution_directory: event.data.executionDirectory ?? null,
          // #944: NULL for legacy events; absent means no target identity.
          target_fingerprint: event.data.targetFingerprint ?? null,
          title: event.data.title,
          status: event.data.status,
          config: event.data.config,
          seq: event.durable!.seq,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    const setWorkflowStatus = (status: WorkflowStatus, from: WorkflowStatus[]) => (event: { data: { dagID: DagEvent.DagID; timestamp: DateTime.Utc }; durable?: { seq: number } }) =>
      db
        .update(WorkflowTable)
        .set({ status, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, from)))
        .run()
        .pipe(Effect.orDie)

    yield* events.project(DagEvent.WorkflowStarted, (event) =>
      db
        .update(WorkflowTable)
        .set({
          status: "running",
          seq: event.durable!.seq,
          started_at: toMillis(event.data.timestamp),
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, [...WorkflowStatusProjection.started.from])))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.WorkflowPaused, (event) =>
      db
        .update(WorkflowTable)
        .set({
          status: "paused",
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
          // One bounded reminder is available for each pause episode. Its
          // delivery is acknowledged through the existing wake batch marker.
          wake_reported: false,
        })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, [...WorkflowStatusProjection.paused.from])))
        .run()
        .pipe(Effect.orDie),
    )
    // Leaving a pause ends that pause episode. A reminder already delivered for
    // it (wake_reported=true) must not suppress the next report, so the
    // resumed run starts with a fresh, unreported wake marker.
    yield* events.project(DagEvent.WorkflowResumed, (event) =>
      db
        .update(WorkflowTable)
        .set({ status: "running", seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp), wake_reported: false })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, [...WorkflowStatusProjection.resumed.from])))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(DagEvent.WorkflowStepped, setWorkflowStatus(ws("stepping"), [...WorkflowStatusProjection.stepped.from]))

    const setWorkflowTerminal = (status: WorkflowStatus, from: WorkflowStatus[]) => (event: { data: { dagID: DagEvent.DagID; timestamp: DateTime.Utc }; durable?: { seq: number } }) =>
      db
        .update(WorkflowTable)
        .set({
          status,
          seq: event.durable!.seq,
          completed_at: toMillis(event.data.timestamp),
          time_updated: toMillis(event.data.timestamp),
          // A terminal transition opens its own wake episode (same re-arm as
          // node F2b): a paused reminder reported earlier must not swallow the
          // terminal report. The non-terminal `from` guard keeps replay of an
          // already-applied terminal event a 0-row update, so an acknowledged
          // terminal wake is never re-armed.
          wake_reported: false,
        })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, from)))
        .run()
        .pipe(Effect.orDie)

    yield* events.project(DagEvent.WorkflowCompleted, setWorkflowTerminal(ws("completed"), [...WorkflowStatusProjection.completed.from]))
    yield* events.project(DagEvent.WorkflowFailed, setWorkflowTerminal(ws("failed"), [...WorkflowStatusProjection.failed.from]))
    yield* events.project(DagEvent.WorkflowCancelled, setWorkflowTerminal(ws("cancelled"), [...WorkflowStatusProjection.cancelled.from]))

    yield* events.project(DagEvent.WorkflowReplanned, (event) =>
      Effect.gen(function* () {
        const recovery = event.data.recovery
        if (recovery) {
          const current = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, event.data.dagID)).get().pipe(Effect.orDie)
          if (
            !current || current.graph_rev !== recovery.expectedGraphRev || current.seq !== recovery.expectedSeq ||
            !["paused", "failed", ...(recovery.resumeCancelled ? ["cancelled"] : [])].includes(current.status)
          ) yield* Effect.die(new Error("Recovery rejected: workflow changed after the recovery snapshot"))
          const nodes = yield* db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.workflow_id, event.data.dagID)).all().pipe(Effect.orDie)
          const expected = new Map<string, number>(recovery.nodeSeqs.map((node) => [node.nodeID, node.seq]))
          if (nodes.length !== expected.size || nodes.some((node) => expected.get(node.id) !== node.seq)) {
            yield* Effect.die(new Error("Recovery rejected: node state changed after the recovery snapshot"))
          }
        }
        // Rev-view (v1.0.15 Train A): every replan opens a new graph
        // revision. The two legs run in THIS order so each event bumps
        // graph_rev exactly once: the seq-bump leg matches the active
        // statuses first (status unchanged), and the reopen leg then matches
        // completed rows still untouched by it — reversing the legs would let
        // the reopened (now running) row match the seq-bump leg too and
        // double-bump.
        yield* db
          .update(WorkflowTable)
          .set({
            ...(recovery ? { status: ws("running"), wake_reported: false, completed_at: null } : {}),
            // #945: a retarget also rebinds the execution directory and the
            // target identity in the same revision bump.
            ...(event.data.retarget?.toDirectory !== undefined
              ? { execution_directory: event.data.retarget.toDirectory }
              : {}),
            ...(event.data.retarget?.toFingerprint !== undefined
              ? { target_fingerprint: event.data.retarget.toFingerprint }
              : {}),
            graph_rev: sql`${WorkflowTable.graph_rev} + 1`,
            seq: event.durable!.seq,
            time_updated: toMillis(event.data.timestamp),
          })
          .where(and(
            eq(WorkflowTable.id, event.data.dagID),
            inArray(WorkflowTable.status, ["pending", "running", "paused", "stepping"]),
          ))
          .run()
          .pipe(Effect.orDie)
        // Atomic wake can reach the parent only after a leaf checkpoint has
        // completed the current graph. An additive extend emits this event to
        // reopen that completed workflow without changing completed nodes.
        yield* db
          .update(WorkflowTable)
          .set({
            status: "running",
            wake_reported: false,
            completed_at: null,
            graph_rev: sql`${WorkflowTable.graph_rev} + 1`,
            seq: event.durable!.seq,
            time_updated: toMillis(event.data.timestamp),
          })
          .where(and(
            eq(WorkflowTable.id, event.data.dagID),
            inArray(WorkflowTable.status, recovery
              ? [...WorkflowStatusProjection.recoveryReopen.from]
              : [...WorkflowStatusProjection.replanReopen.from]),
          ))
          .run()
          .pipe(Effect.orDie)
        // Rev-view: mark the nodes this replan pushed out of the current
        // revision — terminal rows the fragment bypassed (a failed node the
        // new path routes around). plan.cancel rows are marked via the
        // NodeCancelled projection instead. Idempotent fold: the marker is
        // monotonic, replaying the event never resurrects a marked row.
        const superseded = event.data.superseded
        if (superseded && superseded.length > 0) {
          yield* db
            .update(WorkflowNodeTable)
            .set({ superseded: true, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
            .where(and(
              eq(WorkflowNodeTable.workflow_id, event.data.dagID),
              inArray(WorkflowNodeTable.id, [...superseded]),
            ))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )

    yield* events.project(DagEvent.WorkflowConfigUpdated, (event) =>
      db
        .update(WorkflowTable)
        .set({ config: event.data.config, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(
          eq(WorkflowTable.id, event.data.dagID),
          inArray(WorkflowTable.status, ["pending", "running", "paused", "stepping", "completed"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    // ---- Node lifecycle (insert on register, update thereafter) ----

    yield* events.project(DagEvent.NodeRegistered, (event) =>
      db
        .insert(WorkflowNodeTable)
        .values({
          id: event.data.nodeID,
          workflow_id: event.data.dagID,
          name: event.data.name,
          worker_type: event.data.workerType,
          status: "pending",
          required: event.data.required,
          depends_on: [...event.data.dependsOn],
          model_id: event.data.model?.modelID,
          model_provider_id: event.data.model?.providerID,
          seq: event.durable!.seq,
        })
        .onConflictDoUpdate({
          target: [WorkflowNodeTable.workflow_id, WorkflowNodeTable.id],
          set: {
            name: event.data.name,
            worker_type: event.data.workerType,
            required: event.data.required,
            depends_on: [...event.data.dependsOn],
            model_id: event.data.model?.modelID,
            model_provider_id: event.data.model?.providerID,
            seq: event.durable!.seq,
          },
        })
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeQueued, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "queued",
          deadline_ms: event.data.deadlineMs ?? null,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Admission is only valid from pending (fresh dispatch) or queued
        // (idempotent re-admission after crash recovery, P0-2). A concurrent
        // replan(cancel) terminalizing the node makes this a 0-row update.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.queued.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeStarted, (event) => {
      // #949: snapshot the attempt's execution location without a bare
      // `directory:` key inside `.set(...)`: the DAG-LOC-01 write-once static
      // contract reserves that spelling for the workflow stamp.
      const executionLocation = {
        directory: event.data.worktree?.directory ?? event.data.directory ?? null,
        base_head: event.data.baseHead ?? null,
        // #944: a fresh attempt clears the previous completion verdict.
        target_fingerprint: event.data.targetFingerprint ?? null,
        stale_target: false,
        // #946: a started isolated attempt replaces any prior worktree row.
        worktree_directory: event.data.worktree?.directory ?? null,
        worktree_branch: event.data.worktree?.branch ?? null,
        worktree_commit: null,
        worktree_patch_path: null,
        worktree_patch_sha256: null,
        worktree_state: event.data.worktree ? "active" : null,
        worktree_conflicts_with: event.data.worktree ? [] : null,
        touched_paths: null,
      }
      return db
        .update(WorkflowNodeTable)
        .set({
          status: "running",
          child_session_id: event.data.childSessionID,
          ...executionLocation,
          captured_output: null,
          captured_output_present: false,
          captured_snapshot_id: null,
          started_at: toMillis(event.data.timestamp),
          deadline_ms: event.data.deadlineMs ?? null,
          wake_eligible: event.data.wakeEligible ?? false,
          wake_reported: false,
          // S3: a fresh execution attempt starts with a fresh extension budget —
          // restart clears timeout_extensions so the cap is per-attempt, not
          // lifetime (a restart must not inherit a nearly-exhausted cap). The
          // new attempt is also not awaiting adjudication.
          timeout_extensions: 0,
          escalation_pending: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only start nodes in a pre-/in-running status. Prevents a stale or
        // racing NodeStarted (e.g. a spawn fiber resuming after a concurrent
        // replan(cancel) terminalized the node to "failed") from resurrecting
        // an already-terminal node back to "running". The legitimate restart
        // path goes NodeRestarted (running→pending) → re-spawn → NodeStarted
        // on the "pending" row, so excluding terminal statuses is safe.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.started.from]),
        ))
        .run()
        .pipe(Effect.orDie)
    })

    yield* events.project(DagEvent.NodeCompleted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "completed",
          output: event.data.output,
          ...(event.data.capturedOutput !== undefined ? { captured_output: event.data.capturedOutput, captured_output_present: true } : {}),
          ...(event.data.targetFingerprint !== undefined ? { target_fingerprint: event.data.targetFingerprint } : {}),
          // #944: legacy events omit the flag; completed rows read as not stale.
          stale_target: event.data.staleTarget ?? false,
          ...(event.data.worktree !== undefined
            ? {
                worktree_directory: event.data.worktree.directory,
                worktree_branch: event.data.worktree.branch ?? null,
                worktree_commit: event.data.worktree.commit ?? null,
                worktree_patch_path: event.data.worktree.patchPath ?? null,
                worktree_patch_sha256: event.data.worktree.patchSha256 ?? null,
                worktree_state: event.data.worktree.state,
                worktree_conflicts_with: [...event.data.worktree.conflictsWith],
              }
            : {}),
          ...(event.data.touchedPaths !== undefined || event.data.worktree !== undefined
            ? { touched_paths: [...(event.data.touchedPaths ?? event.data.worktree?.touchedPaths ?? [])] }
            : {}),
          completed_at: toMillis(event.data.timestamp),
          // Q1: a terminal node is no longer awaiting adjudication — clear the
          // escalation flag. Its result is delivered via the wake_reported
          // re-arm below (orthogonal to the adjudication flag).
          escalation_pending: false,
          // F2b: re-arm wake delivery on every status migration. A node whose
          // escalated wake was already reported (wake_reported=true) must
          // re-enter the snapshot on completion/failure — otherwise its result
          // notification (and the crash-recovery failure at recovery.ts) is
          // lost behind the earlier escalation notification.
          wake_reported: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only complete nodes the publisher could legally complete: guardNode
        // admits NodeCompleted from running only, and a stale NodeCompleted
        // must not flip an already-terminal node (e.g. failed by a
        // replan-ceiling check) back to completed.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.completed.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeFailed, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "failed",
          error_reason: event.data.reason,
          error_class: event.data.errorClass ?? event.data.trigger,
          ...(event.data.worktree !== undefined
            ? {
                worktree_directory: event.data.worktree.directory,
                worktree_branch: event.data.worktree.branch ?? null,
                worktree_commit: event.data.worktree.commit ?? null,
                worktree_patch_path: event.data.worktree.patchPath ?? null,
                worktree_patch_sha256: event.data.worktree.patchSha256 ?? null,
                worktree_state: event.data.worktree.state,
                worktree_conflicts_with: [...event.data.worktree.conflictsWith],
                touched_paths: [...event.data.worktree.touchedPaths],
              }
            : {}),
          completed_at: toMillis(event.data.timestamp),
          // Q1: a terminal node is no longer awaiting adjudication — clear the
          // escalation flag.
          escalation_pending: false,
          // F2b: same re-arm as NodeCompleted — a failure after a reported
          // escalation (or a crash-recovery failure of an escalated node)
          // must still reach the main agent.
          wake_reported: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // P1-7: only fail nodes in non-terminal status. Prevents stale
        // replan-ceiling events from overwriting completed/skipped nodes.
        // "queued" is included for the queue-wait timeout path (P0-2).
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.failed.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeSkipped, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "skipped",
          error_reason: event.data.reason,
          // Q1: a skipped node is terminal — clear the adjudication flag.
          escalation_pending: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.skipped.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeAborted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "aborted",
          error_reason: event.data.reason,
          escalation_pending: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.aborted.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    // NodeCancelled carries no independent terminal status: it projects to
    // status="failed" with the cancellation marker in error_reason and clears
    // the adjudication flag (cancel is itself an adjudication). A node row can
    // therefore never hold status="cancelled"; see NodeStatusProjection.cancelled
    // above and the canonical proof in
    // packages/opencode/test/dag/dag-escalation-clear-flag.test.ts:130-148.
    //
    // Rev-view (v1.0.15 Train A): a cancelled node leaves the current graph
    // revision — the projection also sets the superseded marker so view and
    // aggregation reads (summaries, status, node lists, rebuild input, wake
    // attribution) show only the current rev. This covers both plan.cancel
    // rows and explicit dag.nodeCancelled publishes (U1: shared semantics).
    yield* events.project(DagEvent.NodeCancelled, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({ status: "failed", superseded: true, error_reason: "cancelled via replan", escalation_pending: false, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.cancelled.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeRestarted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "pending",
          // P1-3: do NOT clear child_session_id here — spawnReady reads it to
          // abort the old session before spawning the replacement. NodeStarted
          // will overwrite it with the new child session.
          replan_attempts: sql`${WorkflowNodeTable.replan_attempts} + 1`,
          // S3: restart opens a new attempt — reset the extension budget and
          // clear the pending-adjudication flag so the cap and the summary are
          // per-attempt, not lifetime.
          timeout_extensions: 0,
          escalation_pending: false,
          // #946: keep the previous worktree pointer until the replacement
          // attempt publishes NodeStarted (which overwrites or clears it).
          // A restarted node whose replacement never spawns must keep its
          // kept/active worktree visible; clearing here orphaned it silently.
          // (worktree_directory/branch/commit/patch/state/conflicts_with and
          // touched_paths are intentionally not reset.)
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only restart nodes still in "running" status — if the node completed
        // or failed between replan's snapshot read and this event publish, the
        // UPDATE matches 0 rows and the terminal status is preserved.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, [...NodeStatusProjection.restarted.from]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    // Timeout escalation: the node stays RUNNING (no status transition). Only
    // the extension count, seq, and wake flag change. wake_reported is reset so
    // the escalated node re-enters the wake snapshot and the main agent is
    // notified once per escalation.
    yield* events.project(DagEvent.NodeTimeoutEscalated, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          timeout_extensions: event.data.timeoutExtensions,
          // The escalation is not yet adjudicated — summary and the wake
          // delivery boundary treat the node as awaiting main-agent action
          // until an extend (NodeDeadlineExtended) or a new attempt clears it.
          escalation_pending: true,
          wake_reported: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // F2a: escalate only live running nodes — a stale escalate racing a
        // terminal event must not resurrect the wake flag or inflate the
        // counter on an already-completed/failed node (ghost wake).
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["running"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    // Deadline extension (ADR-0003): a pure idempotent fold. The command
    // (nodeExtendTimeout) runs the guard — status='running' + Q2 delivery gate
    // — in the command layer BEFORE publish, so this event is only appended on a
    // successful extension (event = success log). The projector does NOT judge
    // the guard, does NOT publish events, and ignores the row count — single
    // write authority, deterministic replay. The status='running' WHERE clause
    // is only a replay-safety guard: a stale extension racing a terminal event
    // (crash recovery) matches 0 rows and is a benign skip.
    yield* events.project(DagEvent.NodeDeadlineExtended, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          deadline_ms: event.data.deadlineMs,
          // ADR-0001: adjudication is complete — clear the pending flag.
          escalation_pending: false,
          // Consume the escalation wake so the moved deadline is not re-serviced
          // by a stale timeout wake. Harmless no-op once the Q2 gate is in
          // effect (delivery already happened before the re-time was admitted).
          wake_reported: true,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["running"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [EventV2.node, Database.node])
