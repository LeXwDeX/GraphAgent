// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { FilePart, TextPart, UserMessage } from "@graphagent/sdk"
import { isQueuedMessage, queuedMessageExpected } from "../../../src/routes/session/queued-message"

const user = (input: { id: string; created: number; consumed?: number }) =>
  ({
    id: input.id,
    sessionID: "ses_test",
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: input.created, consumed: input.consumed },
  }) satisfies UserMessage

describe("queued message actions", () => {
  test("shows actions only after the pending assistant and before admission", () => {
    const pending = { id: "msg_b", time: { created: 1 } }
    expect(isQueuedMessage(user({ id: "msg_c", created: 1 }), pending)).toBeTrue()
    expect(isQueuedMessage(user({ id: "msg_a", created: 1 }), pending)).toBeFalse()
    expect(isQueuedMessage(user({ id: "msg_c", created: 1, consumed: 2 }), pending)).toBeFalse()
  })

  test("captures an immutable stale-check snapshot including attachments", () => {
    const text: TextPart = {
      id: "prt_text",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "text",
      text: "queued",
    }
    const file: FilePart = {
      id: "prt_file",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "file",
      mime: "text/plain",
      url: "data:,x",
    }
    const expected = queuedMessageExpected([text, file])

    text.text = "changed later"
    expect(expected).toEqual({
      partID: "prt_text",
      expectedText: "queued",
      expectedPartIDs: ["prt_text", "prt_file"],
    })
  })

  test("rejects ambiguous or synthetic text", () => {
    const first: TextPart = {
      id: "prt_1",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "text",
      text: "one",
    }
    const second: TextPart = { ...first, id: "prt_2", text: "two" }
    const synthetic: TextPart = { ...first, id: "prt_3", text: "hidden", synthetic: true }
    expect(queuedMessageExpected([first, second])).toBeUndefined()
    expect(queuedMessageExpected([synthetic])).toBeUndefined()
  })
})
