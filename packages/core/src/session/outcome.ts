// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionV1 } from "../v1/session"
import type { SessionStepTable, ToolOutcomeTable } from "./outcome.sql"

/**
 * #1473: the harness's own account of a tool call, kept in `ToolPart.state.metadata`.
 *
 * - `metadata.corrections` lists what the harness rewrote on the model's behalf
 *   (a repaired argument, a fuzzy edit match, ...). Each entry is a kind string;
 *   the statistics group by the string, so a new kind needs no schema change.
 * - `metadata.outcome` classifies a failed (`error` state) call. A completed call
 *   writes nothing: its outcome is derived by `toolOutcomeRow`.
 *
 * The `tool_outcome` table is a projection of both, written by the session projector.
 * The `session_step` table projects the `metrics` of `step-finish` parts the same way.
 */
export const TOOL_OUTCOME_KINDS = [
  "ok",
  "validation_error",
  "execution_error",
  "denied",
  "aborted",
  "arguments_truncated",
] as const
export type ToolOutcomeKind = (typeof TOOL_OUTCOME_KINDS)[number]

export type ToolOutcomeRow = typeof ToolOutcomeTable.$inferInsert
export type SessionStepRow = typeof SessionStepTable.$inferInsert

// The part as the `PartUpdated` event carries it; a mutable `SessionV1.Part` is assignable to it.
type EventPart = (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]
type FinishedToolState = Extract<Extract<EventPart, { type: "tool" }>["state"], { status: "completed" | "error" }>

const CORRECTION_KIND = /^[a-z][a-z0-9_]*$/
const MAX_CORRECTIONS = 16
const MAX_TOOL_NAME = 64

function isCorrectionKind(value: unknown): value is string {
  return typeof value === "string" && CORRECTION_KIND.test(value)
}

function isOutcomeKind(value: unknown): value is ToolOutcomeKind {
  return TOOL_OUTCOME_KINDS.some((kind) => kind === value)
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

/** The valid correction kinds recorded in `metadata.corrections`: no repeats, at most 16. */
export function correctionsOf(metadata: unknown): string[] {
  const recorded = field(metadata, "corrections")
  if (!Array.isArray(recorded)) return []
  const kinds: string[] = []
  for (const item of recorded) {
    if (kinds.length >= MAX_CORRECTIONS) break
    if (isCorrectionKind(item) && !kinds.includes(item)) kinds.push(item)
  }
  return kinds
}

/**
 * A copy of `metadata` with `kinds` added to `corrections`. Kinds already
 * recorded stay first; a repeated or invalid kind is dropped. The key is only
 * written when at least one kind remains.
 */
export function addCorrections<M extends Record<string, unknown>>(
  metadata: M,
  ...kinds: string[]
): M & { corrections?: string[] }
export function addCorrections(metadata: undefined, ...kinds: string[]): { corrections?: string[] }
export function addCorrections(metadata: Record<string, unknown> | undefined, ...kinds: string[]) {
  const merged = correctionsOf(metadata)
  for (const kind of kinds) {
    if (merged.length >= MAX_CORRECTIONS) break
    if (isCorrectionKind(kind) && !merged.includes(kind)) merged.push(kind)
  }
  return merged.length > 0 ? { ...metadata, corrections: merged } : { ...metadata }
}

function outcomeOf(state: FinishedToolState): ToolOutcomeKind {
  if (state.status === "completed") return field(state.metadata, "hookDenied") === true ? "denied" : "ok"
  const recorded = field(state.metadata, "outcome")
  return isOutcomeKind(recorded) ? recorded : "execution_error"
}

/**
 * The `tool_outcome` row of a part, or `undefined` while the part is not a
 * finished tool call. A part of the `invalid` tool (written before unknown tool
 * names were reported as errors) is booked under the tool the model really called.
 */
export function toolOutcomeRow(
  part: EventPart,
  model: { providerID: string; modelID: string },
): ToolOutcomeRow | undefined {
  if (part.type !== "tool") return undefined
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return undefined
  const called = part.tool === "invalid" ? field(state.input, "tool") : undefined
  const invalid = part.tool === "invalid"
  return {
    part_id: part.id,
    session_id: part.sessionID,
    provider_id: model.providerID,
    model_id: model.modelID,
    tool: (typeof called === "string" && called.length > 0 ? called : part.tool).slice(0, MAX_TOOL_NAME),
    outcome: invalid ? "validation_error" : outcomeOf(state),
    corrections: correctionsOf(state.metadata),
    truncated: field(state.metadata, "truncated") === true,
  }
}

/**
 * The `session_step` row of a part, or `undefined` unless it is a `step-finish`
 * part that carries `metrics` (one finished before the metrics existed has none).
 */
export function sessionStepRow(
  part: EventPart,
  model: { providerID: string; modelID: string },
): SessionStepRow | undefined {
  if (part.type !== "step-finish" || !part.metrics) return undefined
  return {
    part_id: part.id,
    session_id: part.sessionID,
    provider_id: model.providerID,
    model_id: model.modelID,
    prepare_ms: part.metrics.prepareMs,
    request_ms: part.metrics.requestMs,
    ttft_ms: part.metrics.ttftMs,
    tool_calls: part.metrics.toolCalls,
    tool_errors: part.metrics.toolErrors,
    retries: part.metrics.retries,
  }
}
