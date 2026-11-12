// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG status vocabulary (D11) — the single source of truth for the persisted
 * status literals plus the derived terminal/settled/display predicates.
 *
 * Pure: zero imports. The schema events build their `Schema.Literals` from
 * these arrays, and the Effect-free core state machine
 * (`packages/core/src/dag/core/types.ts`) derives its enums and terminal
 * tables from them. Importing `dag-event.ts` here would pull Effect into the
 * core's zero-Effect module, so this file must stay dependency-free.
 */

/** Iron-law statuses a workflow row may hold. `archived` was removed in D11:
 * no durable event ever produced it (create always writes `pending`). */
export const WORKFLOW_STATUS_VALUES = [
  "pending",
  "running",
  "paused",
  "stepping",
  "completed",
  "failed",
  "cancelled",
] as const

export type WorkflowStatus = (typeof WORKFLOW_STATUS_VALUES)[number]

/** Iron-law statuses a node row may hold. Node-level `paused` was removed in
 * D11: no NodePaused durable event exists and the restart path projects
 * through NodeRestarted straight to `pending`. */
export const NODE_STATUS_VALUES = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "skipped",
] as const

export type NodeStatus = (typeof NODE_STATUS_VALUES)[number]

export const WORKFLOW_TERMINAL_STATUS_VALUES = ["completed", "failed", "cancelled"] as const
export const NODE_TERMINAL_STATUS_VALUES = ["completed", "failed", "aborted", "skipped"] as const

/** Union of every terminal value across both domains. Workflow and node
 * literal sets do not share a non-terminal value, so one set can answer for a
 * durable row whose status is an unvalidated string. */
const TERMINAL_STATUS_VALUES: ReadonlySet<string> = new Set([
  ...WORKFLOW_TERMINAL_STATUS_VALUES,
  ...NODE_TERMINAL_STATUS_VALUES,
])

/** Settled = the node reached an outcome that counts as done progress.
 * Aborted/failed nodes are terminal but not settled; TUI progress splits them
 * separately (D11 item 3). */
const SETTLED_STATUS_VALUES: ReadonlySet<string> = new Set(["completed", "skipped"])

/** True for any terminal workflow or node status. */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUS_VALUES.has(status)
}

/** True only for `completed` or `skipped` — the settled share of progress. */
export function isSettled(status: string): boolean {
  return SETTLED_STATUS_VALUES.has(status)
}

/** True while a status may still change (the complement of terminal). */
export function isActive(status: string): boolean {
  return !isTerminal(status)
}

/**
 * D12: why a workflow was paused. The write side is a closed union so a
 * publisher can only write reasons the runtime understands; the durable event
 * schema stays an open optional string so a newer reason never breaks an older
 * reader's decode.
 */
export const PAUSE_REASON_BUDGET_EXHAUSTED = "budget_exhausted"
/** #1027 D6: the workflow parked on a replan checkpoint until the main agent
 * acknowledges it; the summary reports this episode as checkpointPending. */
export const PAUSE_REASON_CHECKPOINT = "checkpoint"
export type PauseReason = typeof PAUSE_REASON_BUDGET_EXHAUSTED | typeof PAUSE_REASON_CHECKPOINT

/** Structured `error_class` values the runtime interprets. The durable
 * `NodeFailed.errorClass` field stays an optional plain string. */
export const ERROR_CLASS_CANCELLED = "cancelled"
export const ERROR_CLASS_BUDGET_EXHAUSTED = "budget_exhausted"

/** Status shown to humans/agents. Cancellation is expressed structurally as
 * `failed` + `error_class="cancelled"`; display state is the only place that
 * recognizes it, never an `error_reason` string match. */
export type DisplayState = WorkflowStatus | NodeStatus | "cancelled" | "escalated"

export function displayState(node: {
  readonly status: string
  readonly errorClass?: string | null
  readonly escalationPending?: boolean | null
}): DisplayState {
  if (node.status === "failed" && node.errorClass === ERROR_CLASS_CANCELLED) return "cancelled"
  if (node.status === "running" && node.escalationPending === true) return "escalated"
  return node.status as DisplayState
}
