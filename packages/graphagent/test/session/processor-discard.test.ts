// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Logger } from "effect"
import { discardFailedText } from "@/session/processor-discard"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_discard")
const messageID = MessageID.make("msg_discard")

const textPart = (id: string, text: string): SessionV1.TextPart => ({
  id: PartID.make(id),
  messageID,
  sessionID,
  type: "text",
  text,
})

function run(input: {
  attempt: { textParts: Set<PartID> }
  displayParts: SessionV1.TextPart[]
  displaySegments: Array<{ part: SessionV1.TextPart; length: number }>
}) {
  const removed: string[] = []
  const logs: string[] = []
  const logger = Logger.make((options) => logs.push(JSON.stringify(options.message)))
  const session = {
    removePart: (part: { sessionID: SessionID; messageID: MessageID; partID: PartID }) =>
      Effect.sync(() => {
        expect(part.sessionID).toBe(sessionID)
        expect(part.messageID).toBe(messageID)
        removed.push(part.partID)
        return part.partID
      }),
  }
  return Effect.runPromise(
    discardFailedText({ session, ctx: { sessionID, assistantMessage: { id: messageID }, ...input }, ...input }).pipe(
      Effect.withLogger(logger),
    ),
  ).then(() => ({ removed, logs }))
}

describe("discardFailedText", () => {
  test("removes the attempt's text parts, filters the display queues in place and logs once", async () => {
    const kept = textPart("prt_discard_kept", "accepted")
    const first = textPart("prt_discard_first", "half")
    const second = textPart("prt_discard_second", "written")
    const attempt = { textParts: new Set([first.id, second.id]) }
    const displayParts = [kept, first, second]
    const keptSegment = { part: kept, length: 8 }
    const displaySegments = [{ part: first, length: 4 }, keptSegment, { part: second, length: 7 }]

    const { removed, logs } = await run({ attempt, displayParts, displaySegments })

    expect(removed).toEqual([first.id, second.id])
    expect(displayParts).toEqual([kept])
    expect(displaySegments).toEqual([keptSegment])
    expect(attempt.textParts.size).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("failed attempt text discarded")
    expect(logs[0]).toContain('"parts":2')
    expect(logs[0]).toContain(messageID)
  })

  test("does nothing, and logs nothing, when the attempt wrote no text", async () => {
    const kept = textPart("prt_discard_other", "accepted")
    const displayParts = [kept]
    const displaySegments = [{ part: kept, length: 8 }]

    const { removed, logs } = await run({ attempt: { textParts: new Set() }, displayParts, displaySegments })

    expect(removed).toEqual([])
    expect(logs).toEqual([])
    expect(displayParts).toEqual([kept])
    expect(displaySegments).toHaveLength(1)
  })
})
