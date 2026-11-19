// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { createFixture, updatePartEvent } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"

const COMMAND = "hover-command"
const PLAIN_COMMAND = "plain-command"

type Located = { row: number; column: number; fg: string }

/** Where `text` is in the frame, and the color it is painted in. */
function locate(harness: PerfHarness, text: string): Located | undefined {
  const frame = harness.app.captureSpans()
  for (let row = 0; row < frame.lines.length; row++) {
    let column = 0
    for (const span of frame.lines[row].spans) {
      const index = span.text.indexOf(text)
      if (index !== -1) return { row, column: column + index, fg: span.fg.toInts().join(",") }
      column += span.text.length
    }
  }
  return undefined
}

async function locateEventually(harness: PerfHarness, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const found = locate(harness, text)
    if (found) return found
    await Bun.sleep(1)
  }
  throw new Error(`row never contained ${text}:\n${harness.app.captureCharFrame()}`)
}

/** A finished bash call at the tail of the last message; `id` sorts after the fixture's own parts. */
function bashPart(harness: PerfHarness, id: string, command: string, output: string): Part {
  return {
    id,
    sessionID: harness.fixture.session.id,
    messageID: harness.fixture.messages.at(-1)!.info.id,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: {
      status: "completed",
      input: { command, workdir: "/tmp/hover" },
      output,
      title: "Hover",
      metadata: { output },
      time: { start: 1, end: 2 },
    },
  }
}

// `M` mounts every row; `XL` is above WINDOW_MIN_ROWS, where hover state belongs to
// the rows that are mounted. The rule is the same in both: the mouse over a row that
// has a click (an output that folds) repaints that row's own arg, a row that has none
// does not answer it, and neither touches the store.
test.each(["M", "XL"] as const)("hover repaints only the clickable row and never writes the store (%s)", async (size) => {
  const harness = await mountHarness(createFixture(size))
  try {
    await harness.reset()
    // The session route scrolls to the last message 50ms after mount.
    await Bun.sleep(60)

    // Twenty lines fold: the row has a click. One line does not: it has none.
    harness.emit(
      updatePartEvent(
        bashPart(harness, "prt_tail_hover_bash", COMMAND, "hover output line\n".repeat(20)),
        1000,
        "evt_tail_hover_bash",
      ),
    )
    harness.emit(updatePartEvent(bashPart(harness, "prt_tail_hover_plain", PLAIN_COMMAND, "one line"), 1001, "evt_tail_hover_plain"))

    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = false
    scroll!.scrollTo(Infinity)
    await harness.app.renderOnce()

    const idle = await locateEventually(harness, COMMAND)
    const plain = await locateEventually(harness, PLAIN_COMMAND)
    const before = harness.snapshot()

    await harness.app.mockMouse.moveTo(idle.column + 1, idle.row)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    const hovered = locate(harness, COMMAND)!
    expect(hovered.fg).not.toBe(idle.fg)
    // Only that row answers: the one beside it, which has no click, is painted as it was.
    expect(locate(harness, PLAIN_COMMAND)!.fg).toBe(plain.fg)

    await harness.app.mockMouse.moveTo(0, 0)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    expect(locate(harness, COMMAND)!.fg).toBe(idle.fg)

    // The mouse over a row that has no click changes nothing.
    await harness.app.mockMouse.moveTo(plain.column + 1, plain.row)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    expect(locate(harness, PLAIN_COMMAND)!.fg).toBe(plain.fg)
    expect(locate(harness, COMMAND)!.fg).toBe(idle.fg)

    const afterHover = harness.snapshot()
    expect(afterHover.storeMessageWrites - before.storeMessageWrites).toBe(0)
    expect(afterHover.storePartWrites - before.storePartWrites).toBe(0)

    const burst = harness.snapshot()
    for (let index = 0; index < 200; index++) await harness.app.mockMouse.moveTo(index % 100, 0)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    const afterBurst = harness.snapshot()
    expect(afterBurst.storeMessageWrites - burst.storeMessageWrites).toBe(0)
    expect(afterBurst.storePartWrites - burst.storePartWrites).toBe(0)
    expect(locate(harness, COMMAND)!.fg).toBe(idle.fg)
  } finally {
    await harness.dispose()
  }
})
