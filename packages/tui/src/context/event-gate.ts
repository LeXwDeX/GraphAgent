// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "@graphagent/sdk"

/**
 * Client-side mirror of the worker's event table (#1013 5.6, #886 5.1).
 *
 * The worker already filters by the interest set, but the TUI keeps the same
 * gate as a defence: an event that reaches the main thread for a session
 * without full interest must still not write message or part state.
 */
export type EventScope = "global" | "session-summary" | "session-full"
export type GateDecision = "deliver" | "summary" | "drop"

const SESSION_FULL_TYPES = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "message.part.preview",
  "todo.updated",
  "session.diff",
  "session.hook.status",
  "session.hook.terminal",
  "session.hook.message",
  "dag.workflow.nodes.updated",
])

const SESSION_SUMMARY_TYPES = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.interacted",
  "question.timed_out",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "question.v2.interacted",
  "question.v2.timed_out",
  "goal.updated",
  "goal.cleared",
  "dag.workflow.summary.updated",
])

/** Unlisted event types default to `global`, matching the schema inventory. */
export function eventScope(type: string): EventScope {
  if (SESSION_FULL_TYPES.has(type)) return "session-full"
  if (SESSION_SUMMARY_TYPES.has(type)) return "session-summary"
  return "global"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sessionIDOf(event: Event): string | undefined {
  const properties: unknown = event.properties
  if (!isRecord(properties)) return undefined
  if (typeof properties.sessionID === "string") return properties.sessionID
  const info = properties.info
  if (isRecord(info)) {
    if (typeof info.sessionID === "string") return info.sessionID
    if (typeof info.id === "string") return info.id
  }
  const part = properties.part
  if (isRecord(part) && typeof part.sessionID === "string") return part.sessionID
  return undefined
}

export function scopeOf(event: Event): { scope: EventScope; sessionID?: string } {
  return { scope: eventScope(event.type), sessionID: sessionIDOf(event) }
}

/**
 * `fullSessions` is the effective interest set: explicit interest plus the
 * sessions with an unanswered permission or question.
 */
export function createEventGate(fullSessions: () => ReadonlySet<string>) {
  return (event: Event): GateDecision => {
    const { scope, sessionID } = scopeOf(event)
    if (scope !== "session-full") return "deliver"
    if (sessionID && fullSessions().has(sessionID)) return "deliver"
    if (event.type === "message.part.updated") {
      if (event.properties.part.type === "tool") return "summary"
    }
    return "drop"
  }
}
