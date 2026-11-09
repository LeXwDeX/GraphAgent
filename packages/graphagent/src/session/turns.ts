// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionAdmission } from "@graphagent/core/session/admission"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { Effect } from "effect"
import type { RewakeToken } from "@/hook"

export interface AdmissionOptions {
  /** Internal follow-ups retain the current input's tool budget. */
  readonly continueToolBudget?: boolean
  /** A previously persisted followup is already past initial-hook admission. */
  readonly skipHookStart?: boolean
  /**
   * Task and DAG runtimes feeding their own child session (initial prompt, Stop continuation, nudge, recovery).
   * Such input is not a user submission, so UserPromptSubmit does not run. Never part of a public body: only
   * runtime callers set it, and a persisted hook followup carries it in `HookPendingInput.internalDelegation`.
   * A report back to a parent session, a DAG wake, a goal continuation and agent messages are not delegation.
   */
  readonly internalDelegation?: true
  /**
   * SettingsHook rewake token riding on an async Stop-hook rewake. When set,
   * admission re-validates the chain before commit and the run path
   * re-validates before runLoop, refusing callbacks whose chain was reset
   * (cancel, newer prompt, SessionEnd) after their completion check. Only the
   * hook rewake paths set this; plain user prompts never do.
   */
  readonly rewakeToken?: RewakeToken
}

/** Admission-guarded commit: fails with Blocked when the session was cancelled first. */
export type AdmissionCommit = <B, E, R>(
  body: Effect.Effect<B, E, R>,
) => Effect.Effect<B, E | SessionAdmission.Blocked, R>

/** Result of admitting one prompt: the persisted message and whether a turn should run. */
export interface Admission {
  readonly message: SessionV1.WithParts
  readonly run: boolean
}

export interface IdleAdmission {
  readonly activate: Effect.Effect<void>
  readonly result: Effect.Effect<SessionV1.WithParts>
  readonly abort: Effect.Effect<void>
}

/** Model selection captured before a command's persistent write, used to detect a later switch. */
export interface ModelSelection {
  readonly providerID: string | undefined
  readonly modelID: string | undefined
  readonly variant: string | undefined
}

export type ModelBaseline = ModelSelection & { readonly epoch: number | undefined }

export * as Turns from "./turns"
