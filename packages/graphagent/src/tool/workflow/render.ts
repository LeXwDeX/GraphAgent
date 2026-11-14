// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import type { NodeRow, RetargetRecord, WorkflowRow } from "@graphagent/core/dag/store"
import { displayState } from "@graphagent/core/dag/core/types"
import type { DagEvent } from "@graphagent/schema/dag-event"
import { Dag } from "@/dag/dag"
import { DagIsolation } from "@/dag/isolation"
import { DagLocation } from "@/dag/location"
import { DagReviewLifecycle } from "@/dag/review-lifecycle"
import { DagValidation } from "@/dag/validation"
import { isManagedOutputFileRef, isOutputFileRef } from "@/dag/runtime/output-ref"
import type { Tool } from "../tool"
import {
  DEFAULT_RESULT_PAGE_CHARS,
  ResultCursor,
  decodeResultCursor,
  encodeResultCursor,
  type Metadata,
  type ResultCursorToken,
} from "./schema"

/** #944: the target identity a result is bound to, shared by both result
 * branches. Absent for nodes without a recorded target fingerprint and
 * non-target-sensitive results. */
export function resultTargetFields(node: {
  readonly targetFingerprint?: DagEvent.TargetFingerprint | null
  readonly staleTarget?: boolean | null
}) {
  return {
    ...(node.targetFingerprint ? { target_fingerprint: node.targetFingerprint } : {}),
    ...(node.staleTarget ? { stale_target: true } : {}),
  }
}

/** #946: worktree evidence a node result carries back to the orchestrator.
 * Non-isolated nodes expose only the touched paths. */
export function worktreeResultFields(node: {
  readonly worktreeDirectory?: string | null
  readonly worktreeBranch?: string | null
  readonly worktreeCommit?: string | null
  readonly worktreePatchPath?: string | null
  readonly worktreePatchSha256?: string | null
  readonly worktreeState?: string | null
  readonly worktreeConflictsWith?: string[] | null
  readonly touchedPaths?: string[] | null
}) {
  if (node.worktreeDirectory)
    return {
      worktree: {
        directory: node.worktreeDirectory,
        ...(node.worktreeBranch ? { branch: node.worktreeBranch } : {}),
        ...(node.worktreeCommit ? { commit: node.worktreeCommit } : {}),
        ...(node.worktreePatchPath ? { patch_path: node.worktreePatchPath } : {}),
        ...(node.worktreePatchSha256 ? { patch_sha256: node.worktreePatchSha256 } : {}),
        ...(node.worktreeState ? { state: node.worktreeState } : {}),
        ...(node.touchedPaths?.length ? { touched_paths: node.touchedPaths } : {}),
        ...(node.worktreeConflictsWith?.length ? { conflicts_with: node.worktreeConflictsWith } : {}),
      },
    }
  return node.touchedPaths?.length ? { touched_paths: node.touchedPaths } : {}
}

function resultPageEnd(content: string, offset: number, limit: number) {
  const end = Math.min(content.length, offset + limit)
  if (end >= content.length) return end
  const splitsSurrogatePair =
    content.charCodeAt(end - 1) >= 0xd800 &&
    content.charCodeAt(end - 1) <= 0xdbff &&
    content.charCodeAt(end) >= 0xdc00 &&
    content.charCodeAt(end) <= 0xdfff
  if (!splitsSurrogatePair) return end
  return end - offset === 1 ? end + 1 : end - 1
}

/** A call shaped `{ action, ... }` without the `{ params }` wrapper is the
 * same request. Wrap it before the action schema runs; the schema itself keeps
 * its object-rooted `params` contract for providers. Anything else is left
 * unchanged so strict decoding still rejects it. */
export function repairFlatWorkflowCall(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  if (Object.hasOwn(value, "params")) return value
  if (!Object.hasOwn(value, "action")) return value
  return { params: value }
}

export function validationOutput(result: DagValidation.ValidationResult) {
  return {
    source: result.source,
    profile: result.profile,
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    nodes: result.nodes,
    ...(!result.valid ? { recovery: WORKFLOW_RECOVERY } : {}),
  }
}

export const WORKFLOW_RECOVERY = {
  max_attempts: 2,
  instruction:
    "Diagnose the reported cause and attempt only authorized, reversible recovery. Each retry requires a relevant change; never retry unchanged input or bypass validation, permissions, or model constraints. A rejected replan/extend does not itself fail or cancel the workflow; inspect the reported actual state. If it was durably parked paused, a corrected mutation can resume it. If pause failed and it remains running, explicitly pause or settle it before ending the turn to avoid orchestrator_unresponsive. If it is terminal, use the applicable terminal recovery path. If no safe recovery exists or two attempts fail, stop and tell the user the cause, recovery attempted, actual workflow state, and available choices, then wait for their decision. Never cancel the whole graph just to avoid an unresponsive verdict, and never claim the workflow ran without evidence.",
}

// P0-A parent-facing copy for each extend_timeout verdict. Static data (not
// per-verdict branches) so the dispatch stays a single covered path.
export const EXTEND_TIMEOUT_COPY: Record<Dag.ExtendTimeoutVerdict["status"], { title: string; body: string }> = {
  extended: {
    title: "Node deadline extended",
    body: "The node keeps running under its existing child session and attempt; the deadline watcher picks up the new deadline on its next read. The cumulative timeout-extension count and replan attempts are unchanged, and no graph was rewritten.",
  },
  no_escalation: {
    title: "No timeout escalation awaiting adjudication",
    body: "A passed deadline alone does not authorize an extension. Wait for the formal timeout escalation to be delivered; to change the budget before escalation, replan with a new worker_config.timeout_ms.",
  },
  escalation_undelivered: {
    title: "Escalation not yet delivered",
    body: "The node's timeout escalation has not been delivered to you yet; adjudication must follow delivery. The node is still running and will re-escalate — retry the extension once you receive the timeout wake.",
  },
  cap_exhausted: {
    title: "Timeout extension cap exhausted",
    body: "The workflow's cumulative timeout-escalation cap has been reached. No new deadline was written; the watcher remains responsible for the running node's timeout verdict. Inspect workflow status before choosing a different recovery action.",
  },
  not_running: {
    title: "Node not running",
    body: "Only a RUNNING node can be extended; this node is pending, queued, missing, or already terminal. Check workflow status before extending.",
  },
}

export function blockedMetadata(diagnostics: readonly { code: string; message: string }[]): Metadata {
  return {
    blocked: true,
    diagnosticSummary: diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; "),
  }
}

export function authoringWarnings(result: DagValidation.ValidationResult) {
  return result.warnings.map((warning) => `Warning [${warning.code}] ${warning.path}: ${warning.message}\n`).join("")
}

// ============================================================================
// Result rendering
// ============================================================================

export function renderStatus(input: {
  workflow: WorkflowRow
  nodes: readonly NodeRow[]
  allNodes: readonly NodeRow[]
  failureReason?: string
  latestRetarget?: RetargetRecord
}): Tool.ExecuteResult {
  const { workflow, nodes, allNodes, failureReason, latestRetarget } = input
  const config = Dag.parseWorkflowConfig(workflow.config)
  // A completed graph can still carry an unresolved review verdict
  // (REJECT checkpoint, issue #294); surface it explicitly instead
  // of burying it in a terminal reason string.
  const unresolvedReviews = config ? DagReviewLifecycle.unresolvedReviewOutcomes(config, nodes) : []
  // #946: workflow-level isolation view. Kept worktrees stay
  // visible until an operator removes them; conflicts are a
  // report, never an automatic merge. Superseded attempts come
  // from the node's archived history so a replacement NodeStarted
  // cannot hide a worktree that is still on disk.
  const worktrees = allNodes.flatMap((node) => [
    ...(node.worktreeDirectory
      ? [
          {
            node_id: node.id,
            directory: node.worktreeDirectory,
            ...(node.worktreeBranch ? { branch: node.worktreeBranch } : {}),
            ...(node.worktreeCommit ? { commit: node.worktreeCommit } : {}),
            ...(node.worktreePatchPath ? { patch_path: node.worktreePatchPath } : {}),
            ...(node.worktreePatchSha256 ? { patch_sha256: node.worktreePatchSha256 } : {}),
            ...(node.worktreeState ? { state: node.worktreeState } : {}),
          },
        ]
      : []),
    ...(node.worktreeHistory ?? []).map((worktree) => ({
      node_id: node.id,
      directory: worktree.directory,
      ...(worktree.branch ? { branch: worktree.branch } : {}),
      ...(worktree.commit ? { commit: worktree.commit } : {}),
      ...(worktree.patchPath ? { patch_path: worktree.patchPath } : {}),
      ...(worktree.patchSha256 ? { patch_sha256: worktree.patchSha256 } : {}),
      ...(worktree.state ? { state: worktree.state } : {}),
      retired: true,
    })),
  ])
  const conflicts = DagIsolation.conflictGroups(
    nodes.map((node) => ({
      id: node.id,
      touchedPaths: node.touchedPaths ?? [],
      conflictsWith: node.worktreeConflictsWith ?? [],
    })),
  )
  const parallelOverlaps = DagIsolation.parallelOverlaps(
    nodes.map((node) => ({
      id: node.id,
      touchedPaths: node.touchedPaths ?? [],
      dependsOn: node.dependsOn,
      isolated: node.worktreeState != null,
    })),
  )
  // #1030 D9-g: the workflow-level worktree. Before settlement the durable
  // config carries the live pointer; after settlement the read-model row
  // carries the final commit/patch evidence.
  const workflowWorktree = workflow.worktree
    ? {
        directory: workflow.worktree.directory,
        ...(workflow.worktree.branch ? { branch: workflow.worktree.branch } : {}),
        ...(workflow.worktree.baseHead ? { base: workflow.worktree.baseHead } : {}),
        ...(workflow.worktree.head ? { head: workflow.worktree.head } : {}),
        ...(workflow.worktree.patchPath ? { patch: workflow.worktree.patchPath } : {}),
        ...(workflow.worktree.patchSha256 ? { patch_sha256: workflow.worktree.patchSha256 } : {}),
        ...(workflow.worktree.touchedPaths.length > 0 ? { touched_paths: workflow.worktree.touchedPaths } : {}),
        state: workflow.worktree.state,
        ...(workflow.worktree.reason ? { reason: workflow.worktree.reason } : {}),
      }
    : config?.worktree
      ? {
          directory: config.worktree.directory,
          ...(config.worktree.branch ? { branch: config.worktree.branch } : {}),
          ...(config.worktree.baseHead ? { base: config.worktree.baseHead } : {}),
          state: "active" as const,
        }
      : undefined
  return {
    title: `Workflow status: ${workflow.title}`,
    output: JSON.stringify(
      {
        id: workflow.id,
        title: workflow.title,
        status: workflow.status,
        // D12: the durable reason a paused workflow stays paused.
        ...(workflow.pauseReason ? { pause_reason: workflow.pauseReason } : {}),
        ...(failureReason ? { failure_reason: failureReason } : {}),
        ...(workflow.targetFingerprint ? { target_fingerprint: workflow.targetFingerprint } : {}),
        ...(config?.isolation ? { isolation: config.isolation } : {}),
        ...(workflowWorktree ? { worktree: workflowWorktree } : {}),
        ...(latestRetarget ? { latest_retarget: { seq: latestRetarget.seq, ...latestRetarget.retarget } } : {}),
        graph_rev: workflow.graphRev,
        session_id: workflow.sessionId,
        mode: config?.mode ?? "standard",
        ...(unresolvedReviews.length > 0 ? { unresolved_reviews: unresolvedReviews } : {}),
        ...(worktrees.length > 0 ? { worktrees } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(parallelOverlaps.length > 0 ? { parallel_overlaps: parallelOverlaps } : {}),
        ...(config?.admission
          ? {
              admission: {
                verdict: config.admission.verdict,
                state: config.admission.state,
                qa_mode: config.admission.qa_mode,
                brief_revision: config.admission.brief_revision,
                fingerprint: config.admission.fingerprint,
                ...(config.admission.waiver_reason ? { waiver_reason: config.admission.waiver_reason } : {}),
                ...(config.admission.acknowledged_risks
                  ? { acknowledged_risks: config.admission.acknowledged_risks }
                  : {}),
              },
            }
          : {}),
        nodes: nodes.map((node) => ({
          id: node.id,
          name: node.name,
          status: node.status,
          // D11: structured display state; raw status/error_class
          // stay so existing consumers and audit keep working.
          display_state: displayState(node),
          required: node.required,
          depends_on: node.dependsOn,
          ...(node.childSessionId ? { child_session_id: node.childSessionId } : {}),
          ...DagLocation.nodeLocationView(node),
          ...(node.errorReason ? { error_reason: node.errorReason } : {}),
          ...(node.errorClass ? { error_class: node.errorClass } : {}),
          ...(config?.nodes.find((definition) => definition.id === node.id)?.recovery
            ? { recovery: config.nodes.find((definition) => definition.id === node.id)!.recovery }
            : {}),
        })),
      },
      null,
      2,
    ),
    metadata: { workflowId: workflow.id } as Metadata,
  }
}

/** Render a node result: file-backed outputs stay durable pointers; inline
 * outputs page through a bounded, cursor-checked window. */
export const renderResult = (
  workflowID: Dag.ID,
  nodeID: Dag.NodeID,
  node: NodeRow,
  cursorToken: ResultCursorToken | undefined,
  limit: number | undefined,
): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    // Train B (v1.0.15 B3): a submit-time file ref reads as a durable
    // pointer — content_ref + summary + path — and the parent agent
    // fetches the content itself (read tool). No paging: the pointer
    // is bounded by construction and next_cursor is never issued, so
    // inline outputs below keep the paged read unchanged.
    if (isOutputFileRef(node.capturedOutput)) {
      return {
        title: `Workflow result: ${node.name}`,
        output: JSON.stringify(
          {
            workflow_id: workflowID,
            node_id: nodeID,
            status: node.status,
            ...resultTargetFields(node),
            ...worktreeResultFields(node),
            ...(node.completedAt ? { completed_at: new Date(node.completedAt).toISOString() } : {}),
            content_ref: node.capturedOutput.content_ref,
            path: node.capturedOutput.path,
            summary: node.capturedOutput.summary,
            size: node.capturedOutput.size,
            sha256: node.capturedOutput.sha256,
            ...(isManagedOutputFileRef(node.capturedOutput)
              ? {
                  storage: node.capturedOutput.storage,
                  source_path: node.capturedOutput.source_path,
                  provenance: node.capturedOutput.provenance,
                  artifact_status: node.status === "completed" ? "committed" : "checkpoint",
                }
              : {}),
            truncated: false,
            next_cursor: null,
          },
          null,
          2,
        ),
        metadata: {
          workflowId: workflowID,
          nodeId: nodeID,
          truncated: false,
        } as Metadata,
      }
    }
    const cursor = cursorToken
      ? decodeResultCursor(Buffer.from(cursorToken, "base64url").toString())
      : Option.some(
          new ResultCursor({
            version: 1 as const,
            workflow_id: workflowID,
            node_id: nodeID,
            offset: 0,
          }),
        )
    if (Option.isNone(cursor) || cursor.value.workflow_id !== workflowID || cursor.value.node_id !== nodeID) {
      return yield* Effect.die(new Error("Invalid or mismatched workflow result cursor"))
    }
    const durableResult = node.output ?? node.errorReason
    const content =
      typeof durableResult === "string"
        ? durableResult
        : durableResult == null
          ? ""
          : JSON.stringify(durableResult, null, 2)
    if (cursor.value.offset > content.length) {
      return yield* Effect.die(new Error("Workflow result cursor is beyond the current output"))
    }
    const pageEnd = resultPageEnd(content, cursor.value.offset, limit ?? DEFAULT_RESULT_PAGE_CHARS)
    const truncated = pageEnd < content.length
    const nextCursor = truncated
      ? encodeResultCursor(
          new ResultCursor({
            version: 1,
            workflow_id: workflowID,
            node_id: nodeID,
            offset: pageEnd,
          }),
        )
      : null
    return {
      title: `Workflow result: ${node.name}`,
      output: JSON.stringify(
        {
          workflow_id: workflowID,
          node_id: nodeID,
          status: node.status,
          ...resultTargetFields(node),
          ...worktreeResultFields(node),
          ...(node.completedAt ? { completed_at: new Date(node.completedAt).toISOString() } : {}),
          content: content.slice(cursor.value.offset, pageEnd),
          truncated,
          next_cursor: nextCursor,
        },
        null,
        2,
      ),
      metadata: {
        workflowId: workflowID,
        nodeId: nodeID,
        truncated,
        ...(nextCursor ? { nextCursor } : {}),
      } as Metadata,
    }
  })
