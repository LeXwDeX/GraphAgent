// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of the loop runtime (#1329): turning what the session and the state show into the input of
 * `StopCondition.evaluate`, and what a verdict or an analysis leaves behind into state values.
 *
 * Nothing here reads the clock, the session or the database; the runtime passes everything in. That keeps the
 * rules that are easy to get subtly wrong (what counts as a round, when a failure chain ends, which waits a
 * wake may consume) testable one at a time.
 */
import { Schema } from "effect"
import { LoopVerdict } from "@graphagent/schema/loop"
import type { LoopAnalysisResult } from "@graphagent/schema/loop"
import type { Stop } from "@graphagent/schema/stop-reason"
import { StopCondition } from "@/session/stop-condition"
import type { TurnOutcome } from "@/session/turn/decide"
import type { LoopHost } from "./host"
import type { LoopInput } from "./input"
import type { LoopState } from "./state"

export const ZERO_CHAIN: StopCondition.Chain = { attempts: 0, reset: 0, probes: 0 }

/** A turn that did its work. Its end closes a failure chain; an interrupted, cancelled or refused one does not. */
export function isOkTurn(turn: TurnOutcome): boolean {
  return turn.type === "completed" || turn.type === "length" || turn.type === "tool_budget_exhausted"
}

/** Identifies a boundary in `Recovery.boundary`; a turn that left no assistant message has the empty key. */
export const keyOf = (boundary: Pick<LoopHost.Boundary, "message">) => boundary.message ?? ""

/**
 * Tells one boundary from another where `keyOf` cannot: the closing message, or for a turn that left none, when it
 * ended. Two turns that left no message are two boundaries, and neither is taken for a message. Only the runtime's
 * memory of the boundary a resume masked uses it; it is never stored.
 */
export const identityOf = (boundary: Pick<LoopHost.Boundary, "message" | "endedAt">) =>
  boundary.message ?? `ended:${boundary.endedAt}`

/**
 * Whether the boundary was there before the loop began. A loop just started or replaced has not run its first round,
 * so the boundary in front of the session is an older one and says nothing about it. Message ids sort by creation:
 * a closing message that is not newer than the message that started the loop is older. A turn that left no message
 * has no id, and is told by when it ended. A migrated loop has no starting message and holds nothing back.
 */
export function precedesLoop(
  origin: Pick<LoopState.Origin, "message_id" | "created_at">,
  boundary: Pick<LoopHost.Boundary, "message" | "endedAt">,
): boolean {
  if (origin.message_id === undefined) return false
  if (boundary.message !== undefined) return boundary.message <= origin.message_id
  return boundary.endedAt < origin.created_at
}

/**
 * The failure chain the next decision is made with: the counts the state records, unless a turn has worked
 * since the failure the chain started at. The same boundary again (the analysis of a boundary whose turn
 * worked, failing a second time) is still the same chain.
 */
export function chainOf(recovery: LoopState.Recovery | undefined, boundary: LoopHost.Boundary): StopCondition.Chain {
  if (recovery === undefined) return ZERO_CHAIN
  if (isOkTurn(boundary.turn) && keyOf(boundary) !== recovery.boundary) return ZERO_CHAIN
  return { attempts: recovery.attempts, reset: recovery.reset, probes: recovery.probes }
}

/**
 * The failure chain after one more action of the ladder, anchored at the boundary that failed, with the step that
 * did. A probe redoes that step later, and the boundary alone does not say which it was.
 */
export function recoveryAfter(
  chain: StopCondition.Chain,
  action: StopCondition.RecoverAction,
  boundary: LoopHost.Boundary,
  now: number,
  step: StopCondition.RecoveryStep,
): LoopState.Recovery {
  const at = keyOf(boundary)
  if (action.type === "retry") return { ...chain, attempts: chain.attempts + 1, boundary: at, step }
  if (action.type === "reset") return { ...chain, reset: chain.reset + 1, boundary: at, step }
  return { ...chain, probes: chain.probes + 1, probe_at: now + action.after_ms, boundary: at, step }
}

/**
 * The step a probe that has come due redoes. The chain's record is trusted at the boundary it was made at: the
 * analysis of a boundary whose turn ended on an error (a loop resumed there analyses it first) is not a round to
 * send again. At any other boundary, where a turn ended meanwhile and failed or was cut short, and in a chain that
 * recorded no step, the boundary tells: a turn that ended on an error or left no message is a round, any other is
 * analysed.
 */
export function stepOf(
  recovery: Pick<LoopState.Recovery, "boundary" | "step">,
  boundary: Pick<LoopHost.Boundary, "message" | "turn">,
): StopCondition.RecoveryStep {
  if (recovery.step !== undefined && recovery.boundary === keyOf(boundary)) return recovery.step
  return boundary.turn.type === "error" || boundary.message === undefined ? "round" : "analysis"
}

/** The provider failure a boundary's turn ended on, when it ended on one and the error is on record. */
export function turnFailure(boundary: LoopHost.Boundary, now: number): StopCondition.Failure | undefined {
  if (boundary.turn.type !== "error" || boundary.error === undefined) return undefined
  return StopCondition.failureOf(boundary.error.error, boundary.error.provider, now)
}

/** What a committed analysis tells `evaluate`. A result the validator accepted always names its basis message. */
export function toAnalysis(
  verdict: LoopVerdict,
  advanced: boolean,
  basis: string | undefined,
): StopCondition.Analysis | undefined {
  if (verdict === "continue") return { type: "continue", advanced }
  if (verdict === "done") return { type: "done" }
  if (verdict === "blocked") return { type: "blocked" }
  if (basis === undefined) return undefined
  return { type: verdict, basis_message_id: basis }
}

export const analysisOf = (result: LoopAnalysisResult) =>
  toAnalysis(result.verdict, result.progress.advanced, result.intent_change.basis_message_id)

/** The stop a `stop` verdict carries, without the `type` that tags the verdict. */
export function stopOf(verdict: Extract<StopCondition.Verdict, { readonly type: "stop" }>): Stop {
  const { type: _type, ...stop } = verdict
  return stop as Stop
}

/** A wait seen at `now`: what `evaluate` needs, and the reason to tell the agent when it has ended. */
export function waitingOf(
  wait: LoopState.Wait,
  now: number,
  health: LoopHost.Health,
): { readonly waiting: StopCondition.Waiting; readonly reason: string } {
  const label = `${wait.source}:${wait.ref?.id ?? wait.wait_id}`
  const timedOut = now >= wait.deadline
  const spent = wait.wakes >= wait.max_wakes
  const reason = !health.alive
    ? health.reason
    : timedOut
      ? `Waiting for ${label} timed out.`
      : spent
        ? `Waiting for ${label} used up its wakes.`
        : ""
  return {
    waiting: { alive: health.alive, expired: timedOut || spent || !health.alive, reviewed: wait.reviewed },
    reason,
  }
}

/**
 * An event names the identity of what it concerns. A wait wakes only for the registered source and one of its
 * identities, so an unrelated watch or job cannot consume it. A `pr_watch` reference is woken by the watch
 * source only; a `job` reference by either source (the rule goal waits already followed).
 */
export interface WakeMatch {
  readonly source: LoopState.WaitSource
  readonly ids: ReadonlyArray<string>
}

export function wakeMatches(wait: LoopState.Wait, match: WakeMatch): boolean {
  const target = wait.ref?.id ?? wait.wait_id
  const source =
    wait.ref === undefined
      ? wait.source === match.source
      : wait.ref.domain === "pr_watch"
        ? match.source === "watch_pr"
        : true
  return source && match.ids.includes(target)
}

/**
 * Whether the analysis of this boundary follows a round that counts (L17). Only the first analysis after a
 * round began counts, and not when that boundary is a human turn, except the first round, which a human
 * message starts. A user turn in a waiting loop, or the turn of another automation, does not move the streak.
 * `lastAnalysisRound` is the round of the latest committed analysis, 0 before the first.
 */
export function followsCountedRound(
  state: Pick<LoopState.Info, "round">,
  lastAnalysisRound: number,
  boundary: Pick<LoopHost.Boundary, "humanTurn">,
): boolean {
  if (state.round <= lastAnalysisRound) return false
  return !boundary.humanTurn || (state.round === 1 && lastAnalysisRound === 0)
}

/** The streak a commit leaves, or `undefined` to keep the stored one. */
export function streakAfter(current: number, counted: boolean, advanced: boolean): number | undefined {
  if (!counted) return undefined
  return advanced ? 0 : current + 1
}

/** What the agent declared, as the analysis reads it. */
export function declarationOf(state: LoopState.Info): LoopInput.Declaration | undefined {
  const declaration = state.declaration
  if (declaration === undefined) return undefined
  if (declaration.kind === "done") return { kind: "done", text: declaration.evidence }
  if (declaration.kind === "blocked") return { kind: "blocked", text: declaration.reason }
  const wait = state.wait
  const awaited = wait === undefined ? "an external object" : `${wait.source}:${wait.ref?.id ?? wait.wait_id}`
  return { kind: "await", text: wait?.payload === undefined ? awaited : `${awaited} (${wait.payload})` }
}

/** The state after the first committed analysis, as `LoopInput` takes it. Absent before it. */
export function priorOf(
  state: LoopState.Info,
  rows: ReadonlyArray<LoopState.AnalysisRow>,
): LoopInput.Prior | undefined {
  const first = state.origin.analysis
  if (first === undefined || state.intent === undefined || state.progress === undefined) return undefined
  const prompt = rows.at(-1)?.prompt
  return {
    firstAnalysis: first,
    intent: state.intent,
    progress: state.progress,
    ...(prompt !== undefined && prompt !== null ? { prompt } : {}),
    recent: rows.flatMap((row) =>
      Schema.is(LoopVerdict)(row.verdict) ? [{ verdict: row.verdict, reason: row.reason }] : [],
    ),
  }
}

export interface Facts {
  readonly state: LoopState.Info
  readonly boundary: LoopHost.Boundary
  /** Human messages since the last committed analysis. */
  readonly humans: number
  readonly failure?: StopCondition.Failure
  readonly waiting?: StopCondition.Waiting
  readonly runningWaitable: boolean
  readonly analysis?: StopCondition.Analysis
  readonly chain: StopCondition.Chain
  /**
   * A decision after a resume sees only the analysis result and the counts. The turn, the rejection, the hook
   * and the declaration of the boundary it stopped at were handled when it stopped, and must not stop it again.
   */
  readonly masked: boolean
}

/** The normalized signals of one boundary, the input of `StopCondition.evaluate`. */
export function inputOf(facts: Facts): StopCondition.Input {
  const { state, boundary, masked } = facts
  const declaration = masked ? undefined : state.declaration?.kind
  return {
    ...(!masked && boundary.hookStop !== undefined ? { hook_stop: boundary.hookStop } : {}),
    ...(!masked && boundary.userRejected ? { user_rejected: true } : {}),
    ...(!masked ? { turn: boundary.turn } : {}),
    human_turn: !masked && boundary.humanTurn,
    ...(facts.failure !== undefined ? { failure: facts.failure } : {}),
    new_human_message: facts.humans > 0,
    ...(declaration !== undefined ? { declaration } : {}),
    ...(facts.waiting !== undefined ? { waiting: facts.waiting } : {}),
    review_round: state.wait?.reviewed === true,
    running_waitable: facts.runningWaitable,
    ...(facts.analysis !== undefined ? { analysis: facts.analysis } : {}),
    round: state.round,
    max_rounds: state.max_rounds,
    no_progress_streak: state.no_progress_streak,
    chain: facts.chain,
  }
}

/** The signals of a user action or an archive: none of the boundary's, only the counts. */
export function actionInput(
  state: LoopState.Info,
  signal: Pick<StopCondition.Input, "user_action" | "archived">,
): StopCondition.Input {
  return {
    ...signal,
    human_turn: false,
    new_human_message: false,
    review_round: false,
    running_waitable: false,
    round: state.round,
    max_rounds: state.max_rounds,
    no_progress_streak: state.no_progress_streak,
    chain: ZERO_CHAIN,
  }
}

export * as LoopDecision from "./decision"
