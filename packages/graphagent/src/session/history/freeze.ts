// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"

/**
 * A model-visible history slice whose transcript contract is frozen at runtime:
 * the slice array, each message, `info`, `info.time`, the `parts` array, each
 * part, and every nested metadata object the conversion can read. The request
 * path derives reminders and consumed markers as copies, so an accidental
 * in-place edit throws here instead of silently diverging from the stored
 * transcript or from a cached model fragment.
 *
 * Lives in its own module so the write-through cache and the session view share
 * one implementation without importing each other.
 */
export type FrozenHistory = SessionV1.WithParts[]

function deepFreeze(value: unknown, seen: WeakSet<object>) {
  if (!value || typeof value !== "object") return
  if (seen.has(value)) return
  seen.add(value)
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
}

export function freeze(history: SessionV1.WithParts[]): FrozenHistory {
  const seen = new WeakSet<object>()
  for (const message of history) deepFreeze(message, seen)
  Object.freeze(history)
  return history
}

export * as HistoryFreeze from "./freeze"
