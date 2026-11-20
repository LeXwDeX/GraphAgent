// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import type { NodeRow } from "@graphagent/core/dag/store"
import type { DagEvent } from "@graphagent/schema/dag-event"
import type { Dag } from "@/dag/dag"
import { DagCoverage, resultPage, withResultPageCoverage } from "@/dag/coverage"
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

/** Render a node result: file-backed outputs stay durable pointers; inline
 * outputs page through a bounded, cursor-checked window. */
export const renderResult = (
  workflowID: Dag.ID,
  nodeID: Dag.NodeID,
  node: NodeRow,
  cursorToken: ResultCursorToken | undefined,
  limit: number | undefined,
  coverage: readonly DagCoverage.CoverageEntry[] = [],
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
            ...(coverage.length > 0 ? { coverage } : {}),
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
    const pageLimit = limit ?? DEFAULT_RESULT_PAGE_CHARS
    const pageEnd = resultPageEnd(content, cursor.value.offset, pageLimit)
    const truncated = pageEnd < content.length
    const resultCoverage = withResultPageCoverage(coverage, {
      nodeID,
      page: resultPage(content.length, pageEnd, pageLimit),
      truncated,
    })
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
          ...(resultCoverage.length > 0 ? { coverage: resultCoverage } : {}),
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
