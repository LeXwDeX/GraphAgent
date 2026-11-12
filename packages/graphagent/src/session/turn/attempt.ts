// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionV1 } from "@graphagent/core/v1/session"
import type { PartID } from "../schema"

/**
 * Attempt-scoped state of the session processor (Issue #1019, PR-b).
 *
 * An attempt is one provider stream: the first request of a `process()` call,
 * or a retry after a recognized failure. The processor used to reset these
 * sixteen fields one by one at the top of every attempt, so a field added
 * without its reset line leaked the previous attempt's value into the next
 * one. They now live in one object and `beginAttempt` replaces it as a whole:
 * a new field cannot be forgotten, and the leak test enumerates every key.
 *
 * Deliberately not part of an attempt: `toolcalls` (severed when a retry
 * settles and at cleanup), `blocked`, `needsCompaction` and `shouldBreak`
 * (the retry gate reads them across attempts), `snapshot`, `stepToolActivity`
 * (reset by `step-start`) and `recentToolSignatures` (the doom-loop window
 * spans the whole handle). Resetting those at an attempt boundary would change
 * behavior.
 */
export interface AttemptState {
  /** Text part streamed by this attempt that has not ended yet. */
  openText: SessionV1.TextPart | undefined
  /** Provider stream id of `openText`. */
  openTextID: string | undefined
  /** Open reasoning parts by the provider's stream-local id. */
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  /** A tool call admission/result/error signal was seen in the current stream. */
  anyToolCalled: boolean
  /** Tool-call events admitted in the current stream (repair artifacts included). */
  admittedToolCalls: number
  /**
   * Tool calls admitted by a tool-call event whose execution has not been
   * confirmed (no real result/error yet). Conservatively treated as executed:
   * an in-flight async execute may still be running after the stream drains.
   */
  pendingToolExecutions: Set<string>
  /** Finish reason of the current attempt only (assistant.finish persists across attempts). */
  finish: string | undefined
  /** Sum of text-delta lengths in the current attempt; zero means no visible text. */
  textLength: number
  /** Sum of reasoning-delta lengths in the current attempt; zero means no visible reasoning. */
  reasoningLength: number
  /** Includes opaque-only reasoning parts and orphan reasoning deltas. */
  reasoningActivity: boolean
  /** Nonempty provider metadata can carry encrypted reasoning without text. */
  opaqueReasoning: boolean
  /** Persisted reasoning from this attempt must be removed if it fails. */
  reasoningParts: Set<PartID>
  /**
   * Any tool input/call/result/error signal was observed in the current
   * attempt. Input-level signals count even without an admitted tool call so
   * a stream that only produced tool input never takes the empty path; the
   * separate #773 admission gate still owns its own executable-call rules.
   */
  toolActivity: boolean
  /**
   * The adapter marked the current attempt's finish metadata with
   * `graphagent.suppressedActivity`: provider activity that is not
   * session-visible (files, sources, approvals, denials, aborts). Such an
   * attempt is never treated as an empty response.
   */
  suppressedActivity: boolean
  /** Suppressed abort/approval/denial or unknown activity forbids replay. */
  retryBlockingSuppressedActivity: boolean
  /** Why the retry gate stopped this attempt, when tool work made replay unsafe. */
  retryBlockedBy: "pending-tools" | "tool-executed" | undefined
}

/** Fresh state for one attempt. Every call returns new containers; nothing is shared between attempts. */
export function initialAttemptState(): AttemptState {
  return {
    openText: undefined,
    openTextID: undefined,
    reasoningMap: {},
    anyToolCalled: false,
    admittedToolCalls: 0,
    pendingToolExecutions: new Set(),
    finish: undefined,
    textLength: 0,
    reasoningLength: 0,
    reasoningActivity: false,
    opaqueReasoning: false,
    reasoningParts: new Set(),
    toolActivity: false,
    suppressedActivity: false,
    retryBlockingSuppressedActivity: false,
    retryBlockedBy: undefined,
  }
}

/**
 * Start a new attempt: replace the whole state instead of resetting fields,
 * so state the previous attempt created or mutated can never carry over. The
 * previous object is dropped untouched, so anything still holding it observes
 * the old attempt unchanged.
 */
export function beginAttempt(owner: { attempt: AttemptState }): void {
  owner.attempt = initialAttemptState()
}

export * as Attempt from "./attempt"
