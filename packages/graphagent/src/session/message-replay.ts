// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { AbortedError, type SessionV1 } from "@graphagent/core/v1/session"

/**
 * Assistant messages with a provider-level error are omitted from the model wire unless the error is an abort that
 * still carries replayable content.
 */
export function isReplayableAssistantMessage(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "assistant" || !message.info.error) return true
  return (
    AbortedError.isInstance(message.info.error) &&
    message.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
  )
}
