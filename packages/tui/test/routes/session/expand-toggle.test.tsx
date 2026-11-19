// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { createFixture, expandableOutputs, type PerfFixture } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"
import { settleScroll } from "../../perf/scenarios"
import { readFrame, readSpans } from "../dag-mode-harness"

/**
 * `view.expand.toggle` (ctrl+o, #886 4.4) in the real session route. The transcript is the perf fixture cut down
 * to the parts a case needs: part 1 is plain text, part 5 a bash call with a 30 line output (its last line shows
 * under the call, and a hint under that names the key), part 6 a read call, part 8 reasoning, which the default
 * thinking mode folds to one header.
 */

const PART = (index: number) => `prt_ses_perf_main_${index}`
/**
 * A line the folded row does not show, since it keeps the last of the thirty, `output line 29`; and one the open row
 * shows, since the transcript follows its tail and the viewport holds the last lines of it.
 */
const BEYOND_THE_CAP = "output line 25"
/** The hint under an output that folds, and under one that is open: they name `view.expand.toggle`, ctrl+o. */
const FOLDED = "more lines · ctrl+o expand"
const OPEN = "ctrl+o collapse"
const REASONING_BODY = "Reasoning step 8"

/** The fixture with the assistant messages that hold `parts` and the user message, in order. */
function transcript(parts: readonly number[], edit?: (fixture: PerfFixture) => void) {
  const fixture = expandableOutputs(createFixture("S"), 1)
  edit?.(fixture)
  const keep = new Set(parts.map(PART))
  fixture.messages = fixture.messages.filter(
    (entry) => entry.info.role === "user" || entry.parts.some((part) => keep.has(part.id)),
  )
  return fixture
}

/**
 * Renders until the frame satisfies `ready`, then until the layout holds still, and returns the frame. The
 * markdown of a block that just opened and the scroll offset that follows a change of height both arrive over a
 * few frames, so a fixed number of renders reads some of them half way.
 */
async function until(harness: PerfHarness, ready: (frame: string) => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await harness.app.renderOnce()
    if (ready(await readFrame(harness.app))) {
      await settleScroll(harness)
      return readFrame(harness.app)
    }
    await Bun.sleep(5)
  }
  throw new Error(`the frame never ${what}:\n${await readFrame(harness.app)}`)
}

const holds = (text: string) => (frame: string) => frame.includes(text)
const lacks = (text: string) => (frame: string) => !frame.includes(text)

function pressExpand(harness: PerfHarness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
}

async function locate(harness: PerfHarness, text: string) {
  const frame = await readSpans(harness.app)
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

/**
 * Clicks `dx` cells into `text`. Two clicks on the same cell in quick succession are a double click, which selects a
 * word, and a row ignores a click while text is selected; so a test that clicks twice uses two cells.
 */
async function click(harness: PerfHarness, text: string, dx: number) {
  const at = await locate(harness, text)
  expect(at).toBeDefined()
  await harness.app.mockMouse.click(at!.column + dx, at!.row)
  harness.app.renderer.clearSelection()
}

test("ctrl+o opens the most recent folded block, then the one before it, and closes the latest when all are open", async () => {
  const harness = await mountHarness(transcript([1, 5, 8]))
  try {
    const before = await until(harness, holds(FOLDED), "held the folded output")
    expect(before).toContain("+ Thought")
    expect(before).not.toContain(REASONING_BODY)
    expect(before).not.toContain(BEYOND_THE_CAP)

    // The reasoning is the latest block that can fold. Opening a block is view state: no store write, and the
    // key press does not register another layer (#886 section 5 budget).
    const counts = harness.counters.snapshot()
    pressExpand(harness)
    const first = await until(harness, holds(REASONING_BODY), "opened the reasoning")
    expect(harness.counters.delta(counts)).toMatchObject({
      storeMessageWrites: 0,
      storePartWrites: 0,
      registerLayer: 0,
    })
    expect(first).toContain("- Thought")
    expect(first).toContain(FOLDED)
    expect(first).not.toContain(BEYOND_THE_CAP)

    // The bash output is the one before it.
    pressExpand(harness)
    const second = await until(harness, holds(BEYOND_THE_CAP), "opened the output")
    expect(second).toContain(OPEN)
    expect(second).toContain(REASONING_BODY)

    // Everything is open: the key closes the most recent block and leaves the other one.
    pressExpand(harness)
    const third = await until(harness, lacks(REASONING_BODY), "closed the reasoning")
    expect(third).toContain("+ Thought")
    expect(third).toContain(BEYOND_THE_CAP)
    expect(third).toContain(OPEN)
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("a block opened by a click closes by key, and the other way round", async () => {
  const harness = await mountHarness(transcript([1, 5]))
  try {
    await until(harness, holds(FOLDED), "held the folded output")
    await click(harness, FOLDED, 2)
    expect(await until(harness, holds(OPEN), "opened by the click")).toContain(BEYOND_THE_CAP)

    // Nothing is folded any more, so the key closes the block the click opened.
    pressExpand(harness)
    const closed = await until(harness, holds(FOLDED), "closed by the key")
    expect(closed).not.toContain(BEYOND_THE_CAP)

    // The key opens it again, and a click closes it.
    pressExpand(harness)
    await until(harness, holds(OPEN), "opened by the key")
    await click(harness, OPEN, 10)
    const reclosed = await until(harness, holds(FOLDED), "closed by the click")
    expect(reclosed).not.toContain(BEYOND_THE_CAP)
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("with thinking shown the reasoning has nothing to fold and the key goes to the tool output", async () => {
  const harness = await mountHarness(transcript([1, 5, 8]))
  try {
    await until(harness, holds(FOLDED), "held the folded output")
    // The default folds reasoning; this switches the mode to show.
    harness.command("session.toggle.thinking")
    const shown = await until(harness, holds(REASONING_BODY), "showed the reasoning")
    expect(shown).not.toContain("+ Thought")

    pressExpand(harness)
    const opened = await until(harness, holds(BEYOND_THE_CAP), "opened the output")
    expect(opened).toContain(OPEN)
    // The reasoning stayed as it was.
    expect(opened).toContain(REASONING_BODY)
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("the error of a failed tool call folds under the line that says it failed, and the key opens it", async () => {
  // The row says the first line of the error; the rest is what the key opens.
  const first = "boom: the read was refused"
  const error = `${first}\nthe test says why, on a line of its own`
  const harness = await mountHarness(
    transcript([1, 6], (fixture) => {
      const read = fixture.parts.find((part): part is Extract<Part, { type: "tool" }> => part.id === PART(6))!
      read.state = {
        status: "error",
        input: { filePath: "src/missing.ts" },
        error,
        time: { start: 6, end: 7 },
      }
    }),
  )
  try {
    const before = await until(harness, holds("missing.ts"), "held the failed call")
    expect(before).toContain(first)
    expect(before).not.toContain("on a line of its own")

    pressExpand(harness)
    await until(harness, holds("on a line of its own"), "opened the error")

    pressExpand(harness)
    await until(harness, lacks("on a line of its own"), "closed the error")
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("with no block that can fold the key does nothing", async () => {
  // Part 6 is a read call that succeeded: one line, nothing to open.
  const harness = await mountHarness(transcript([1, 6]))
  try {
    const before = await until(harness, holds("Deterministic answer 1"), "held the text")
    const counts = harness.counters.snapshot()
    pressExpand(harness)
    // Nothing changed: the frame after the key is the one before it.
    await harness.app.renderOnce()
    await settleScroll(harness)
    expect(await readFrame(harness.app)).toBe(before)
    expect(harness.counters.delta(counts)).toMatchObject({
      storeMessageWrites: 0,
      storePartWrites: 0,
      registerLayer: 0,
    })
  } finally {
    await harness.dispose()
  }
}, 60_000)

// The cases below are the ones where what the key may open depends on what the block draws, so they check the
// frame and not the functions of `fold.ts`: the key and the block have to agree.

const toolPart = (fixture: PerfFixture, index: number) =>
  fixture.parts.find((part): part is Extract<Part, { type: "tool" }> => part.id === PART(index))!

const printed = (prefix: string, count = 30) =>
  Array.from({ length: count }, (_, line) => `${prefix} ${line}`).join("\n")

test("a reasoning that has only a title has nothing to open, so the key goes past it", async () => {
  const harness = await mountHarness(
    transcript([1, 5, 8], (fixture) => {
      const thought = fixture.parts.find((part): part is Extract<Part, { type: "reasoning" }> => part.id === PART(8))!
      thought.text = "**Planning the change**"
    }),
  )
  try {
    const before = await until(harness, holds(FOLDED), "held the folded output")
    expect(before).toContain("+ Thought: Planning the change")

    pressExpand(harness)
    const opened = await until(harness, holds(BEYOND_THE_CAP), "opened the output")
    // The reasoning is the later block, and it stayed folded: under its header there is nothing.
    expect(opened).toContain("+ Thought: Planning the change")
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("a failed bash call is one line whatever it printed: the key opens its error, and under it what it printed", async () => {
  const harness = await mountHarness(
    transcript([1, 5], (fixture) => {
      toolPart(fixture, 5).state = {
        status: "error",
        input: { command: "printf perf-5" },
        error: "Tool execution aborted",
        metadata: { output: printed("output line"), interrupted: true },
        time: { start: 5, end: 6 },
      }
    }),
  )
  try {
    const before = await until(harness, holds("Tool execution aborted"), "held the failed call")
    expect(before).not.toContain(BEYOND_THE_CAP)
    // The row of a call that failed has an error to open, not an output to fold: no hint counts lines.
    expect(before).not.toContain(FOLDED)

    pressExpand(harness)
    // The error stands under the call, above the thirty lines the command printed, which the viewport holds the end of.
    const opened = await until(harness, holds(BEYOND_THE_CAP), "opened the error")
    expect(opened).not.toContain(OPEN)

    pressExpand(harness)
    const closed = await until(harness, lacks(BEYOND_THE_CAP), "closed the error")
    expect(closed).toContain("Tool execution aborted")
  } finally {
    await harness.dispose()
  }
}, 60_000)

test("the output of a tool without a display of its own folds once the reader shows it", async () => {
  const harness = await mountHarness(
    transcript([1, 6], (fixture) => {
      const call = toolPart(fixture, 6)
      call.tool = "custom_tool"
      call.state = {
        status: "completed",
        input: {},
        output: printed("generic line", 20),
        title: "Custom tool",
        metadata: {},
        time: { start: 6, end: 7 },
      }
    }),
  )
  try {
    const before = await until(harness, holds("custom_tool"), "held the call as one line")
    expect(before).not.toContain(FOLDED)

    // The call is one line until the output is shown: nothing to open, and the frame stays as it was.
    pressExpand(harness)
    await harness.app.renderOnce()
    await settleScroll(harness)
    expect(await readFrame(harness.app)).toBe(before)

    harness.command("session.toggle.generic_tool_output")
    await until(harness, holds(FOLDED), "showed the output")
    pressExpand(harness)
    const opened = await until(harness, holds(OPEN), "opened the output")
    expect(opened).toContain("generic line 19")
  } finally {
    await harness.dispose()
  }
}, 60_000)
