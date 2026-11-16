// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Pure DAG presentation helpers shared by every DAG surface. No rendering,
 * state, or SDK access lives here; UI code maps the returned tokens and
 * strings to theme colors and components. */

import type { DagNode, DagWorkflowSummary } from "@graphagent/sdk"
import { computeWaves, type DagWaveNode } from "./waves"

export type { DagNode, DagWorkflowSummary }

/** Theme token a DAG status maps to. The theme owns the concrete color. */
export type DagStatusToken =
  "success" | "error" | "statusPaused" | "statusRunning" | "statusQueued" | "textMuted" | "text"

/**
 * A node as the TUI keeps it. The wire row (`DagNode`) also carries the node's
 * full `output` (large), its model, a last-activity stamp and the bounded
 * safety-denial audit. No DAG surface shows those, so a row drops them when it
 * enters the store. Numbers are finite: the SDK's "NaN"/"Infinity" string
 * sentinels are resolved once here instead of at every read.
 */
export interface DagNodeRow {
  readonly id: string
  readonly workflow_id: string
  readonly name: string
  readonly worker_type: string
  readonly status: string
  readonly required: boolean
  readonly depends_on: readonly string[]
  readonly child_session_id?: string
  /** Per-attempt execution location. */
  readonly directory?: string
  readonly head?: string
  readonly attempt_id?: string
  readonly accepted_input_revision?: number
  readonly snapshot_revision?: number
  readonly agent_messages?: {
    readonly queued: number
    readonly delivered: number
    readonly undeliverable: number
    readonly closed_reason?: string
  }
  readonly error_reason?: string
  /** Failure class; `failed` with class `cancelled` displays as cancelled. */
  readonly error_class?: string
  readonly deadline_ms?: number
  readonly replan_attempts: number
  readonly started_at?: number
  readonly completed_at?: number
}

/** A finite number from an SDK numeric field, or undefined for its non-finite string sentinels. */
export function dagFinite(value: number | string | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The stored form of a wire node: display fields only, no `output`, finite numbers, no shared references. */
export function dagNodeRow(node: DagNode): DagNodeRow {
  const deadline = dagFinite(node.deadline_ms)
  const startedAt = dagFinite(node.started_at)
  const completedAt = dagFinite(node.completed_at)
  return {
    id: node.id,
    workflow_id: node.workflow_id,
    name: node.name,
    worker_type: node.worker_type,
    status: node.status,
    required: node.required,
    depends_on: [...node.depends_on],
    ...(node.child_session_id !== undefined ? { child_session_id: node.child_session_id } : {}),
    ...(node.directory !== undefined ? { directory: node.directory } : {}),
    ...(node.head !== undefined ? { head: node.head } : {}),
    ...(node.attempt_id !== undefined ? { attempt_id: node.attempt_id } : {}),
    ...(node.accepted_input_revision !== undefined ? { accepted_input_revision: node.accepted_input_revision } : {}),
    ...(node.snapshot_revision !== undefined ? { snapshot_revision: node.snapshot_revision } : {}),
    ...(node.agent_messages !== undefined ? { agent_messages: { ...node.agent_messages } } : {}),
    ...(node.error_reason !== undefined ? { error_reason: node.error_reason } : {}),
    ...(node.error_class !== undefined ? { error_class: node.error_class } : {}),
    ...(deadline !== undefined ? { deadline_ms: deadline } : {}),
    replan_attempts: dagFinite(node.replan_attempts) ?? 0,
    ...(startedAt !== undefined ? { started_at: startedAt } : {}),
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
  }
}

/** Acceptance and durable model-input association are separate delivery states. */
export function formatDagAgentMessages(node: Pick<DagNodeRow, "agent_messages">): string | undefined {
  const messages = node.agent_messages
  if (!messages) return undefined
  return `messages ${messages.queued} queued · ${messages.delivered} delivered · ${messages.undeliverable} undeliverable`
}

export function formatDagAgentInput(
  node: Pick<DagNodeRow, "attempt_id" | "accepted_input_revision" | "snapshot_revision">,
): string | undefined {
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

/** What a node or workflow looks like on screen: the seven persisted node statuses, the structural `cancelled`, and the workflow-only `paused` and `stepping`. */
export type DagDisplayState =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "skipped"
  | "cancelled"
  | "paused"
  | "stepping"

/** Character of a progress-bar segment; every glyph is a box-drawing line. */
export type DagBarGlyph = "━" | "─" | "╌"

export interface DagStateStyle {
  /** Theme token the state is drawn in. */
  readonly token: DagStatusToken
  /** Bar segment character. Color is never the only cue: a thin line waits, dashes mean skipped, cancelled or aborted. */
  readonly bar: DagBarGlyph
  /** Symbol in front of a node row. */
  readonly glyph: string
  /** How bad the state is when a wave collapses into one segment: the highest rank wins. */
  readonly rank: number
}

interface DagStateRule {
  readonly status: string
  /** Only matches a failure of this class. */
  readonly errorClass?: string
  readonly state: DagDisplayState
}

/**
 * Persisted status, plus failure class, to display state. The server persists
 * seven node statuses. Cancellation is not one of them: a cancelled node is
 * `failed` with `error_class` "cancelled" (the rule `displayState` applies in
 * `@graphagent/schema/dag-status`), so that row has to sit above plain
 * `failed`. `paused`, `stepping` and `cancelled` are workflow statuses; no
 * node row holds them. The first matching row wins.
 */
export const DAG_STATE_TABLE: readonly DagStateRule[] = [
  { status: "pending", state: "pending" },
  { status: "queued", state: "queued" },
  { status: "running", state: "running" },
  { status: "completed", state: "completed" },
  { status: "failed", errorClass: "cancelled", state: "cancelled" },
  { status: "failed", state: "failed" },
  { status: "aborted", state: "aborted" },
  { status: "skipped", state: "skipped" },
  { status: "paused", state: "paused" },
  { status: "stepping", state: "stepping" },
  { status: "cancelled", state: "cancelled" },
]

/**
 * Display state to token, bar glyph, row symbol and collapse rank. Waiting
 * states share a color with the ones that will never run, and the thin line
 * against the dashed one tells them apart without color. The rank order is
 * failed > running > paused > queued > skipped > completed. Paused and
 * stepping keep the plain circle: only a workflow can be in them, and a
 * workflow is labelled in text rather than by a node symbol.
 */
export const DAG_STATE_STYLE: Readonly<Record<DagDisplayState, DagStateStyle>> = {
  completed: { token: "success", bar: "━", glyph: "✓", rank: 0 },
  skipped: { token: "statusQueued", bar: "╌", glyph: "⊘", rank: 1 },
  cancelled: { token: "statusQueued", bar: "╌", glyph: "⊘", rank: 1 },
  aborted: { token: "statusQueued", bar: "╌", glyph: "↯", rank: 1 },
  pending: { token: "statusQueued", bar: "─", glyph: "○", rank: 2 },
  queued: { token: "statusQueued", bar: "─", glyph: "○", rank: 2 },
  paused: { token: "statusPaused", bar: "━", glyph: "○", rank: 3 },
  stepping: { token: "statusPaused", bar: "━", glyph: "○", rank: 3 },
  running: { token: "statusRunning", bar: "━", glyph: "●", rank: 4 },
  failed: { token: "error", bar: "━", glyph: "✗", rank: 5 },
}

/** A status the table does not know, such as one a newer server adds: plain text, waiting line, ranked with the waiting states. */
const UNKNOWN_STYLE: DagStateStyle = { token: "text", bar: "─", glyph: "○", rank: 2 }

/** The display state of a node or workflow status; undefined for a status the table does not know. */
export function dagDisplayState(status: string, errorClass?: string): DagDisplayState | undefined {
  return DAG_STATE_TABLE.find(
    (rule) => rule.status === status && (rule.errorClass === undefined || rule.errorClass === errorClass),
  )?.state
}

/** Token, bar glyph, row symbol and rank for a status. */
export function dagStateStyle(status: string, errorClass?: string): DagStateStyle {
  const state = dagDisplayState(status, errorClass)
  return state === undefined ? UNKNOWN_STYLE : DAG_STATE_STYLE[state]
}

/**
 * Shared status→theme-token mapping for every DAG surface, so one status never
 * renders in different colors across views. Accepts both workflow and node
 * statuses; pass the node's `error_class` so a cancelled node reads as
 * cancelled. Callers resolve the token against the active theme.
 */
export function dagStatusColor(status: string, errorClass?: string): DagStatusToken {
  return dagStateStyle(status, errorClass).token
}

/** Status glyph for node rows — mirrors the todo-item ✓ vocabulary. */
export function dagNodeGlyph(status: string, errorClass?: string): string {
  return dagStateStyle(status, errorClass).glyph
}

/** Progress-bar character for a status. */
export function dagBarGlyph(status: string, errorClass?: string): DagBarGlyph {
  return dagStateStyle(status, errorClass).bar
}

/** Display states a node can still leave by running: a wave with one of them is not finished. */
const WORK_LEFT_STATES: ReadonlySet<DagDisplayState | undefined> = new Set([
  "pending",
  "queued",
  "running",
  // A status the table does not know could still be waiting.
  undefined,
])

/**
 * Index of the wave a workflow is working on: the first one with a node still to
 * run or running. A node that failed, was skipped, aborted or cancelled has
 * settled and does not hold its wave open. Once everything has settled it is the
 * last wave; with no waves there is none.
 */
export function dagCurrentWave(
  waves: readonly (readonly { readonly status: string; readonly error_class?: string }[])[],
): number | undefined {
  if (waves.length === 0) return undefined
  const current = waves.findIndex((wave) =>
    wave.some((node) => WORK_LEFT_STATES.has(dagDisplayState(node.status, node.error_class))),
  )
  return current === -1 ? waves.length - 1 : current
}

/**
 * Time a workflow has been going, in milliseconds: from the earliest node start
 * up to `now` while the workflow is `active` (between two waves too, when every
 * node that started has finished), or up to the last completion once it is over.
 * Undefined until a node has started; never negative.
 */
export function dagElapsedMs(
  nodes: readonly Pick<DagNodeRow, "started_at" | "completed_at">[],
  now: number,
  active: boolean,
): number | undefined {
  let first: number | undefined
  let last: number | undefined
  for (const node of nodes) {
    if (node.started_at !== undefined && (first === undefined || node.started_at < first)) first = node.started_at
    if (node.completed_at !== undefined && (last === undefined || node.completed_at > last)) last = node.completed_at
  }
  if (first === undefined) return undefined
  return Math.max(0, (active ? now : (last ?? first)) - first)
}

/** Workflow statuses that are still going: the main agent has not finished with them. */
const ACTIVE_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(["running", "stepping", "paused"])

export interface DagMainSelection {
  /** The workflow the status band shows, if any. */
  readonly main: DagWorkflowSummary | undefined
  /** Every other workflow, for the `+N` tail. */
  readonly others: readonly DagWorkflowSummary[]
  /** An active or an unconfirmed failed workflow exists: the condition for an automatic band. */
  readonly attention: boolean
}

/**
 * Pick the one workflow the status band shows from a session tree's workflows.
 * `workflows` is newest first, the order the server lists a session's
 * workflows in (by creation time, descending), so "most recent" among equals
 * is the first one. Order of preference:
 *
 * 1. the workflow the user picked in the panel, while it still exists;
 * 2. an active one (running, stepping, paused);
 * 3. a failed one the user has not confirmed (`acknowledged` holds the ids
 *    they opened in the panel).
 *
 * A finished workflow is only ever picked by rule 1; `attention` says whether
 * anything still needs the band.
 */
export function selectMainWorkflow(
  workflows: readonly DagWorkflowSummary[],
  memory: { readonly chosen?: string; readonly acknowledged?: ReadonlySet<string> } = {},
): DagMainSelection {
  const chosen = memory.chosen === undefined ? undefined : workflows.find((workflow) => workflow.id === memory.chosen)
  const active = workflows.find((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status))
  const unconfirmed = workflows.find(
    (workflow) => workflow.status === "failed" && !(memory.acknowledged?.has(workflow.id) ?? false),
  )
  const main = chosen ?? active ?? unconfirmed
  return {
    main,
    others: workflows.filter((workflow) => workflow !== main),
    attention: active !== undefined || unconfirmed !== undefined,
  }
}

/**
 * One workflow ready to draw: its summary, its nodes, and the nodes grouped
 * into waves. `nodes` is empty until the table has loaded, and the display
 * falls back to the summary counts.
 */
export interface DagWorkflowView<T extends DagWaveNode = DagNodeRow> {
  readonly summary: DagWorkflowSummary
  readonly nodes: readonly T[]
  readonly waves: readonly (readonly T[])[]
  /** Nodes outside every wave: a dependency cycle, or a dependency on one. */
  readonly unplaced: readonly T[]
}

export function dagWorkflowView<T extends DagWaveNode>(
  summary: DagWorkflowSummary,
  nodes: readonly T[] | undefined,
): DagWorkflowView<T> {
  const rows = nodes ?? []
  const { waves, unplaced } = computeWaves(rows)
  return { summary, nodes: rows, waves, unplaced }
}
