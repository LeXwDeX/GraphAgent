// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Stop-reason vocabulary (#1327): why automatic advancement stopped.
 *
 * Two layers. Why one turn ended stays `TurnOutcome` (`session_turn.outcome`)
 * and is not touched here. A stop reason is the second layer: a closed set
 * derived from turn outcomes, user actions, agent declarations,
 * background-analysis conclusions and guardrail counters. `StopCondition.evaluate`
 * (`packages/graphagent/src/session/stop-condition.ts`) is the only place that
 * maps those signals to a reason, so a new automatic mechanism reuses this set
 * instead of writing its own pause text.
 *
 * Pure: zero imports, shared by the SDK and the TUI. User-facing wording is
 * looked up by `reason`; `detail.message` only supplements it and is never the
 * reason itself. A DAG pause reason that shares a word (`budget_exhausted`)
 * is the same concept, but DAG pause reasons belong to the workflow and are
 * not merged here.
 */

/** Every reason automatic advancement can stop, grouped by `STOP_REASON_PROPS[reason].class`. */
export const STOP_REASON_VALUES = [
  // completion
  "completed",
  // user
  "user_stopped",
  "user_interrupted",
  "goal_changed",
  // needs a person
  "needs_user",
  // outside the loop's control
  "provider_unavailable",
  "context_exhausted",
  "content_refused",
  "hook_stopped",
  "session_archived",
  // guardrails
  "budget_exhausted",
  "no_progress",
  "wait_expired",
  "analysis_failed",
  // fallback
  "internal_error",
] as const

export type StopReason = (typeof STOP_REASON_VALUES)[number]

export type StopClass = "completion" | "user" | "needs_human" | "external" | "guardrail" | "fallback"

/**
 * What stopping does to the automatic run. `completed` and `cancelled` end it
 * for good (a terminal snapshot is written); `no` leaves it resumable.
 */
export type StopEnds = "completed" | "cancelled" | "no"

export interface StopReasonProps {
  readonly class: StopClass
  readonly ends: StopEnds
}

/**
 * Fixed properties of every reason. `satisfies Record<StopReason, ...>` makes a
 * missing reason, or a key that is not a reason, fail to compile.
 */
export const STOP_REASON_PROPS = {
  completed: { class: "completion", ends: "completed" },
  user_stopped: { class: "user", ends: "no" },
  user_interrupted: { class: "user", ends: "no" },
  goal_changed: { class: "user", ends: "cancelled" },
  needs_user: { class: "needs_human", ends: "no" },
  provider_unavailable: { class: "external", ends: "no" },
  context_exhausted: { class: "external", ends: "no" },
  content_refused: { class: "external", ends: "no" },
  hook_stopped: { class: "external", ends: "no" },
  session_archived: { class: "external", ends: "cancelled" },
  budget_exhausted: { class: "guardrail", ends: "no" },
  no_progress: { class: "guardrail", ends: "no" },
  wait_expired: { class: "guardrail", ends: "no" },
  analysis_failed: { class: "guardrail", ends: "no" },
  internal_error: { class: "fallback", ends: "no" },
} as const satisfies Record<StopReason, StopReasonProps>

/**
 * `user_stopped`: `/loop stop` carries no detail; a stop asked for in a message
 * names that message; a goal migrated to a loop keeps its old pause text.
 */
export type UserStoppedDetail =
  { readonly basis_message_id: string } | { readonly code: "migrated"; readonly message: string }

/**
 * `goal_changed`: `explicit` is the user replacing the loop (`/loop <new
 * description>`); `inferred` is the background analysis reading a user message.
 */
export type GoalChangedDetail =
  { readonly code: "explicit" } | { readonly code: "inferred"; readonly basis_message_id: string }

/**
 * `needs_user`: `open_question` is a question only the user can answer;
 * `rejected` is a permission prompt or question the user refused.
 */
export interface NeedsUserDetail {
  readonly code: "open_question" | "rejected"
}

/** `provider_unavailable`: the failure that ended self-healing, or needed none. */
export interface ProviderUnavailableDetail {
  /** Name of the originating error, the value `TurnOutcome.error.code` carries. */
  readonly code: string
  /** HTTP status, when the failure had one. */
  readonly status?: number
  readonly message: string
}

/** `hook_stopped`: the reason the hook gave. */
export interface HookStoppedDetail {
  readonly message: string
}

/** `analysis_failed`: all attempts were non-compliant, or the analysis overran its step or time limit. */
export interface AnalysisFailedDetail {
  readonly code: "invalid_output" | "limit"
}

/** `internal_error`: a turn that died on a defect, or a result that must not occur. */
export interface InternalErrorDetail {
  readonly code: string
  readonly message: string
}

/**
 * A reason plus the `detail` its row defines. A reason without a row carries no
 * detail; `user_stopped` is the only one where `detail` may be absent.
 */
export type Stop =
  | { readonly reason: "completed" }
  | { readonly reason: "user_stopped"; readonly detail?: UserStoppedDetail }
  | { readonly reason: "user_interrupted" }
  | { readonly reason: "goal_changed"; readonly detail: GoalChangedDetail }
  | { readonly reason: "needs_user"; readonly detail: NeedsUserDetail }
  | { readonly reason: "provider_unavailable"; readonly detail: ProviderUnavailableDetail }
  | { readonly reason: "context_exhausted" }
  | { readonly reason: "content_refused" }
  | { readonly reason: "hook_stopped"; readonly detail: HookStoppedDetail }
  | { readonly reason: "session_archived" }
  | { readonly reason: "budget_exhausted" }
  | { readonly reason: "no_progress" }
  | { readonly reason: "wait_expired" }
  | { readonly reason: "analysis_failed"; readonly detail: AnalysisFailedDetail }
  | { readonly reason: "internal_error"; readonly detail: InternalErrorDetail }

/** What gets persisted: `at` is epoch milliseconds, stamped by the caller (the decision itself has no clock). */
export type StopRecord = Stop & { readonly at: number }
