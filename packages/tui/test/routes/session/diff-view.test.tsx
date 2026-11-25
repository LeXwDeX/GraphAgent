// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { diffView, sessionContentWidth, SPLIT_DIFF_MIN_CONTENT_WIDTH } from "../../../src/routes/session/diff-view"
import { createFixture } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"
import { settleHighlights } from "../../perf/scenarios"
import { readFrame } from "../dag-mode-harness"

/**
 * The split-diff threshold (#1032 6). The drawer no longer takes 42 columns from the transcript, so the content width
 * is the terminal width less 4 whether it is open or not, and an edit diff splits once that is wider than 120.
 */

const view = (terminal: number, style?: string) => diffView(style, sessionContentWidth(terminal))

test("the content width is the terminal less its margin, with nothing reserved for the drawer", () => {
  expect(SPLIT_DIFF_MIN_CONTENT_WIDTH).toBe(120)
  for (const width of [100, 124, 125, 166, 167, 200]) expect(sessionContentWidth(width)).toBe(width - 4)
})

test("a diff splits from a 125-column terminal up", () => {
  expect(view(100)).toBe("unified")
  expect(view(124)).toBe("unified")
  expect(view(125)).toBe("split")
  expect(view(166)).toBe("split")
  expect(view(167)).toBe("split")
  expect(view(200)).toBe("split")
  expect(view(125, "auto")).toBe("split")
})

test("stacked keeps one column at every width", () => {
  for (const width of [100, 124, 125, 166, 167, 200]) expect(view(width, "stacked")).toBe("unified")
})

const OLD_LINE = "const answer = 41"
const NEW_LINE = "const answer = 42"
const DIFF = [
  "Index: src/answer.ts",
  "===================================================================",
  "--- src/answer.ts",
  "+++ src/answer.ts",
  "@@ -1,3 +1,3 @@",
  " export function value() {",
  `-  ${OLD_LINE}`,
  `+  ${NEW_LINE}`,
  " }",
  "",
].join("\n")

/** The perf fixture cut down to its text part and one completed edit call, whose row opens to a diff block. */
function editTranscript() {
  const fixture = createFixture("S")
  const call = fixture.parts.find((part) => part.type === "tool" && part.state.status === "completed")
  if (!call || call.type !== "tool" || call.state.status !== "completed") throw new Error("no completed tool call")
  call.tool = "edit"
  call.state.input = { filePath: "src/answer.ts", oldString: OLD_LINE, newString: NEW_LINE }
  call.state.metadata = { diff: DIFF }
  fixture.messages = fixture.messages.filter(
    (entry) => entry.info.role === "user" || entry.parts.some((part) => part.id === call.id),
  )
  return fixture
}

/**
 * Renders at `width` and returns the frame once the diff has re-laid out. Time only moves on the harness's manual
 * clock; the one wait is for the highlighter worker, which `settleHighlights` bounds without sleeping.
 */
async function diffAt(harness: PerfHarness, width: number) {
  harness.app.resize(width, 30)
  await harness.app.renderOnce()
  harness.clock.advance(100)
  await settleHighlights(harness)
  const frame = await readFrame(harness.app)
  if (!frame.includes(OLD_LINE) || !frame.includes(NEW_LINE)) throw new Error(`the diff is not on screen:\n${frame}`)
  return frame
}

/** A split diff puts the removed and the added line on the same row; a unified one on two rows. */
function split(frame: string) {
  return frame.split("\n").some((row) => row.includes(OLD_LINE) && row.includes(NEW_LINE))
}

test("an edit in the session shows a unified diff at 124 columns and a split one at 125", async () => {
  const harness = await mountHarness(editTranscript())
  try {
    // The row of an edit starts with its diff open (#1614), and the width decides how it is laid out.
    await harness.app.renderOnce()
    expect(split(await diffAt(harness, 124))).toBe(false)
    expect(split(await diffAt(harness, 125))).toBe(true)
    expect(split(await diffAt(harness, 167))).toBe(true)
  } finally {
    await harness.dispose()
  }
})
