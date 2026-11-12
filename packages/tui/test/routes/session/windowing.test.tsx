// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import { createFixture, richTail, updatePartEvent, type FixtureSize } from "../../perf/fixtures"
import { mountHarness } from "../../perf/harness"
import { settleHighlights } from "../../perf/scenarios"

// `XL` is the only fixture above WINDOW_MIN_ROWS, so it is the one the windowed
// transcript runs in; `L` is fully mounted. The strings are what a viewport at the
// end of each shows (a bash command two rows from the last), and what the first
// loaded message shows at the top.
const LAST_COMMAND: Partial<Record<FixtureSize, string>> = { L: "printf perf-395", XL: "printf perf-2195" }
const FIRST_TEXT: Partial<Record<FixtureSize, string>> = { L: "Deterministic answer 300", XL: "Deterministic answer 0:" }

async function frameContaining(harness: Awaited<ReturnType<typeof mountHarness>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const frame = harness.app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(1)
  }
  throw new Error(`frame never contained ${text}:\n${harness.app.captureCharFrame()}`)
}

async function frameWithout(harness: Awaited<ReturnType<typeof mountHarness>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const frame = harness.app.captureCharFrame()
    if (!frame.includes(text)) return frame
    await Bun.sleep(1)
  }
  throw new Error(`frame always contained ${text}:\n${harness.app.captureCharFrame()}`)
}

/**
 * Render until two consecutive frames match. After a scroll the windowed list
 * mounts the rows that came into view over the next few passes; sampling before
 * that settles would count layout changes as spinner motion.
 */
async function settledFrame(harness: Awaited<ReturnType<typeof mountHarness>>) {
  let previous = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const frame = harness.app.captureCharFrame()
    if (frame === previous) return frame
    previous = frame
  }
  throw new Error(`frame never settled:\n${previous}`)
}

type Harness = Awaited<ReturnType<typeof mountHarness>>

/**
 * Render until the scroll offset and the content height have held still for
 * `quiet` frames in a row. A transcript whose window keeps flipping between two
 * layouts never does: it changes both numbers on every frame.
 */
async function settleScroll(harness: Harness, quiet = 10, limit = 120) {
  const scroll = harness.scroll()!
  let previous = ""
  let still = 0
  for (let attempt = 0; attempt < limit; attempt++) {
    // Code blocks highlight on a worker and re-wrap when it answers; a reading
    // taken before every mounted block has answered is not a settled one.
    await settleHighlights(harness)
    const reading = `${scroll.scrollTop}/${scroll.scrollHeight}`
    still = reading === previous ? still + 1 : 0
    previous = reading
    if (still >= quiet) return
  }
  throw new Error(`the scroll position never settled (last reading ${previous})`)
}

const atEnd = (harness: Harness) => {
  const scroll = harness.scroll()!
  return Math.max(0, scroll.scrollHeight - scroll.viewport.height) - scroll.scrollTop
}

function braille(frame: string) {
  return SPINNER_FRAMES.filter((char) => frame.includes(char)).join("")
}

async function sample(harness: Awaited<ReturnType<typeof mountHarness>>, rounds = 6) {
  const frames: string[] = []
  for (let index = 0; index < rounds; index++) {
    // The harness drives the shared ticker from its ManualClock, so advance
    // virtual time instead of sleeping; a real sleep never moves the spinner.
    harness.clock.advance(120)
    // Two passes: the first applies ticker-driven updates, the second settles
    // layout before the frame is sampled.
    await harness.app.renderOnce()
    await harness.app.renderOnce()
    frames.push(harness.app.captureCharFrame())
  }
  return frames
}

test("windowed transcript mounts a bounded row set and follows the viewport", async () => {
  const fixture = createFixture("XL")
  expect(fixture.rows).toBeGreaterThanOrEqual(WINDOW_MIN_ROWS)
  const harness = await mountHarness(fixture)
  try {
    await harness.reset()
    // The session route scrolls to the last message 50ms after mount. Let that
    // timer run before driving the viewport, or it fires mid-assertion.
    await Bun.sleep(60)
    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = true
    scroll!.scrollTo(Infinity)
    await frameContaining(harness, LAST_COMMAND.XL!)
    expect(harness.counters.mountedNodes(harness.app.renderer.root)).toBeLessThan(300)

    scroll!.stickyScroll = false
    scroll!.scrollTo(0)
    await frameContaining(harness, FIRST_TEXT.XL!)

    const frame = harness.app.captureCharFrame()
    expect(frame).not.toContain(LAST_COMMAND.XL!)
    expect(scroll!.scrollTop).toBe(0)
    expect(harness.counters.mountedNodes(harness.app.renderer.root)).toBeLessThan(300)
    expect(scroll!.getChildren().length).toBeLessThan(120)
  } finally {
    await harness.dispose()
  }
})

// The same rule holds with and without windowing: the windowed transcript knows its
// viewport rows, the fully mounted one asks the spinner's own position.
test.each(["L", "XL"] as const)("a running tool spins only while its row sits inside the viewport (%s)", async (size) => {
  const harness = await mountHarness(createFixture(size))
  try {
    await harness.reset()
    // Same 50ms scroll-to-bottom after mount as the windowing test above.
    await Bun.sleep(60)
    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = false
    scroll!.scrollTo(Infinity)
    await frameContaining(harness, LAST_COMMAND[size]!)

    const part: Part = {
      id: "prt_spinner_running",
      sessionID: harness.fixture.session.id,
      messageID: harness.fixture.messages.at(-1)!.info.id,
      type: "tool",
      callID: "call_spinner_running",
      tool: "read",
      state: { status: "running", input: { filePath: "/tmp/spinner-fixture" }, time: { start: 1 } },
    }
    harness.emit(updatePartEvent(part, 1000, "evt_spinner_running"))

    const visible = await frameContaining(harness, "spinner-fixture")
    expect(braille(visible)).not.toBe("")
    const moving = await sample(harness)
    expect(new Set(moving).size).toBeGreaterThan(1)

    scroll!.scrollTo(0)
    await frameWithout(harness, "spinner-fixture")
    const hidden = await settledFrame(harness)
    expect(braille(hidden)).toBe("")
    const still = await sample(harness)
    expect(new Set(still).size).toBe(1)

    scroll!.scrollTo(Infinity)
    const restored = await frameContaining(harness, "spinner-fixture")
    expect(braille(restored)).not.toBe("")
    const movingAgain = await sample(harness)
    expect(new Set(movingAgain).size).toBeGreaterThan(1)
  } finally {
    await harness.dispose()
  }
})

test("a transcript below the threshold mounts every row, whatever the viewport shows", async () => {
  const fixture = createFixture("L")
  expect(fixture.rows).toBeLessThan(WINDOW_MIN_ROWS)
  const harness = await mountHarness(fixture)
  try {
    await harness.reset()
    await Bun.sleep(60)
    const scroll = harness.scroll()!
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await frameContaining(harness, FIRST_TEXT.L!)

    // The viewport holds the top of the session, and every row down to the last is still mounted.
    expect(harness.app.captureCharFrame()).not.toContain(LAST_COMMAND.L!)
    expect(harness.counters.mountedRows(scroll)).toBe(fixture.rows)
    expect(scroll.getChildren().length).toBe(fixture.rows + 1)

    // Scrolling mounts nothing and unmounts nothing.
    scroll.scrollTo(Infinity)
    await frameContaining(harness, LAST_COMMAND.L!)
    expect(harness.counters.mountedRows(scroll)).toBe(fixture.rows)
    scroll.scrollTo(0)
    await frameContaining(harness, FIRST_TEXT.L!)
    expect(harness.counters.mountedRows(scroll)).toBe(fixture.rows)
  } finally {
    await harness.dispose()
  }
})

// The tail holds 20 text parts that end in a code block, a table, or a diff. Their
// estimated heights are short of the real ones, so the first layouts of the rows at
// the end correct the positions the window was computed from.

test("a jump to the end of a transcript with rich blocks at its tail settles on the real bottom", async () => {
  const harness = await mountHarness(richTail(createFixture("XL"), 20))
  try {
    await harness.reset()
    await Bun.sleep(60)
    const scroll = harness.scroll()!
    // The production configuration: the session route pins the scrollbox to the end.
    scroll.stickyScroll = true
    scroll.scrollTo(Infinity)

    await settleScroll(harness)
    expect(atEnd(harness)).toBe(0)
    const settled = harness.app.captureCharFrame()
    expect(settled).toContain(LAST_COMMAND.XL!)

    // Nothing moves once it has settled: not the offset, not the content, not the screen.
    const height = scroll.scrollHeight
    for (let frame = 0; frame < 20; frame++) {
      await harness.app.renderOnce()
      expect(scroll.scrollHeight).toBe(height)
      expect(atEnd(harness)).toBe(0)
    }
    expect(harness.app.captureCharFrame()).toBe(settled)
  } finally {
    await harness.dispose()
  }
})

test("the last-message command lands on the real bottom from the middle of the transcript", async () => {
  const harness = await mountHarness(richTail(createFixture("XL"), 20))
  try {
    await harness.reset()
    await Bun.sleep(60)
    const scroll = harness.scroll()!
    scroll.scrollTo(300)
    await settleScroll(harness)
    expect(scroll.scrollTop).toBeLessThan(scroll.scrollHeight - scroll.viewport.height - 100)

    // What `session.last` does.
    scroll.scrollTo(scroll.scrollHeight)
    await settleScroll(harness)

    expect(atEnd(harness)).toBe(0)
    expect(harness.app.captureCharFrame()).toContain(LAST_COMMAND.XL!)
  } finally {
    await harness.dispose()
  }
})
