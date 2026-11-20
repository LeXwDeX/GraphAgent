// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MouseEvent, TextRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Part } from "@graphagent/sdk"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import {
  createFixture,
  expandableOutputs,
  richTail,
  updatePartEvent,
  withUserMessages,
  type FixtureSize,
} from "../../perf/fixtures"
import { mountHarness } from "../../perf/harness"
import { settleHighlights, settleScroll, topRow, walkUp } from "../../perf/scenarios"

// `XL` is the only fixture above WINDOW_MIN_ROWS, so it is the one the windowed
// transcript runs in; `L` is fully mounted. The strings are what a viewport at the
// end of each shows (the last bash command: a call is a block of two lines, so the
// one before it is already above a viewport of thirty), and what the first loaded
// message shows at the top.
const LAST_COMMAND: Partial<Record<FixtureSize, string>> = { L: "printf perf-397", XL: "printf perf-2297" }
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
 * that settles would count layout changes as spinner motion. Their text
 * highlights on a parser worker and appears when it answers, which on a slower
 * machine is after two frames that look alike, so every pass waits for it.
 */
async function settledFrame(harness: Awaited<ReturnType<typeof mountHarness>>) {
  let previous = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    await settleHighlights(harness)
    const frame = harness.app.captureCharFrame()
    if (frame === previous) return frame
    previous = frame
  }
  throw new Error(`frame never settled:\n${previous}`)
}

type Harness = Awaited<ReturnType<typeof mountHarness>>

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

/** The first span of the frame that holds `text`, as the cell its first character sits in. */
/**
 * Where the header of a thought that is open stands. A folded header ends in `· collapsed`; an open one is the same
 * words without it, so it is the one `∴ Thought for` row that does not say so.
 */
function locateOpenThought(harness: Harness) {
  const frame = harness.app.captureSpans()
  for (let row = 0; row < frame.lines.length; row++) {
    const line = frame.lines[row].spans.map((span) => span.text).join("")
    const index = line.indexOf("Thought for")
    if (index !== -1 && !line.includes("· collapsed")) return { row, column: index }
  }
  return undefined
}

function locateText(harness: Harness, text: string) {
  const frame = harness.app.captureSpans()
  for (let row = 0; row < frame.lines.length; row++) {
    let column = 0
    for (const span of frame.lines[row].spans) {
      const index = span.text.indexOf(text)
      if (index !== -1) return { row, column: column + index }
      column += span.text.length
    }
  }
  return undefined
}

async function renderSettled(harness: Harness, frames = 4) {
  for (let frame = 0; frame < frames; frame++) await harness.app.renderOnce()
  await settleHighlights(harness)
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
    // The call is the last row now, below a viewport that does not follow the end (no line of the message comes after
    // it): the viewport goes to it.
    await harness.app.renderOnce()
    scroll!.scrollTo(Infinity)

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

// A turn ends with the last of its parts (#1615): no line under it gives the agent, the model and the time, and none says
// how to view the sub-agents. The windowed transcript and the one mounted whole draw the end of the session the same way.
test.each(["L", "XL"] as const)(
  "nothing follows the last part of a finished turn at the end of the transcript (%s)",
  async (size) => {
    const harness = await mountHarness(createFixture(size))
    try {
      await harness.reset()
      await Bun.sleep(60)
      const scroll = harness.scroll()!
      scroll.stickyScroll = true
      scroll.scrollTo(Infinity)
      const frame = await frameContaining(harness, LAST_COMMAND[size]!)
      const rows = frame.split("\n").map((row) => row.trimEnd())

      // The last part of the fixture's last message is a thought; the input's top edge is the next thing under it.
      const thought = rows.findLastIndex((row) => row.includes("∴"))
      expect(thought).toBeGreaterThan(0)
      expect(
        rows
          .slice(thought + 1)
          .find((row) => row.trim().length > 0)
          ?.trimStart()
          .startsWith("╭"),
      ).toBe(true)
      expect(frame).not.toContain("▣")
    } finally {
      await harness.dispose()
    }
  },
)

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

// The window mounts the rows around the viewport and at the tail, and the rows the reader opened: an opened
// row keeps its place in the transcript while the viewport is elsewhere, so closing it later is one click.
test("a row the reader opened stays mounted while the viewport is away from it", async () => {
  const harness = await mountHarness(createFixture("XL"))
  try {
    await harness.reset()
    await Bun.sleep(60)
    const scroll = harness.scroll()!
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await renderSettled(harness)
    const baseline = harness.counters.mountedRows(scroll)

    // A collapsed thought, somewhere in the middle of the transcript.
    const page = scroll.viewport.height - 1
    const middle = Math.floor(scroll.scrollHeight / 2)
    let header: ReturnType<typeof locateText>
    for (let attempt = 0; attempt < 30 && !header; attempt++) {
      scroll.scrollTo(middle + attempt * page)
      await renderSettled(harness)
      header = locateText(harness, "· collapsed")
    }
    expect(header).toBeDefined()
    const opened = scroll.scrollTop
    await harness.app.mockMouse.click(header!.column + 2, header!.row)
    await renderSettled(harness)
    expect(locateOpenThought(harness)).toBeDefined()

    // Far from it, the row is still one of the mounted ones.
    scroll.scrollTo(0)
    await renderSettled(harness)
    expect(harness.counters.mountedRows(scroll)).toBe(baseline + 1)

    // Back at it, it is open as it was left, and closing it returns the window to what the viewport needs.
    scroll.scrollTo(opened)
    await renderSettled(harness)
    const open = locateOpenThought(harness)
    expect(open).toBeDefined()
    await harness.app.mockMouse.click(open!.column + 2, open!.row)
    await renderSettled(harness)
    expect(locateOpenThought(harness)).toBeUndefined()
    scroll.scrollTo(0)
    await renderSettled(harness)
    expect(harness.counters.mountedRows(scroll)).toBe(baseline)
  } finally {
    await harness.dispose()
  }
}, 60_000)

// The window mounts rows it has only estimated, and what they measure is rarely what they were estimated at.
// Left alone, a row that is measured, mounted, opened or closed above the viewport moves everything under it,
// and the reader sees the content jump (#1277). The scroll box holds the row at the top of the viewport in place
// instead, in the layout that moves it, so the frame that is drawn has not moved.

function texts(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(texts)]
}

/** The text node under `node` that holds `text`. */
function textIn(node: Renderable, text: string): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.plainText.includes(text)) return node
  for (const child of node.getChildren()) {
    const found = textIn(child, text)
    if (found) return found
  }
  return undefined
}

/** The child of the scroll box that holds `text`, and the text node itself. */
function holding(scroll: ScrollBoxRenderable, text: string) {
  for (const row of scroll.getChildren()) {
    const node = textIn(row, text)
    if (node) return { row, node }
  }
  return undefined
}

/**
 * What a click does to a node, without the node having to be on the screen. The mock mouse needs a cell to
 * click, and a row above the viewport has none; the release reaches the node's handler and those of the
 * boxes around it the way a click does.
 */
function click(node: Renderable) {
  node.processMouseEvent(
    new MouseEvent(node, { type: "up", button: 0, x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false } }),
  )
}

/** What the viewport shows: the screen lines of the scroll box. */
function viewportText(harness: Harness) {
  const scroll = harness.scroll()!
  return harness.app
    .captureCharFrame()
    .split("\n")
    .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
}

/** The session as the reader has it configured: the scroll box follows the end, and the viewport is there. */
async function atTheEnd(harness: Harness) {
  await harness.reset()
  // The session route scrolls to the last message 50ms after mount; let that timer run first.
  await Bun.sleep(60)
  const scroll = harness.scroll()!
  scroll.stickyScroll = true
  scroll.scrollTo(Infinity)
  await settleScroll(harness)
  return scroll
}

test.each([
  ["plain rows", () => createFixture("XL")],
  ["tall rows right where the reader lands", () => richTail(createFixture("XL"), 20)],
] as const)(
  "walking up a line at a time from the end moves the row at the top a line a step (%s)",
  async (_, build) => {
    const harness = await mountHarness(build())
    try {
      const scroll = await atTheEnd(harness)

      const walk = await walkUp(harness, scroll, 450)

      expect(walk.steps).toBe(450)
      expect(walk).toMatchObject({ jumps: 0, driftPx: 0, maxJumpPx: 0 })
      // It crossed rows that were never measured, in a window and not in a session that is mounted whole.
      expect(harness.counters.mountedRows(scroll)).toBeLessThan(40)
    } finally {
      await harness.dispose()
    }
  },
  60_000,
)

// The scroll box gives its content the height of the viewport at least and puts it at the end (#1615: a session that
// does not fill the screen stands on the bottom). A session that is taller than the screen is not changed by that, and
// the walk shows it for the one that is mounted whole as well: the largest below the threshold, about 1800 rows.
test("walking up a line at a time from the end of a transcript mounted whole moves the row at the top a line a step", async () => {
  const fixture = createFixture("XL", false, { partsPerMessage: 20 })
  expect(fixture.rows).toBeLessThan(WINDOW_MIN_ROWS)
  expect(fixture.rows).toBeGreaterThan(1500)
  const harness = await mountHarness(fixture)
  try {
    const scroll = await atTheEnd(harness)

    const walk = await walkUp(harness, scroll, 450)

    expect(walk.steps).toBe(450)
    expect(walk).toMatchObject({ jumps: 0, driftPx: 0, maxJumpPx: 0 })
    // Every row is mounted, and none is mounted by the walk.
    expect(harness.counters.mountedRows(scroll)).toBe(fixture.rows)
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("a reply written at the end is followed, and one written below a reader who went up is not", async () => {
  const harness = await mountHarness(createFixture("XL"))
  try {
    const scroll = await atTheEnd(harness)
    const height = scroll.scrollHeight
    const stream = harness.openStream()
    await harness.app.renderOnce()
    for (let word = 0; word < 60; word++) {
      stream.delta(`word${word} `.repeat(12))
      await harness.app.renderOnce()
      expect(atEnd(harness)).toBe(0)
    }
    // The reply was long enough to need following.
    expect(scroll.scrollHeight).toBeGreaterThan(height + 20)
    stream.finish()
    await harness.app.renderOnce()

    // Thirty lines up, the reader keeps what they see: the next reply pushes the end down and nothing else moves.
    await walkUp(harness, scroll, 30)
    await settleScroll(harness)
    const row = topRow(scroll)!
    const line = row.y
    const top = scroll.scrollTop
    const next = harness.openStream()
    await harness.app.renderOnce()
    for (let word = 0; word < 60; word++) {
      next.delta(`word${word} `.repeat(12))
      await harness.app.renderOnce()
      expect(row.y).toBe(line)
      expect(scroll.scrollTop).toBe(top)
    }
    expect(atEnd(harness)).toBeGreaterThan(30)
    next.finish()
  } finally {
    await harness.dispose()
  }
}, 60_000)

test.each([
  [
    "a line at a time",
    async (harness: Harness) => {
      for (let guard = 0; guard < 200 && atEnd(harness) > 0; guard++) {
        harness.scroll()!.scrollBy(1)
        await harness.app.renderOnce()
      }
    },
  ],
  [
    "in one jump, as session.last does",
    async (harness: Harness) => {
      const scroll = harness.scroll()!
      scroll.scrollTo(scroll.scrollHeight)
      await harness.app.renderOnce()
    },
  ],
] as const)(
  "a viewport that came back to the end after reading up follows a reply again (%s)",
  async (_, back) => {
    const harness = await mountHarness(createFixture("XL"))
    try {
      const scroll = await atTheEnd(harness)
      await walkUp(harness, scroll, 30)
      await settleScroll(harness)
      expect(atEnd(harness)).toBeGreaterThan(0)

      await back(harness)
      await settleScroll(harness)
      expect(atEnd(harness)).toBe(0)

      const stream = harness.openStream()
      await harness.app.renderOnce()
      for (let word = 0; word < 60; word++) {
        stream.delta(`word${word} `.repeat(12))
        await harness.app.renderOnce()
        expect(atEnd(harness)).toBe(0)
      }
      stream.finish()
    } finally {
      await harness.dispose()
    }
  },
  60_000,
)

// A tool output the reader opened stays mounted wherever the viewport goes, so it can change height while it
// is above the viewport. That is the one change the positions know of before the layout does: the window has
// to be taken at the offset the layout is about to leave the viewport at, or the rows the reader is looking
// at are unmounted for the frame and the screen shows blanks where they were.
test("opening or closing a tool output above the viewport leaves what the reader sees where it is", async () => {
  const harness = await mountHarness(expandableOutputs(createFixture("XL"), 3))
  try {
    const scroll = await atTheEnd(harness)

    // Up to an output the reader can open, from far enough above the end for a whole viewport to lie under it once
    // it is open, and open it.
    scroll.scrollBy(-3 * scroll.viewport.height)
    await renderSettled(harness)
    let header: ReturnType<typeof locateText>
    for (let attempt = 0; attempt < 200 && !header; attempt++) {
      scroll.scrollBy(-10)
      await renderSettled(harness, 2)
      header = locateText(harness, "more lines · ⌃O expand")
    }
    expect(header).toBeDefined()
    await harness.app.mockMouse.click(header!.column + 2, header!.row)
    await renderSettled(harness)
    const opened = holding(scroll, "⌃O collapse")
    expect(opened).toBeDefined()
    // The call is what tells the row apart, whichever of the rows that fold carries the same hint, and a row that
    // opens or closes is a new row: it is found again by its command, not kept.
    const command = /printf perf-\d+/.exec(texts(opened!.row).join(" "))![0]

    // Read on until the open output is just above the viewport. It is still mounted: it is open.
    for (let guard = 0; guard < 100; guard++) {
      const open = holding(scroll, "⌃O collapse")
      if (open && open.row.y + open.row.height <= scroll.viewport.y) break
      scroll.scrollBy(3)
      await harness.app.renderOnce()
    }
    await settleScroll(harness)

    for (const label of ["⌃O collapse", "more lines · ⌃O expand"]) {
      const output = holding(scroll, command)
      expect(output).toBeDefined()
      const node = textIn(output!.row, label)
      expect(node).toBeDefined()
      expect(output!.row.y + output!.row.height).toBeLessThanOrEqual(scroll.viewport.y)
      const reader = topRow(scroll)!
      const line = reader.y
      const seen = viewportText(harness)

      click(node!)
      await harness.app.renderOnce()
      // In the frame the output changes height nothing under the reader moves, and nothing is blank.
      expect(reader.y).toBe(line)
      expect(viewportText(harness)).toEqual(seen)

      await settleScroll(harness)
      expect(reader.y).toBe(line)
      expect(viewportText(harness)).toEqual(seen)
    }
  } finally {
    await harness.dispose()
  }
}, 60_000)

// `session.message.next` and `session.message.previous` go to the next user message of a windowed transcript.
// It is rows away and not mounted: the jump lands by the positions of the row table, and the rows around the
// target mount from estimates that were off by a few lines. The target has to be at the top all the same.

/** The user message "Question `ordinal`" if its row is mounted, and how far its row is from the top of the viewport. */
function question(scroll: ScrollBoxRenderable, ordinal: number) {
  const row = scroll.getChildren().find((node) => texts(node).some((text) => text.startsWith(`Question ${ordinal}:`)))
  return row && { row, top: row.y - scroll.viewport.y }
}

/** A windowed session with a user message between every ten assistant ones; the page keeps nine of them. */
function withQuestions() {
  const fixture = withUserMessages(createFixture("XL", false, { partsPerMessage: 26 }), 10)
  expect(fixture.rows).toBeGreaterThanOrEqual(WINDOW_MIN_ROWS)
  return fixture
}

test("session.message.next takes the viewport to a user message that was not mounted", async () => {
  const harness = await mountHarness(withQuestions())
  try {
    const scroll = await atTheEnd(harness)
    scroll.scrollTo(0)
    await settleScroll(harness)
    expect(scroll.scrollTop).toBe(0)

    for (const ordinal of [1, 2]) {
      expect(question(scroll, ordinal)).toBeUndefined()
      harness.command("session.message.next")
      await harness.app.renderOnce()
      // The frame the jump is drawn in has the target at the top already.
      expect(question(scroll, ordinal)?.top).toBe(0)
      expect(viewportText(harness).join("\n")).toContain(`Question ${ordinal}:`)

      await settleScroll(harness)
      expect(question(scroll, ordinal)?.top).toBe(0)
    }
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("session.message.previous takes the viewport to a user message that was not mounted", async () => {
  const harness = await mountHarness(withQuestions())
  try {
    const scroll = await atTheEnd(harness)

    for (const ordinal of [9, 8]) {
      expect(question(scroll, ordinal)).toBeUndefined()
      harness.command("session.message.previous")
      await harness.app.renderOnce()
      expect(question(scroll, ordinal)?.top).toBe(0)
      expect(viewportText(harness).join("\n")).toContain(`Question ${ordinal}:`)

      await settleScroll(harness)
      expect(question(scroll, ordinal)?.top).toBe(0)
    }
  } finally {
    await harness.dispose()
  }
}, 60_000)

// A session route that names a message (#1058 7) takes the viewport to it the same way, and takes the request off the
// route, so naming the message again goes there again.
test("a route that names a user message takes a windowed transcript to it, and again when it names it again", async () => {
  const fixture = withQuestions()
  const harness = await mountHarness(fixture)
  try {
    const scroll = await atTheEnd(harness)
    const target = `msg_${fixture.session.id}_ask_5`

    expect(question(scroll, 5)).toBeUndefined()
    harness.navigate({ type: "session", sessionID: fixture.session.id, messageID: target })
    await settleScroll(harness)
    expect(question(scroll, 5)?.top).toBe(0)
    expect(viewportText(harness).join("\n")).toContain("Question 5:")

    scroll.scrollTo(0)
    await settleScroll(harness)
    expect(question(scroll, 5)).toBeUndefined()
    harness.navigate({ type: "session", sessionID: fixture.session.id, messageID: target })
    await settleScroll(harness)
    expect(question(scroll, 5)?.top).toBe(0)
  } finally {
    await harness.dispose()
  }
}, 60_000)
