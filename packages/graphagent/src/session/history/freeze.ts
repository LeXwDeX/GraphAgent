// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"

/**
 * A model-visible history slice whose transcript contract is frozen at runtime:
 * the slice array, each message, `info`, `info.time`, the `parts` array, and
 * each part. The request path derives reminders and consumed markers as copies,
 * so an accidental in-place edit throws here instead of silently diverging from
 * the stored transcript. Nested metadata outside that contract stays writable.
 *
 * Lives in its own module so the write-through cache and the session view share
 * one implementation without importing each other.
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

export * as HistoryFreeze from "./freeze"
