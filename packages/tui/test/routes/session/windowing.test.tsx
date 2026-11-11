// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createFixture } from "../../perf/fixtures"
import { mountHarness } from "../../perf/harness"

async function frameContaining(harness: Awaited<ReturnType<typeof mountHarness>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const frame = harness.app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(1)
  }
  throw new Error(`frame never contained ${text}:\n${harness.app.captureCharFrame()}`)
}

test("windowed transcript mounts a bounded row set and follows the viewport", async () => {
  const harness = await mountHarness(createFixture("L"))
  try {
    await harness.reset()
    // The session route scrolls to the last message 50ms after mount. Let that
    // timer run before driving the viewport, or it fires mid-assertion.
    await Bun.sleep(60)
    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = true
    scroll!.scrollTo(Infinity)
    await frameContaining(harness, "printf perf-395")
    expect(harness.counters.mountedNodes(harness.app.renderer.root)).toBeLessThan(300)

    scroll!.stickyScroll = false
    scroll!.scrollTo(0)
    await frameContaining(harness, "Deterministic answer 300")

    const frame = harness.app.captureCharFrame()
    expect(frame).not.toContain("printf perf-395")
    expect(scroll!.scrollTop).toBe(0)
    expect(harness.counters.mountedNodes(harness.app.renderer.root)).toBeLessThan(300)
    expect(scroll!.getChildren().length).toBeLessThan(120)
  } finally {
    await harness.dispose()
  }
})