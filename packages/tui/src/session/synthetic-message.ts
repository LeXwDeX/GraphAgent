// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a user message is one the user wrote (#1408). The server also adds user messages of its own: the result of
 * a finished background run (#1058) and the text a command leaves for the model, each a text part marked `synthetic`.
 * What undo and redo, the jump to the last user message and the PR tracker's "the user spoke" mean by the user's
 * message is every user message that is not one of those, so they all ask this one function. Pure: the parts come in
 * as an argument.
 */

/** What the judgement reads of a part: its type, and for a text part whether the server wrote it. */
export interface MessagePartLike {
  readonly type: string
  readonly synthetic?: boolean
}

/**
 * A message is synthetic when it has text and every text part of it is synthetic. One with a text part of its own
 * among synthetic ones is the user's, and so is one with no text part at all (a file alone, a compaction): nothing in
 * it says the server wrote it. A message arrives before its parts, and there is nothing to judge until they do: that
 * is the caller's to handle, and an empty list is a message with no text.
 */
export function isSyntheticMessage(parts: readonly MessagePartLike[]): boolean {
  let text = false
  for (const part of parts) {
    if (part.type !== "text") continue
    if (part.synthetic !== true) return false
    text = true
  }
  return text
}
