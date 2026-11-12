// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createFixture, type PerfFixture } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"

// Leaving a session keeps its messages in the sync store (the hydrated sessions
// outlive the route), so the route that is created when the user comes back builds
// its row table over a store that is already full. A binding that table reads while
// it is built must have been declared by then.

// The renderer can still hold its output buffer right after a navigation. The native
// lease is transient, so retry instead of failing (or treating the frame as empty,
// which would make "content is gone" assertions pass early).
async function captureFrame(harness: PerfHarness): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return harness.app.captureCharFrame()
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("OutputBusy"))) throw error
      await Bun.sleep(5)
      await harness.app.renderOnce()
    }
  }
  throw new Error("renderer stayed busy while capturing a frame")
}

async function waitForFrame(harness: PerfHarness, text: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await harness.app.renderOnce()
    if ((await captureFrame(harness)).includes(text)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${text}:\n${await captureFrame(harness)}`)
}

async function waitForFrameGone(harness: PerfHarness, text: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await harness.app.renderOnce()
    if (!(await captureFrame(harness)).includes(text)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${text} to disappear:\n${await captureFrame(harness)}`)
}

/** Session, then home, then the same session again; the transcript must be on screen each time it should be. */
async function leaveAndReturn(fixture: PerfFixture) {
  const harness = await mountHarness(fixture, { routes: true })
  try {
    await waitForFrame(harness, "Deterministic answer 23")

    harness.navigate({ type: "home" })
    await waitForFrameGone(harness, "Deterministic answer 23")
    // Home is the app's other route, not an empty frame.
    expect(await captureFrame(harness)).toContain("Ask anything")

    expect(() => harness.navigate({ type: "session", sessionID: fixture.session.id })).not.toThrow()
    await waitForFrame(harness, "Deterministic answer 23")

    // And once more, to be sure the second return is no different from the first.
    harness.navigate({ type: "home" })
    await waitForFrameGone(harness, "Deterministic answer 23")
    expect(() => harness.navigate({ type: "session", sessionID: fixture.session.id })).not.toThrow()
    await waitForFrame(harness, "Deterministic answer 23")
  } finally {
    await harness.dispose()
  }
}

test("coming back to a loaded session with tool calls renders its transcript", async () => {
  // Tool rows make the row table read the tool-details setting while it is built.
  await leaveAndReturn(createFixture("S"))
})

test("coming back to a loaded session that is all text renders its transcript", async () => {
  // Without tool rows the first thing the row table reads is the terminal width.
  const fixture = createFixture("S")
  for (const message of fixture.messages) message.parts = message.parts.filter((part) => part.type === "text")
  await leaveAndReturn(fixture)
})
