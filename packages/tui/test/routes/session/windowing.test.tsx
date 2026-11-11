// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { createFixture, updatePartEvent } from "../../perf/fixtures"
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

async function frameWithout(harness: Awaited<ReturnType<typeof mountHarness>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await harness.app.renderOnce()
    const frame = harness.app.captureCharFrame()
    if (!frame.includes(text)) return frame
    await Bun.sleep(1)
  }
  throw new Error(`frame always contained ${text}:\n${harness.app.captureCharFrame()}`)
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

test("a running tool spins only while its row sits inside the viewport", async () => {
  const harness = await mountHarness(createFixture("L"))
  try {
    await harness.reset()
    // Same 50ms scroll-to-bottom after mount as the windowing test above.
    await Bun.sleep(60)
    const scroll = harness.scroll()
    expect(scroll).toBeDefined()
    scroll!.stickyScroll = false
    scroll!.scrollTo(Infinity)
    await frameContaining(harness, "printf perf-395")

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
    const hidden = await frameWithout(harness, "spinner-fixture")
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
