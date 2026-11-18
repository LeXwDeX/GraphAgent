// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import type { CompactionPart, FilePart, Part, TextPart } from "@graphagent/sdk"
import { isSyntheticMessage } from "../../src/session/synthetic-message"

// The one judgement undo and redo, the jump to the last user message and the PR tracker share (#1408), on the parts
// the SDK gives the store: a message is synthetic when it has text and every text part of it is.

const base = { sessionID: "ses_synthetic", messageID: "msg_synthetic" }

function text(id: string, extra: Partial<TextPart> = {}): TextPart {
  return { ...base, id, type: "text", text: `text ${id}`, ...extra }
}

const file: FilePart = { ...base, id: "prt_file", type: "file", mime: "image/png", url: "file:///shot.png" }
const compaction: CompactionPart = { ...base, id: "prt_compaction", type: "compaction", auto: false }

test("a message whose text is all synthetic is synthetic: a background result, the text a command leaves for the model", () => {
  expect(isSyntheticMessage([text("prt_1", { synthetic: true })])).toBe(true)
  expect(isSyntheticMessage([text("prt_1", { synthetic: true }), text("prt_2", { synthetic: true })])).toBe(true)
  // The result of a background run says so in its metadata; the judgement does not need it.
  const result = text("prt_result", {
    synthetic: true,
    metadata: { backgroundResult: { childSessionID: "ses_child" } },
  })
  expect(isSyntheticMessage([result])).toBe(true)
})

test("one text part of the user's among synthetic ones makes the message the user's, wherever it stands", () => {
  expect(isSyntheticMessage([text("prt_1", { synthetic: true }), text("prt_2")])).toBe(false)
  expect(isSyntheticMessage([text("prt_1"), text("prt_2", { synthetic: true })])).toBe(false)
  // A part that says `synthetic: false` is the user's like one that says nothing.
  expect(isSyntheticMessage([text("prt_1", { synthetic: false })])).toBe(false)
  expect(isSyntheticMessage([text("prt_1")])).toBe(false)
})

test("a message with no text part is not synthetic: nothing in it says the server wrote it", () => {
  expect(isSyntheticMessage([])).toBe(false)
  expect(isSyntheticMessage([file])).toBe(false)
  expect(isSyntheticMessage([compaction])).toBe(false)
})

test("parts that are not text neither make a message synthetic nor keep it from being one", () => {
  expect(isSyntheticMessage([file, text("prt_1", { synthetic: true })])).toBe(true)
  expect(isSyntheticMessage([text("prt_1", { synthetic: true }), file, compaction])).toBe(true)
  expect(isSyntheticMessage([file, text("prt_1")])).toBe(false)
})

test("ignored is not read: it says a part is shown and not sent, not who wrote it", () => {
  expect(isSyntheticMessage([text("prt_1", { ignored: true })])).toBe(false)
  expect(isSyntheticMessage([text("prt_1", { ignored: true, synthetic: true })])).toBe(true)
})

test("the store's parts are accepted as they are", () => {
  const parts: Part[] = [file, text("prt_1", { synthetic: true })]
  expect(isSyntheticMessage(parts)).toBe(true)
})
