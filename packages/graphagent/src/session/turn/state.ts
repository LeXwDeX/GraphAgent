// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionV1 } from "@graphagent/core/v1/session"

/**
 * Pure turn state for the session loop (Issue #1019, PR7).
 *
 * Every mutable flag the old `runLoopImpl` kept in closure variables lives here
 * instead, and every update goes through a pure reducer below. The decision
 * layer (`decide.ts`) reads this state but never mutates it; the loop applies
 * reducer results in statement order so the observable behavior matches the
 * pre-refactor code exactly.
 */

/**
 * How far the input owner (a DAG parent, task owner, or the mailbox freeze)
 * lets late input extend this turn.
 *
 * - `open`: no special grant or block.
 * - `boundary_approved`: a Stop exit found queued agent input and granted one
 *   more boundary crossing before the next model step.
 * - `blocked`: the input owner froze this turn; new input cannot extend it.
 */
export type AgentInputState = "open" | "boundary_approved" | "blocked"

export interface StopState {
  /** `stop_hook_active` carried into the next Stop decision. */
  readonly active: boolean
  /** Consecutive Stop-block continuations without intervening tool work. */
  readonly continuations: number
  /** Injected upper bound from `SettingsHook.stopHookBlockCap()`. */
  readonly cap: number
}

export interface TurnState {
  /** Model-step counter for this loop invocation. */
  readonly step: number
  /** Structured-output result of the current model step, cleared before each request. */
  readonly structured: unknown
  /** Assistant error that ended the last turn; drives Stop vs StopFailure and blocks continuation. */
  readonly error: SessionV1.Assistant["error"] | undefined
  /** The previous processor outcome was `break` (finished or blocked). */
  readonly stopped: boolean
  readonly agentInput: AgentInputState
  readonly stop: StopState
  /** Consecutive automatic compactions; the fourth is refused. */
  readonly compactions: number
  /**
   * One-shot grant to skip the finished exit and run exactly one more model
   * step. Replaces the old `forceContinue` flag; consumed by `beginStep`.
   */
  readonly continuing: "stop_block" | undefined
}

export function initial(input: { stopCap: number }): TurnState {
  return {
    step: 0,
    structured: undefined,
    error: undefined,
    stopped: false,
    agentInput: "open",
    stop: { active: false, continuations: 0, cap: input.stopCap },
    compactions: 0,
    continuing: undefined,
  }
}

export function incrementStep(state: TurnState): TurnState {
  return { ...state, step: state.step + 1 }
}

export function setStructured(state: TurnState, structured: unknown): TurnState {
  return { ...state, structured }
}

export function clearStructured(state: TurnState): TurnState {
  return { ...state, structured: undefined }
}

export function markStopped(state: TurnState): TurnState {
  return { ...state, stopped: true }
}

export function clearStopped(state: TurnState): TurnState {
  return { ...state, stopped: false }
}

/**
 * Record the settled attempt. The old loop assigned `turnStopped = outcome ===
 * "break"` and only replaced `turnError` on a break.
 */
export function afterAttempt(
  state: TurnState,
  input: { readonly broke: boolean; readonly error: SessionV1.Assistant["error"] | undefined },
): TurnState {
  return { ...state, stopped: input.broke, error: input.broke ? input.error : state.error }
}

export function blockAgentInput(state: TurnState): TurnState {
  if (state.agentInput === "blocked") return state
  return { ...state, agentInput: "blocked" }
}

/** The freeze attempt consumed any pending boundary approval (matches the old unconditional reset). */
export function clearBoundaryApproval(state: TurnState): TurnState {
  if (state.agentInput !== "boundary_approved") return state
  return { ...state, agentInput: "open" }
}

/** A Stop block granted another model turn: arm `stop_hook_active` and the one-shot continuation. */
export function continueFromStopBlock(state: TurnState): TurnState {
  return {
    ...state,
    continuing: "stop_block",
    stop: { ...state.stop, active: true, continuations: state.stop.continuations + 1 },
  }
}

/** A Stop exit found queued input: allow one more boundary crossing and clear the stopped marker. */
export function continueFromQueuedInput(state: TurnState): TurnState {
  return { ...state, agentInput: "boundary_approved", stopped: false }
}

/** A model step starts: consume the one-shot continuation and clear the settled break marker. */
export function beginStep(state: TurnState): TurnState {
  return { ...state, continuing: undefined, stopped: false }
}

export function resetStopContinuations(state: TurnState): TurnState {
  return { ...state, stop: { ...state.stop, continuations: 0 } }
}

export function recordAutoCompaction(state: TurnState): TurnState {
  return { ...state, compactions: state.compactions + 1 }
}

export function resetAutoCompactions(state: TurnState): TurnState {
  if (state.compactions === 0) return state
  return { ...state, compactions: 0 }
}

export * as State from "./state"
