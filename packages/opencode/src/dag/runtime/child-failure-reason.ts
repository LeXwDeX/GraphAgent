// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SessionV1 } from "@opencode-ai/core/v1/session"

type AssistantError = Extract<SessionV1.Info, { role: "assistant" }>["error"]

export function childFailureReason(base: string, error: AssistantError): string {
  if (!error) return base
  // Copy only the persisted error discriminant, never provider or tool payloads.
  if (error.name === "MessageAbortedError") {
    return `${base} (${error.name}): child session interrupted, interrupt source unknown; manual recovery only after checking side effects`
  }
  return `${base} (${error.name})`
}
