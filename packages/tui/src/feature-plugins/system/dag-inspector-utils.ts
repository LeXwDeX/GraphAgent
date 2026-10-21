// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure topology helpers for the DAG inspector. Extracted for unit testing,
 * mirroring the diff-viewer-file-tree-utils pattern in this directory. */

import type { DagNode, DagWorkflowSummary } from "@opencode-ai/sdk/v2"

export type { DagNode }

/** Acceptance and durable model-input association are separate delivery states. */
export function formatDagAgentMessages(node: DagNode): string | undefined {
  const messages = node.agent_messages
  if (!messages) return undefined
  return `messages ${messages.queued} queued · ${messages.delivered} delivered · ${messages.undeliverable} undeliverable`
}

export function formatDagAgentInput(node: DagNode): string | undefined {
  if (!node.attempt_id) return undefined
  return `attempt ${node.attempt_id} · input ${node.accepted_input_revision ?? 0} · snapshot ${node.snapshot_revision ?? 0}`
}

/**
 * Group nodes into topological "waves": wave N contains every node whose
 * dependencies are all satisfied by waves 0..N-1. A wave is a rendering
 * grouping (same topological depth), NOT an execution barrier.
 *
 * Nodes inside a wave are sorted by name for stable rendering. Nodes that are
 * part of a dependency cycle (or depend on a missing node) can never be
 * satisfied and are dropped — the loop stops at the first empty wave rather
 * than spinning forever.
 */
export function computeWaves(nodes: readonly DagNode[]): DagNode[][] {
  if (nodes.length === 0) return []
  const done = new Set<string>()
  const remaining = new Set(nodes.map((n) => n.id))
  const deps = new Map(nodes.map((n) => [n.id, n.depends_on]))
  const byID = new Map(nodes.map((n) => [n.id, n]))
  const result: DagNode[][] = []
  while (remaining.size > 0) {
    const wave: DagNode[] = []
    for (const id of remaining) {
      const d = deps.get(id) ?? []
      if (d.every((dep) => done.has(dep) || !byID.has(dep))) {
        const node = byID.get(id)
        if (node) wave.push(node)
      }
    }
    if (wave.length === 0) break
    wave.sort((a, b) => a.name.localeCompare(b.name))
    result.push(wave)
    for (const n of wave) {
      done.add(n.id)
      remaining.delete(n.id)
    }
  }
  return result
}

/**
 * Structural equality for polled node snapshots. The inspector re-fetches every
 * two seconds; an unchanged snapshot must keep the current array so the wave
 * list is not torn down and rebuilt.
 */
export function sameDagNodes(a: readonly DagNode[], b: readonly DagNode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((node, index) => node === b[index] || JSON.stringify(node) === JSON.stringify(b[index]))
}

/**
 * Visual row index of a node inside the rendered wave list, counting one row
 * per wave header, one row per node, and one blank spacer row between waves.
 * Used to scroll the selected node into view — valid only while every node
 * renders as a single row.
 */
export function computeNodeRowIndex(layers: readonly (readonly DagNode[])[], nodeID: string): number | undefined {
  let row = 0
  for (const [index, layer] of layers.entries()) {
    if (index > 0) row++ // spacer between waves
    row++ // wave header
    for (const node of layer) {
      if (node.id === nodeID) return row
      row++
    }
  }
  return undefined
}

export function formatDagError(error: string) {
  return error.replace(/^Cause\(\[Die\((.*)\)\]\)$/, "$1").replace(/^ProviderModelNotFoundError:\s*/, "")
}

/** Compact "3m 12s" duration between two epoch-millis timestamps. The SDK
 * serializes numbers with Infinity/NaN sentinels — non-finite inputs yield
 * no duration. */
export function formatDagDuration(
  startedAt: number | string | undefined,
  completedAt: number | string | undefined,
): string | undefined {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined
  const end = typeof completedAt === "number" && Number.isFinite(completedAt) ? completedAt : Date.now()
  const totalSeconds = Math.max(0, Math.round((end - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

/** Single-line preview of a node's output for the detail pane. */
export function formatDagOutputPreview(output: unknown, maxLength = 200): string | undefined {
  if (output === undefined || output === null) return undefined
  const text = typeof output === "string" ? output : JSON.stringify(output)
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat === "") return undefined
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

/** Countdown to a node's absolute deadline — "3m 12s left" while budget
 * remains, "overdue" past it. Only meaningful for nodes still executing
 * (running/queued); terminal nodes yield no label. Tolerates the SDK's
 * Infinity/NaN number sentinels. */
export function formatDagDeadline(
  status: string,
  deadlineMs: number | string | undefined,
  now = Date.now(),
): string | undefined {
  if (status !== "running" && status !== "queued") return undefined
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return undefined
  const remaining = deadlineMs - now
  if (remaining <= 0) return "overdue"
  const totalSeconds = Math.round(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s left`
  return `${minutes}m ${seconds}s left`
}

/** Replan history annotation — replan_attempts increments on replan restart,
 * so any positive count means this execution replaced a failed attempt.
 * Accepts the SDK's Infinity/NaN string sentinels (non-finite → no label). */
export function dagNodeHistoryLabel(node: { replan_attempts: number | string }): string | undefined {
  const attempts = Number(node.replan_attempts)
  if (!Number.isFinite(attempts) || attempts <= 0) return undefined
  return `restarted ×${attempts}`
}

/** Settled progress with a completed/skipped split (P1-E). A bare "8/8" reads
 * as "8 succeeded" even when 7 were skipped — condition gates, or a cancelled
 * workflow's never-run/aborted nodes (never-run nodes publish NodeSkipped;
 * running or paused nodes cancelled by terminateNonTerminalNodes publish
 * NodeAborted). The ✓ completed / ⊘ skipped split removes that false-success
 * signal. The split is omitted when nothing has settled so the narrow inspector
 * nav row keeps the workflow title (primary navigation) visible. Accepts the
 * SDK's Infinity/NaN string sentinels (coerced via Number). */
export function formatDagProgress(summary: {
  nodeCount: number | string
  completedNodes: number | string
  skippedNodes: number | string
  abortedNodes?: number | string
}): string {
  const total = Number(summary.nodeCount)
  const completed = Number(summary.completedNodes)
  const skipped = Number(summary.skippedNodes)
  const aborted = Number(summary.abortedNodes ?? 0)
  const settled = completed + skipped + aborted
  return settled > 0
    ? `${settled}/${total} ✓${completed} ⊘${skipped}${aborted > 0 ? ` ↯${aborted}` : ""}`
    : `${settled}/${total}`
}

/** F10: timeout-pending indicator — running nodes past their deadline awaiting
 * main-agent adjudication, shown distinctly from normal RUNNING. */
export function dagEscalationLabel(summary: { escalatedNodes?: number | string }): string | undefined {
  const escalated = Number(summary.escalatedNodes ?? 0)
  if (!Number.isFinite(escalated) || escalated <= 0) return undefined
  return `timeout ×${escalated}`
}

/**
 * Shared status→color mapping for every DAG surface (sidebar indicator,
 * sidebar panel, inspector) so one status never renders in different colors
 * across views. Accepts both workflow and node statuses. Generic over the
 * theme's color type (RGBA at runtime).
 */
export function dagStatusColor<Color>(
  theme: { success: Color; error: Color; warning: Color; text: Color; textMuted: Color },
  status: string,
): Color {
  if (status === "completed") return theme.success
  if (status === "failed") return theme.error
  if (status === "paused" || status === "stepping") return theme.warning
  if (status === "running") return theme.textMuted
  if (status === "pending" || status === "queued") return theme.textMuted
  if (status === "skipped" || status === "cancelled" || status === "aborted") return theme.textMuted
  return theme.text
}

/** Status glyph for node rows — mirrors the todo-item ✓ vocabulary. */
export function dagNodeGlyph(status: string): string {
  if (status === "completed") return "✓"
  if (status === "failed") return "✗"
  if (status === "aborted") return "↯"
  if (status === "skipped" || status === "cancelled") return "⊘"
  if (status === "queued") return "◌"
  return "○"
}

export type DagControlOperation = "pause" | "resume" | "cancel" | "step"

/** Whether a control operation applies to the workflow's current status.
 * Shared by keybinding feedback and the footer's contextual hints so the
 * hint bar never advertises an operation that would only produce a toast. */
export function dagControlAllowed(status: string | undefined, operation: DagControlOperation): boolean {
  if (operation === "pause" || operation === "step") return status === "running" || status === "stepping"
  if (operation === "resume") return status === "paused" || status === "stepping"
  return status === "running" || status === "stepping" || status === "paused"
}

export function dagControlUnavailableMessage(status: string | undefined, operation: DagControlOperation) {
  if (dagControlAllowed(status, operation)) return undefined
  const action =
    operation === "pause"
      ? "paused"
      : operation === "resume"
        ? "resumed"
        : operation === "step"
          ? "stepped"
          : "cancelled"
  return `Workflow is ${status ?? "unavailable"} and cannot be ${action}`
}

export function dagControlProgressMessage(operation: DagControlOperation) {
  if (operation === "pause") return "Pausing workflow..."
  if (operation === "resume") return "Resuming workflow..."
  if (operation === "step") return "Stepping workflow..."
  return "Cancelling workflow..."
}

/**
 * Unique owning sessions of a project-level workflow list, preserving the
 * list's order. The summary endpoint is session-scoped, so discovery groups
 * the flat `GET /dag` rows by `session_id` before fetching summaries.
 */
export function dagWorkflowSessions(workflows: ReadonlyArray<{ session_id: string }>): string[] {
  const seen = new Set<string>()
  const sessions: string[] = []
  for (const workflow of workflows) {
    if (seen.has(workflow.session_id)) continue
    seen.add(workflow.session_id)
    sessions.push(workflow.session_id)
  }
  return sessions
}

/**
 * Merge per-session summary lists into one row set ordered by the project
 * list, dropping summaries for workflows the list no longer reports. Rows
 * keep the list's identity as the source of truth — a session-scoped summary
 * can legitimately lag a concurrent cancel.
 */
export function mergeDagWorkflowSummaries(
  list: ReadonlyArray<{ id: string }>,
  summaries: ReadonlyArray<ReadonlyArray<DagWorkflowSummary>>,
): DagWorkflowSummary[] {
  const byID = new Map<string, DagWorkflowSummary>()
  for (const rows of summaries) {
    for (const row of rows) byID.set(row.id, row)
  }
  const merged: DagWorkflowSummary[] = []
  for (const workflow of list) {
    const row = byID.get(workflow.id)
    if (row) merged.push(row)
  }
  return merged
}
