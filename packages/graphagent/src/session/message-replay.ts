// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { AbortedError, type SessionV1 } from "@graphagent/core/v1/session"

/**
 * A tool call with a recorded result: it completed, or it ended in an error, unless the provider executed the call
 * itself.
 */
function settledTool(part: SessionV1.Part): boolean {
  if (part.type !== "tool") return false
  if (part.state.status === "completed") return true
  return part.state.status === "error" && part.metadata?.providerExecuted !== true
}

/**
 * The parts of a message the model reads:
 * - a user message, or an assistant message without an error, keeps every part;
 * - an assistant message that ended in an abort keeps every part when any is neither step-start nor reasoning,
 *   otherwise none;
 * - an assistant message that ended in another error keeps the prefix up to its last settled tool call, without the
 *   unsettled tool calls inside it. The text, reasoning and tool calls after that call are dropped, and nothing is
 *   kept when no tool call settled.
 */
export function replayParts(message: SessionV1.WithParts): SessionV1.Part[] {
  if (message.info.role !== "assistant" || !message.info.error) return message.parts
  if (AbortedError.isInstance(message.info.error))
    return message.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning") ? message.parts : []
  const end = message.parts.findLastIndex(settledTool)
  if (end < 0) return []
  return message.parts.slice(0, end + 1).filter((part) => part.type !== "tool" || settledTool(part))
}

/**
 * Whether any part of the message reaches the model wire: always for a user message or an assistant message without
 * an error; for one that ended in an error, when `replayParts` keeps something (an abort with content, or a settled
 * tool call).
 */
export function isReplayableAssistantMessage(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "assistant" || !message.info.error) return true
  return replayParts(message).length > 0
}

/**
 * The runtime note that follows an assistant step that ended in an error: the name is the stored `error.name`, and
 * the HTTP status is added only for an `APIError` that has one. The error text stays out of it.
 */
export function interruptionNote(error: NonNullable<SessionV1.Assistant["error"]>): string {
  const status =
    error.name === "APIError" && error.data.statusCode !== undefined ? `, HTTP ${error.data.statusCode}` : ""
  return `The previous assistant step ended with an error (${error.name}${status}). Tool calls from that step keep the results recorded for them; a result that says the call was aborted means it did not finish. The rest of that step was lost. Check the current state before repeating any work.`
}
