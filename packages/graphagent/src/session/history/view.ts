// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { MessageV2 } from "../message-v2"
import { SessionID } from "../schema"

/**
 * A model-visible history slice whose transcript contract is frozen at runtime:
 * the slice array, each message, `info`, `info.time`, the `parts` array, and
 * each part. The request path derives reminders and consumed markers as copies,
 * so an accidental in-place edit throws here instead of silently diverging from
 * the stored transcript. Nested metadata outside that contract stays writable.
 */
export type FrozenHistory = SessionV1.WithParts[]

export function freeze(history: SessionV1.WithParts[]): FrozenHistory {
  for (const message of history) {
    for (const part of message.parts) Object.freeze(part)
    Object.freeze(message.parts)
    Object.freeze(message.info.time)
    Object.freeze(message.info)
    Object.freeze(message)
  }
  Object.freeze(history)
  return history
}

/**
 * Reads the model-visible history without walking messages older than the
 * completed compaction boundary; see [`MessageV2.filterCompactedTail`].
 */
export const tail = Effect.fn("SessionHistory.tail")(function* (sessionID: SessionID) {
  return yield* MessageV2.filterCompactedTail(sessionID)
})

/** Prompts that create model work boundaries; markers and ignored parts do not. */
export function isOrdinaryUser(
  message: SessionV1.WithParts,
): message is SessionV1.WithParts & { info: SessionV1.User } {
  return (
    message.info.role === "user" &&
    !MessageV2.isIgnoredUser(message) &&
    !message.parts.some((part) => part.type === "compaction" || part.type === "subtask")
  )
}

export * as HistoryView from "./view"