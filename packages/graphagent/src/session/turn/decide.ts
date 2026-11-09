// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionRetry } from "../retry"
import type { TurnState } from "./state"

/**
 * Two-phase turn decision layer (Issue #1019, PR7).
 *
 * `decide` is pure: no I/O, no Layer construction, no InstanceState, and no
 * environment reads. The effectful loop gathers `Signals` (including the
 * authoritative queued-input query), calls `decide`, performs the requested
 * effect (`run_stop_hooks`, `check_step_input`), and calls it again with the
 * result. Decision order matches the pre-refactor inline code:
 *
 *   completion candidate -> RunStopHooks (if Stop has not run)
 *     -> ContinueWith while a Stop block is within the cap
 *     -> otherwise stepInputPending ? continue with queued input : Finish
 */

export type StopHookEvent = "Stop" | "SubagentStop" | "StopFailure"

/** Projection of the hook `TriggerResult` that the pure decision consumes. */
export interface HookStopDecision {
  readonly blocked: boolean
  readonly preventContinuation: boolean
}

export interface StopPolicy {
  /** Event the effectful layer runs when this turn completes. */
  readonly event: StopHookEvent
  /** False when Stop hooks are unavailable for this turn (no SettingsHook). */
  readonly enabled: boolean
}

/** Message-derived completion inputs. The loop reads them once per snapshot. */
export interface CompletionSignals {
  /** Latest assistant message carries a terminal finish (anything except tool-calls). */
  readonly assistantFinished: boolean
  /** Latest user message precedes the latest assistant message. */
  readonly userBeforeAssistant: boolean
  /** Latest assistant message still has local (non-provider-executed) tool parts. */
  readonly pendingLocalTools: boolean
}

export interface Signals extends CompletionSignals {
  /** `not_run` until the effectful layer actually ran Stop hooks. */
  readonly stopHook: "not_run" | HookStopDecision
  /** True only after an authoritative queued-input query (`revisions.queued`). */
  readonly stepInputPending: boolean
  /** True once that query ran, or when no mailbox exists to query. */
  readonly stepInputChecked: boolean
  /** The owner (task subagent or DAG) delivers Stop itself; this loop must not run it. */
  readonly ownerDefersStop: boolean
  readonly stopPolicy: StopPolicy
  readonly budgetExhausted: boolean
  readonly assistantFinish: string | undefined
}

export type TurnOutcome =
  | { readonly type: "completed" }
  | { readonly type: "length" }
  | { readonly type: "tool_budget_exhausted" }
  | { readonly type: "structured_missing" }
  | { readonly type: "content_filter" }
  | { readonly type: "error"; readonly code: string; readonly retryable: boolean }
  | { readonly type: "cancelled"; readonly reason: string | undefined }
  | { readonly type: "context_overflow" }

export type Transition =
  /** Run the next model step in this loop iteration. Consumes `TurnState.continuing`. */
  | { readonly kind: "step" }
  /** Stop has not run yet; the effectful layer triggers hooks and decides again. */
  | { readonly kind: "run_stop_hooks"; readonly event: StopHookEvent }
  /** Loop to the top to prepare (freeze agent input) before the next model step. */
  | { readonly kind: "continue"; readonly source: "stop_block" | "queued_input" }
  /** Ask the effectful layer for the authoritative queued-input query, then decide again. */
  | { readonly kind: "check_step_input" }
  /** Start another automatic compaction (`decideOverflow` only). */
  | { readonly kind: "compact" }
  | { readonly kind: "finish"; readonly outcome: TurnOutcome }

/** The fourth consecutive automatic compaction is refused (three already ran). */
export const AUTO_COMPACTION_LIMIT = 3

const NEUTRAL_HOOK: HookStopDecision = { blocked: false, preventContinuation: false }

/** A completion candidate matches the pre-refactor `needsStop`/Stop gate condition. */
export function isCompletionCandidate(state: TurnState, signals: CompletionSignals): boolean {
  return state.stopped || (signals.assistantFinished && signals.userBeforeAssistant && !signals.pendingLocalTools)
}

/** The top-of-loop agent-input freeze condition (old `!needsStop || boundaryApproved || forceContinue`). */
export function shouldFreezeAgentInput(state: TurnState, completed: boolean): boolean {
  return (
    state.agentInput !== "blocked" &&
    (!completed || state.agentInput === "boundary_approved" || state.continuing !== undefined)
  )
}

/** A blocked input owner or a turn error forbids both Stop-block and queued-input continuation. */
export function continuationAllowed(state: TurnState): boolean {
  return state.agentInput !== "blocked" && state.error === undefined
}

export function decide(state: TurnState, signals: Signals): Transition {
  if (!isCompletionCandidate(state, signals)) return { kind: "step" }

  // A Stop-block continuation runs exactly one more model step. A blocked input
  // owner keeps the grant unconsumed and falls through to the exit path.
  if (state.continuing === "stop_block" && state.agentInput !== "blocked") return { kind: "step" }

  let hook = NEUTRAL_HOOK
  if (signals.stopHook === "not_run") {
    if (signals.stopPolicy.enabled && !signals.ownerDefersStop) {
      return { kind: "run_stop_hooks", event: signals.stopPolicy.event }
    }
  } else {
    hook = signals.stopHook
  }

  const allowContinuation = continuationAllowed(state)
  if (allowContinuation && hook.blocked && !hook.preventContinuation && state.stop.continuations < state.stop.cap) {
    return { kind: "continue", source: "stop_block" }
  }
  if (allowContinuation && !hook.preventContinuation) {
    // The pending flag has authority only after the queued-input query ran.
    if (!signals.stepInputChecked) return { kind: "check_step_input" }
    if (signals.stepInputPending) return { kind: "continue", source: "queued_input" }
  }
  return { kind: "finish", outcome: outcomeOf(state, signals) }
}

/** Post-step auto-compaction gate. Called after the step counter advanced and tasks were handled. */
export function decideOverflow(state: TurnState, signals: { readonly overflow: boolean }): Transition {
  if (!signals.overflow) return { kind: "step" }
  if (state.compactions >= AUTO_COMPACTION_LIMIT) return { kind: "finish", outcome: { type: "context_overflow" } }
  return { kind: "compact" }
}

function outcomeOf(state: TurnState, signals: Signals): TurnOutcome {
  const error = state.error
  if (error) {
    if (SessionV1.AbortedError.isInstance(error)) return { type: "cancelled", reason: messageOf(error) }
    if (SessionV1.ContentFilterError.isInstance(error)) return { type: "content_filter" }
    if (SessionV1.StructuredOutputError.isInstance(error)) return { type: "structured_missing" }
    if (SessionV1.OutputLengthError.isInstance(error)) return { type: "length" }
    // Retryability stays owned by the shared retry policy; the provider argument
    // is only part of its legacy signature.
    return { type: "error", code: error.name, retryable: SessionRetry.retryable(error, "") !== undefined }
  }
  if (signals.assistantFinish === "length") return { type: "length" }
  if (signals.budgetExhausted) return { type: "tool_budget_exhausted" }
  return { type: "completed" }
}

function messageOf(error: NonNullable<TurnState["error"]>): string | undefined {
  if (typeof error.data !== "object" || error.data === null || !("message" in error.data)) return undefined
  return typeof error.data.message === "string" ? error.data.message : undefined
}

export * as Decide from "./decide"
