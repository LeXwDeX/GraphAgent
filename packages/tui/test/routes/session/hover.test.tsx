// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { createFixture, updatePartEvent } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"

const EXPECTED_TEXT = "hover output line"

type Located = { row: number; column: number; bg: string }

function locate(harness: PerfHarness, text: string): Located | undefined {
  const frame = harness.app.captureSpans()
  for (let row = 0; row < frame.lines.length; row++) {
    let column = 0
    for (const span of frame.lines[row].spans) {
      const index = span.text.indexOf(text)
      if (index !== -1) return { row, column: column + index, bg: span.bg.toInts().join(",") }
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

// `M` mounts every row; `XL` is above WINDOW_MIN_ROWS, where hover state belongs to
// the rows that are mounted. The rule is the same in both.
test.each(["M", "XL"] as const)("hover repaints only the clickable row and never writes the store (%s)", async (size) => {
  const harness = await mountHarness(createFixture(size))
  try {
    await harness.reset()
    // The session route scrolls to the last message 50ms after mount.
    await Bun.sleep(60)

    const output = `${EXPECTED_TEXT}\n`.repeat(20)
    const part: Part = {
      // Parts sort by id within a message; this one has to land after the fixture's own.
      id: "prt_tail_hover_bash",
      sessionID: harness.fixture.session.id,
      messageID: harness.fixture.messages.at(-1)!.info.id,
      type: "tool",
      callID: "call_hover_bash",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "hover-command", workdir: "/tmp/hover" },
        output,
        title: "Hover",
        metadata: { output },
        time: { start: 1, end: 2 },
      },
    }
    harness.emit(updatePartEvent(part, 1000, "evt_tail_hover_bash"))

    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = false
    scroll!.scrollTo(Infinity)
    await harness.app.renderOnce()

    const idle = await locateEventually(harness, EXPECTED_TEXT)
    const before = harness.snapshot()

    await harness.app.mockMouse.moveTo(idle.column + 1, idle.row)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    const hovered = locate(harness, EXPECTED_TEXT)!
    expect(hovered.bg).not.toBe(idle.bg)

    await harness.app.mockMouse.moveTo(0, 0)
    await Bun.sleep(10)
    await harness.app.renderOnce()
    const restored = locate(harness, EXPECTED_TEXT)!
    expect(restored.bg).toBe(idle.bg)

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
    expect(locate(harness, EXPECTED_TEXT)!.bg).toBe(idle.bg)
  } finally {
    await harness.dispose()
  }
})