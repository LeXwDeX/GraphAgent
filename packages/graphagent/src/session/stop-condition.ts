// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Stop } from "@graphagent/schema/stop-reason"
import { REASONING_STATE_MESSAGE } from "@/provider/error"
import { isRecord } from "@/util/record"
import { SessionRetry } from "./retry"
import type { TurnOutcome } from "./turn/decide"

/**
 * Unified stop condition for automatic advancement (#1327).
 *
 * Pure: no I/O, no Layer, no InstanceState, no database or event bus, and no
 * dependency on goal or loop code. A caller (the loop runtime, #1329) collects
 * normalized signals, calls `evaluate`, and executes the verdict. Where a
 * signal comes from, how state is stored, and timing and dispatch are theirs.
 *
 * - `evaluate` is the only place that maps signals to the next action.
 * - `failureOf` classifies a provider error; `nextRecovery` is the self-healing
 *   ladder that follows it.
 * - `budgetExhausted` is the one round-limit predicate.
 *
 * Calling conventions, owned by the caller:
 * - While a self-healing probe is pending, do not call `evaluate`, except for
 *   a user action or archiving.
 * - A decision after a resume carries only the analysis result and the counts,
 *   not the stopped boundary's `turn`, `failure`, `user_rejected`, `hook_stop`
 *   or `declaration`: those were handled when it stopped.
 * - Waking a waited-on object, a due probe and the resume command itself do not
 *   go through `evaluate`. A wake checks `budgetExhausted` before dispatching.
 */

/**
 * How a provider failure can heal.
 *
 * - `transient`: rate limits, 5xx, network, incomplete protocol, and anything
 *   unrecognised. Time fixes it.
 * - `permanent`: resending cannot succeed (a spent quota or balance, auth, a
 *   content refusal, a deterministic 4xx, other terminal errors).
 * - `reasoning_state`: the provider rejected the saved reasoning; dropping it
 *   (a reset) is the only way forward.
 * - `context`: the request does not fit. It stops as `context_exhausted`
 *   instead of retrying.
 */
export type FailureKind = "transient" | "permanent" | "reasoning_state" | "context"

interface FailureFields {
  /** Name of the originating error, the value `TurnOutcome.error.code` carries. */
  readonly code: string
  /** HTTP status, when the error had one. */
  readonly status?: number
  readonly message: string
  /** The server's own retry hint in milliseconds, when it gave one. */
  readonly retry_after_ms?: number
}

export type Failure = { readonly [K in FailureKind]: FailureFields & { readonly kind: K } }[FailureKind]

/** The failures the recovery ladder handles; `context` never enters it. */
export type LadderFailure = Exclude<Failure, { readonly kind: "context" }>

/**
 * Classifies one provider error. It reads the class `SessionRetry.classify`
 * puts on its decision and adds no judgement of its own. The first row that
 * matches wins:
 *
 * 1. the provider rejected saved reasoning state: `reasoning_state`
 * 2. the request does not fit (context overflow, 413): `context`
 * 3. a rate limit, or time can fix it (5xx, network, incomplete protocol, a 4xx
 *    flagged transient), or the dispatch table does not recognise it: `transient`
 * 4. the rest (a spent quota or balance, rejected credentials, a content
 *    refusal, a deterministic 4xx, other `terminal` errors): `permanent`
 *
 * `now` only matters for an HTTP-date `retry-after`; pass it for determinism.
 * A turn that died on a defect has no error to classify: leave `failure` out
 * of the `evaluate` input instead.
 */
export function failureOf(error: SessionRetry.Err, provider: string, now: number = Date.now()): Failure {
  const decision = SessionRetry.classify(error, provider)
  const retryAfter = retryAfterOf(error, now)
  return {
    kind: kindOf(decision),
    code: error.name,
    ...(decision.status !== undefined ? { status: decision.status } : {}),
    message: decision.message,
    ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
  }
}

function kindOf(decision: SessionRetry.RetryDecision): FailureKind {
  if (decision.branch === "terminal" && decision.message === REASONING_STATE_MESSAGE) return "reasoning_state"
  switch (decision.class) {
    case "context_overflow":
      return "context"
    case "rate_limited":
    case "transient":
      return "transient"
    default:
      return "permanent"
  }
}

/** The server's own hint, from `retry-after-ms`, then `retry-after` (seconds or an HTTP date). */
function retryAfterOf(error: SessionRetry.Err, now: number): number | undefined {
  const data: unknown = error.data
  if (!isRecord(data) || !isRecord(data.responseHeaders)) return undefined
  const headers = data.responseHeaders
  const ms = Number(header(headers, "retry-after-ms"))
  if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms)
  const after = header(headers, "retry-after")
  const seconds = Number(after)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const wait = Date.parse(after ?? "") - now
  return Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** What the current failure chain has already spent. All three start at 0; the caller owns them. */
export interface Chain {
  /** `retry` actions issued. */
  readonly attempts: number
  /** `reset` actions issued. */
  readonly reset: number
  /** `probe` actions issued. */
  readonly probes: number
}

/** Which step failed: a turn, or the background analysis of a boundary. */
export type RecoveryStep = "round" | "analysis"

export type Recovery =
  | { readonly type: "retry" }
  | { readonly type: "reset" }
  | { readonly type: "probe"; readonly after_ms: number }
  | { readonly type: "give_up" }

export type RecoverAction = Exclude<Recovery, { readonly type: "give_up" }>

/** Level two: failure-chain recovery, the limits goal recovery already used. */
export const RECOVERY_RETRY_LIMIT = 2
export const RECOVERY_RESET_LIMIT = 1
/** Level three: the delay of each delayed probe, in order. */
export const PROBE_DELAYS_MS = [60_000, 300_000, 900_000] as const
/** One probe never waits longer than this, whatever the server asks for. */
export const PROBE_MAX_DELAY_MS = 1_800_000
/** Consecutive no-progress analyses that stop the run. */
export const NO_PROGRESS_LIMIT = 3

/**
 * The self-healing ladder after a provider failure. Level one, the in-request
 * retry (`SessionRetry.policy`), runs before a failure gets here and is not
 * changed. This decides what comes after it:
 *
 * - level two, failure-chain recovery: `transient` gets up to 2 `retry`,
 *   `reasoning_state` up to 1 `reset`;
 * - level three, delayed probe, `transient` only: once level two is spent, 3
 *   probes at 60 s, 300 s and 900 s. A longer `retry_after_ms` wins; one probe
 *   never waits past 1800 s. A probe redispatches the failed step once;
 * - `give_up` when the ladder is spent. That is what "cannot self-heal" means:
 *   the caller stops with `provider_unavailable`.
 *
 * `permanent` gives up at once. `step: "analysis"` has no reset (an analysis
 * request carries no saved reasoning), so `reasoning_state` gives up at once
 * there. A chain ends on a committed non-summary work turn, a committed
 * analysis, a user resume or a new run; the counts are the caller's.
 */
export function nextRecovery(chain: Chain, failure: LadderFailure, step: RecoveryStep): Recovery {
  switch (failure.kind) {
    case "permanent":
      return { type: "give_up" }
    case "reasoning_state":
      return step === "round" && chain.reset < RECOVERY_RESET_LIMIT ? { type: "reset" } : { type: "give_up" }
    case "transient":
      if (chain.attempts < RECOVERY_RETRY_LIMIT) return { type: "retry" }
      if (chain.probes < PROBE_DELAYS_MS.length)
        return { type: "probe", after_ms: probeDelay(PROBE_DELAYS_MS[chain.probes], failure.retry_after_ms) }
      return { type: "give_up" }
  }
  // `context` never enters the ladder; an untyped caller that sends it anyway gets no healing.
  return exhausted(failure, { type: "give_up" })
}

function probeDelay(base: number, hint: number | undefined) {
  const wanted = hint !== undefined && Number.isFinite(hint) ? Math.max(base, hint) : base
  return Math.min(wanted, PROBE_MAX_DELAY_MS)
}

/** The single round-limit predicate; nothing else compares `round` with `max_rounds`. */
export function budgetExhausted(round: number, max_rounds: number): boolean {
  return round >= max_rounds
}

export type UserAction = "stop" | "interrupt" | "replace" | "done"

/** What the agent declared in the boundary's turn. Valid on that one boundary only. */
export type Declaration = "await" | "done" | "blocked"

/** An external object being waited on (a PR watch, a background task). A self-healing probe wait does not count. */
export interface Waiting {
  /** The object is still running. */
  readonly alive: boolean
  /** The wait deadline has passed. */
  readonly expired: boolean
  /** The review round that follows an expired wait has already run. */
  readonly reviewed: boolean
}

export type AnalysisFailure = "provider" | "invalid_output" | "limit" | "cancelled"

/**
 * The background analysis of a boundary: five conclusions or four failures.
 * `goal_changed` and `user_stop` name the human message they rest on. A
 * `provider` failure comes with `Input.failure`.
 */
export type Analysis =
  | { readonly type: "continue"; readonly advanced: boolean }
  | { readonly type: "done" }
  | { readonly type: "blocked" }
  | { readonly type: "goal_changed"; readonly basis_message_id: string }
  | { readonly type: "user_stop"; readonly basis_message_id: string }
  | { readonly type: "failed"; readonly cause: AnalysisFailure }

/** The normalized signals of one boundary. Optional fields are absent when the event did not happen. */
export interface Input {
  readonly user_action?: UserAction
  readonly archived?: boolean
  /** A hook asked to stop (Stop or admission `continue: false`, or a tool-phase hook ended the turn). */
  readonly hook_stop?: { readonly message: string }
  /** The turn ended because the user refused a permission prompt or a question. */
  readonly user_rejected?: boolean
  /** The boundary's turn result. Absent for a decision triggered by the periodic scan. */
  readonly turn?: TurnOutcome
  /** The boundary's turn was started by a human message. */
  readonly human_turn: boolean
  /** From `failureOf`. Given when a turn or the analysis failed on a provider error; absent for a defect. */
  readonly failure?: Failure
  /** A human message arrived after the last committed analysis. */
  readonly new_human_message: boolean
  readonly declaration?: Declaration
  /** Present while waiting on an external object. */
  readonly waiting?: Waiting
  /** The boundary's turn is the review round that follows an expired wait. */
  readonly review_round: boolean
  /** The session has a running PR watch or background task. */
  readonly running_waitable: boolean
  /** Absent until the boundary has been analyzed. */
  readonly analysis?: Analysis
  readonly round: number
  readonly max_rounds: number
  /** Consecutive no-progress analyses, this one included. */
  readonly no_progress_streak: number
  readonly chain: Chain
}

/**
 * The next action. `stop` carries the reason and its detail; the caller stamps
 * `at` to make a `StopRecord`.
 */
export type Verdict =
  | { readonly type: "analyze" }
  | { readonly type: "dispatch"; readonly round: "next" | "review" }
  | { readonly type: "wait" }
  | { readonly type: "recover"; readonly action: RecoverAction }
  | ({ readonly type: "stop" } & Stop)
  | { readonly type: "none" }

/**
 * The single decision point. The first rule that has a say wins; a rule with
 * nothing to say passes to the next:
 *
 * 1. user action, 2. archived, 3. hook stop, 4. the turn result,
 * 5. user rejection, 6. no analysis yet, 7. an analysis result.
 */
export function evaluate(input: Input): Verdict {
  return (
    byUserAction(input) ??
    byArchive(input) ??
    byHook(input) ??
    byTurn(input) ??
    byRejection(input) ??
    (input.analysis ? byAnalysis(input, input.analysis) : byBoundary(input))
  )
}

function stop(value: Stop): Verdict {
  return { type: "stop", ...value }
}

/** A value that cannot occur: a type hole or a newer writer's data. It stops as `internal_error` instead of guessing. */
function unexpected(what: string): Verdict {
  return stop({
    reason: "internal_error",
    detail: { code: `unexpected_${what}`, message: `Unexpected ${what.replaceAll("_", " ")}` },
  })
}

/**
 * Closes a `switch` that has no `default`. `value` is `never` only while every
 * variant has a case, so a new variant fails to compile at the call. At runtime
 * a value that still arrives gets `fallback`.
 */
function exhausted<T>(_value: never, fallback: T): T {
  return fallback
}

function byUserAction(input: Input): Verdict | undefined {
  const action = input.user_action
  switch (action) {
    case undefined:
      return undefined
    case "stop":
      return stop({ reason: "user_stopped" })
    case "interrupt":
      return stop({ reason: "user_interrupted" })
    case "replace":
      return stop({ reason: "goal_changed", detail: { code: "explicit" } })
    case "done":
      return stop({ reason: "completed" })
  }
  return exhausted(action, unexpected("user_action"))
}

function byArchive(input: Input): Verdict | undefined {
  return input.archived ? stop({ reason: "session_archived" }) : undefined
}

function byHook(input: Input): Verdict | undefined {
  return input.hook_stop ? stop({ reason: "hook_stopped", detail: { message: input.hook_stop.message } }) : undefined
}

/** How each `TurnOutcome` moves the decision. There is no `default`: a new outcome must get a case here. */
function byTurn(input: Input): Verdict | undefined {
  const turn = input.turn
  if (!turn) return undefined
  switch (turn.type) {
    // A cut-off answer or an exhausted tool budget is not a failure.
    case "completed":
    case "length":
    case "tool_budget_exhausted":
    // A restart's leftover is an ordinary boundary. A user abort is `user_action: "interrupt"`, handled first.
    case "interrupted":
    case "cancelled":
      return undefined
    case "error":
      return byError(input, turn)
    case "context_overflow":
      return stop({ reason: "context_exhausted" })
    case "content_filter":
      return stop({ reason: "content_refused" })
    case "structured_missing":
      // A loop turn does not ask for structured output, so this is a defect.
      return stop({
        reason: "internal_error",
        detail: {
          code: "structured_missing",
          message: "A loop turn ended without the structured output it never asked for",
        },
      })
    case "blocked":
      // Refused before it began: not a loop turn (today only a stale hook rewake).
      return { type: "none" }
  }
  return exhausted(turn, unexpected("turn_outcome"))
}

function byError(input: Input, turn: Extract<TurnOutcome, { readonly type: "error" }>): Verdict {
  if (input.failure) return byFailure(input, input.failure, "round")
  // A defect left no provider error to classify.
  if (turn.code === "context_overflow") return stop({ reason: "context_exhausted" })
  return stop({
    reason: "internal_error",
    detail: { code: turn.code, message: "The turn failed without a provider error to classify" },
  })
}

/** A provider failure from a turn or from the analysis. */
function byFailure(input: Input, failure: Failure, step: RecoveryStep): Verdict {
  if (failure.kind === "context") return stop({ reason: "context_exhausted" })
  // The user is present for their own turn: no automatic redispatch, stop and let them decide.
  if (step === "round" && input.human_turn) return unavailable(failure)
  const next = nextRecovery(input.chain, failure, step)
  return next.type === "give_up" ? unavailable(failure) : { type: "recover", action: next }
}

function unavailable(failure: LadderFailure): Verdict {
  return stop({
    reason: "provider_unavailable",
    detail: {
      code: failure.code,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      message: failure.message,
    },
  })
}

function byRejection(input: Input): Verdict | undefined {
  return input.user_rejected ? stop({ reason: "needs_user", detail: { code: "rejected" } }) : undefined
}

/** Waiting on a live object whose deadline has not passed. */
function isAwaiting(waiting: Waiting | undefined): boolean {
  return waiting !== undefined && waiting.alive && !waiting.expired
}

/** The boundary has not been analyzed yet. */
function byBoundary(input: Input): Verdict {
  if (input.new_human_message) return { type: "analyze" }
  if (input.declaration === "await") return { type: "wait" }
  if (isAwaiting(input.waiting)) return { type: "none" }
  if (input.waiting?.expired && !input.waiting.reviewed) {
    return budgetExhausted(input.round, input.max_rounds)
      ? stop({ reason: "budget_exhausted" })
      : { type: "dispatch", round: "review" }
  }
  return { type: "analyze" }
}

function byAnalysis(input: Input, analysis: Analysis): Verdict {
  switch (analysis.type) {
    case "failed":
      return byAnalysisFailure(input, analysis.cause)
    case "done":
      return stop({ reason: "completed" })
    case "goal_changed":
      return stop({
        reason: "goal_changed",
        detail: { code: "inferred", basis_message_id: analysis.basis_message_id },
      })
    case "user_stop":
      return stop({ reason: "user_stopped", detail: { basis_message_id: analysis.basis_message_id } })
    case "blocked":
      // A running watch or task may still unblock the work (#1067); only a question for the user is a real stop.
      return input.running_waitable
        ? { type: "wait" }
        : stop({ reason: "needs_user", detail: { code: "open_question" } })
    case "continue":
      return byContinue(input, analysis.advanced)
  }
  return exhausted(analysis, unexpected("analysis_result"))
}

function byAnalysisFailure(input: Input, cause: AnalysisFailure): Verdict {
  switch (cause) {
    case "cancelled":
      // The caller triggers the boundary decision again right away.
      return { type: "none" }
    case "provider":
      return input.failure
        ? byFailure(input, input.failure, "analysis")
        : stop({
            reason: "internal_error",
            detail: {
              code: "missing_failure",
              message: "The analysis failed on a provider error that was not classified",
            },
          })
    case "invalid_output":
    case "limit":
      return stop({ reason: "analysis_failed", detail: { code: cause } })
  }
  return exhausted(cause, unexpected("analysis_failure"))
}

/** The analysis says keep going: the guardrails and waiting decide whether, and how. */
function byContinue(input: Input, advanced: boolean): Verdict {
  if (input.declaration === "await") return { type: "wait" }
  if (isAwaiting(input.waiting)) return { type: "none" }
  if (input.review_round && !advanced) return stop({ reason: "wait_expired" })
  if (input.no_progress_streak >= NO_PROGRESS_LIMIT) return stop({ reason: "no_progress" })
  if (budgetExhausted(input.round, input.max_rounds)) return stop({ reason: "budget_exhausted" })
  return { type: "dispatch", round: "next" }
}

export * as StopCondition from "./stop-condition"
