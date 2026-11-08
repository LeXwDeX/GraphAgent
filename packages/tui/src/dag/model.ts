// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure DAG presentation helpers shared by every DAG surface. No rendering,
 * state, or SDK access lives here; UI code maps the returned tokens and
 * strings to theme colors and components. */

import type { DagNode } from "@graphagent/sdk/v2"

export type { DagNode }

/** Theme token a DAG status maps to. The theme owns the concrete color. */
export type DagStatusToken =
  | "success"
  | "error"
  | "statusPaused"
  | "statusRunning"
  | "statusQueued"
  | "textMuted"
  | "text"

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

/** Single-line preview of a node's output for a detail pane. */
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
 * workflow's never-run nodes (never-run nodes publish NodeSkipped; running or
 * queued nodes cancelled by terminateNonTerminalNodes publish NodeAborted).
 * The ✓ completed / ⊘ skipped split removes that false-success signal, and
 * D11 keeps aborted (terminal but not settled) out of the numerator so a
 * cancelled workflow never reads as finished. The split is omitted when
 * nothing has settled so a narrow nav row keeps the workflow title (primary
 * navigation) visible. Accepts the SDK's Infinity/NaN string sentinels
 * (coerced via Number). */
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
  const settled = completed + skipped
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
 * Shared status→theme-token mapping for every DAG surface, so one status never
 * renders in different colors across views. Accepts both workflow and node
 * statuses. Callers resolve the token against the active theme.
 */
export function dagStatusColor(status: string): DagStatusToken {
  if (status === "completed") return "success"
  if (status === "failed") return "error"
  if (status === "paused" || status === "stepping") return "statusPaused"
  if (status === "running") return "statusRunning"
  if (status === "pending" || status === "queued") return "statusQueued"
  if (status === "skipped" || status === "cancelled" || status === "aborted") return "textMuted"
  return "text"
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
