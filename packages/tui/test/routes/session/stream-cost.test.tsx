// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createFixture, type FixtureSize } from "../../perf/fixtures"
import { mountHarness } from "../../perf/harness"
import { settleHighlights } from "../../perf/scenarios"

/**
 * #1260: a frame of a streamed reply used to read the text of every part of the session and hash all of
 * it, so it cost as much as the transcript is long. Timing that depends on the machine, so this counts what
 * a frame reads instead: through the real session route, the parts whose text is read for a frame are the
 * ones being written, and how many of them is the same in a session of 48 rows, of 190 and of 2080 (the
 * last one windowed).
 */

const FRAMES = 20

async function streamedFrame(size: FixtureSize) {
  const harness = await mountHarness(createFixture(size))
  try {
    await harness.reset()
    await settleHighlights(harness)
    const scroll = harness.scroll()!
    scroll.stickyScroll = true
    scroll.scrollTo(Infinity)
    await harness.app.renderOnce()
    await settleHighlights(harness)

    // Every way the route reads the text of a part goes through `sync.readPartText`.
    const reads = new Map<string, number>()
    const { sync } = harness
    const readPartText = sync.readPartText.bind(sync)
    sync.readPartText = (part) => {
      reads.set(part.id, (reads.get(part.id) ?? 0) + 1)
      return readPartText(part)
    }

    const stream = harness.openStream()
    await harness.app.renderOnce()
    // The first words give the reply its row.
    stream.delta("first words ")
    await harness.app.renderOnce()
    await harness.app.renderOnce()

    reads.clear()
    const children = [...scroll.getChildren()]
    for (let frame = 0; frame < FRAMES; frame++) {
      stream.delta(`w${frame} `)
      harness.prompt.set({ input: String(frame % 10), parts: [] })
      await harness.app.renderOnce()
    }
    const after = [...scroll.getChildren()]

    return {
      rows: harness.fixture.rows,
      part: stream.part.id,
      reads: Object.fromEntries(reads),
      // Nothing was mounted or unmounted: the row being written is the node it was.
      sameNodes: after.length === children.length && after.every((node, index) => node === children[index]),
    }
  } finally {
    await harness.dispose()
  }
}

test("a streamed frame reads the part being written and no other, whatever the length of the session", async () => {
  const sizes = [await streamedFrame("S"), await streamedFrame("L"), await streamedFrame("XL")]

  // The sessions are as different in length as the claim needs.
  expect(sizes.map((run) => run.rows)).toEqual([48, 190, 2080])
  for (const run of sizes) {
    // Only the part being written is read.
    expect(Object.keys(run.reads)).toEqual([run.part])
    // Once per frame: the view of that part, which is the one reader that follows the stream. The row table
    // has let go of it, and it does not read the finished parts at all.
    expect(run.reads[run.part]).toBe(FRAMES)
  }
  // The same count in each: it does not grow with the session.
  expect(new Set(sizes.map((run) => run.reads[run.part])).size).toBe(1)
}, 60_000)

test("a streamed frame leaves the mounted rows of the windowed transcript alone", async () => {
  const run = await streamedFrame("XL")

  expect(run.sameNodes).toBe(true)
}, 60_000)
