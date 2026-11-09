// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Part, TextPart, UserMessage } from "@graphagent/sdk/v2"

export function orderedBefore(
  a: { id: string; time: { created: number } },
  b: { id: string; time: { created: number } },
) {
  if (a.time.created !== b.time.created) return a.time.created < b.time.created
  return a.id < b.id
}

export function isQueuedMessage(message: UserMessage, pending?: { id: string; time: { created: number } }) {
  return message.time.consumed === undefined && !!pending && orderedBefore(pending, message)
}

export function editableQueuedText(parts: Part[]) {
  const editable = parts.filter((part): part is TextPart => part.type === "text" && !part.synthetic && !part.ignored)
  return editable.length === 1 ? editable[0] : undefined
}

export function queuedMessageExpected(parts: Part[]) {
  const part = editableQueuedText(parts)
  if (!part) return undefined
  return {
    partID: part.id,
    expectedText: part.text,
    expectedPartIDs: parts.map((item) => item.id),
  }
}
