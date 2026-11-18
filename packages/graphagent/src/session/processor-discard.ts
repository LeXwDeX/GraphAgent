// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import type { Session } from "./session"
import type { AttemptState } from "./turn/attempt"

/** The slice of the processor context that dropping a failed attempt's text reads. */
export interface DiscardScope {
  readonly sessionID: SessionV1.Assistant["sessionID"]
  readonly assistantMessage: Pick<SessionV1.Assistant, "id">
  readonly attempt: Pick<AttemptState, "textParts">
}

export interface DiscardFailedTextInput {
  readonly session: Pick<Session.Interface, "removePart">
  readonly ctx: DiscardScope
  /** Text parts queued for display; filtered in place. */
  readonly displayParts: SessionV1.TextPart[]
  /** Not yet displayed text, per part; filtered in place. */
  readonly displaySegments: Array<{ part: SessionV1.TextPart; length: number }>
}

function retain<A>(items: A[], keep: (item: A) => boolean) {
  let kept = 0
  for (const item of items) if (keep(item)) items[kept++] = item
  items.length = kept
}

/**
 * The text a failed attempt streamed must not stay in the assistant message:
 * it would sit next to the retry's complete answer and ride along with every
 * later request. Removes the parts the attempt persisted and drops them from
 * the display queues, so the final display flush cannot write one back.
 */
export const discardFailedText = Effect.fn("SessionProcessor.discardFailedText")(function* (
  input: DiscardFailedTextInput,
) {
  const { session, ctx, displayParts, displaySegments } = input
  const discarded = ctx.attempt.textParts
  if (discarded.size === 0) return
  for (const partID of discarded) {
    yield* session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID })
  }
  retain(displayParts, (part) => !discarded.has(part.id))
  retain(displaySegments, (segment) => !discarded.has(segment.part.id))
  yield* Effect.logInfo("failed attempt text discarded", {
    "session.id": ctx.sessionID,
    messageID: ctx.assistantMessage.id,
    parts: discarded.size,
  })
  discarded.clear()
})
