// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SessionV1 } from "@graphagent/core/v1/session"
import { SessionAbortReason } from "@/session/abort-reason"

type AssistantError = Extract<SessionV1.Info, { role: "assistant" }>["error"]

/** Why the DAG runtime interrupted a child session. */
export type ChildAbortReason =
  | "deadline-cap"
  | "deadline-supervision-lost"
  | "control-cancel"
  | "workflow-complete"
  | "workflow-failed"
  | "replan"
  | "attempt-replaced"
  | "failure-cleanup"
  | "runtime-interrupt"
  | "shutdown"
  | "parent-session-deleted"
  | "location-moved"
  | "recovery"
  | "admission-rejected"
  | "admission-error"

/** Which runtime component issued the interruption. */
export type ChildAbortActor =
  | "deadline-watcher"
  | "parent-control"
  | "dag-loop"
  | "dag-replan"
  | "runtime-scope"
  | "recovery"
  | "parent-session"
  | "dag-location"

export function childAbort(reason: ChildAbortReason, actor: ChildAbortActor): SessionAbortReason.Info {
  return SessionAbortReason.make(reason, actor)
}

export function childFailureReason(base: string, error: AssistantError): string {
  if (!error) return base
  // Copy only the persisted error discriminant, never provider or tool payloads.
  if (error.name === "MessageAbortedError") {
    const message = "message" in error.data && typeof error.data.message === "string" ? error.data.message : undefined
    const abort = SessionAbortReason.parse(message)
    if (abort) {
      return `${base} (${error.name}): child session interrupted (reason: ${abort.reason}, actor: ${abort.actor}); manual recovery only after checking side effects`
    }
    if (SessionAbortReason.origin(message) === "provider") {
      return `${base} (${error.name}): child session interrupted (reason: provider-aborted, actor: provider); manual recovery only after checking side effects`
    }
    return `${base} (${error.name}): child session interrupted, interrupt source unknown; manual recovery only after checking side effects`
  }
  return `${base} (${error.name})`
}
