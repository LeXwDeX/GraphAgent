// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { testRender } from "@opentui/solid"
import type { FrameClock } from "../../src/context/frame-clock"

type TestApp = Awaited<ReturnType<typeof testRender>>

/** One turn of the event loop: pending fetch and promise work runs, no timer is involved. */
export function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Drives the SDK frame clock by hand until `ready` holds.
 *
 * Nothing here waits for a duration. Every round flushes the frame the queued
 * events belong to (the fallback timer of the frame clock never has to fire),
 * then yields one event-loop turn so requests in flight can finish. A condition
 * that never holds fails after a bounded number of rounds, not after a
 * wall-clock timeout.
 */
export async function advanceUntil(
  sdk: { frameClock: Pick<FrameClock, "flushNow"> },
  ready: () => boolean,
  rounds = 1000,
) {
  for (let round = 0; round < rounds; round++) {
    sdk.frameClock.flushNow()
    if (ready()) return
    await nextTurn()
  }
  throw new Error(`condition not reached after ${rounds} frames`)
}

/**
 * Reads from the renderer's buffers without racing a frame that is still being presented.
 * While one is, the native buffer lease is busy and the read throws `OutputBusy`; the lease
 * frees on its own a moment later, so render again and retry instead of failing the test.
 */
export async function whenFree<T>(app: Pick<TestApp, "renderOnce">, read: () => T): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return read()
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("OutputBusy"))) throw error
      await Bun.sleep(5)
      await app.renderOnce()
    }
  }
  throw new Error("the renderer stayed busy while a frame was read")
}

/** The frame as text. */
export function readFrame(app: Pick<TestApp, "renderOnce" | "captureCharFrame">) {
  return whenFree(app, () => app.captureCharFrame())
}

/** The frame as painted spans. */
export function readSpans(app: Pick<TestApp, "renderOnce" | "captureSpans">) {
  return whenFree(app, () => app.captureSpans())
}

/**
 * How long a wait for content may take before it gives up and reports the last frame. It only bounds a wait,
 * nothing is paced by it: what a frame waits for (a file read, a fake request, a provider that gates its
 * children) finishes in real time, and a count of renders that is plenty on an idle host ends before it does
 * on a loaded one.
 */
export const FRAME_WAIT_MS = 10_000

/** Rounds of a wait that only hand the event loop a turn before it starts to sleep between them. */
const SPIN_ROUNDS = 64

/**
 * What a wait does between two attempts. A change that needs one more frame, or a promise to settle, is served by
 * a turn of the event loop. A wait still going after the first rounds is waiting for real I/O, and sleeps a little
 * so that it does not take the CPU away from it.
 */
export function pause(round: number) {
  return round < SPIN_ROUNDS ? nextTurn() : Bun.sleep(1)
}

/**
 * Renders until the frame satisfies `ready` and returns that frame. Each attempt renders first, so a change
 * that needs one more frame to show (a resize the renderer applies later, a provider that is still loading)
 * gets it, and reads the result through `readFrame`, never between two renders. Asserting on a frame that was
 * read after a fixed number of renders is what this replaces. On a timeout the error carries the last frame.
 */
export async function renderUntilFrame(
  app: Pick<TestApp, "renderOnce" | "captureCharFrame">,
  ready: (frame: string) => boolean,
  what: string,
  timeoutMs = FRAME_WAIT_MS,
) {
  const deadline = performance.now() + timeoutMs
  for (let round = 0; ; round++) {
    await app.renderOnce()
    const frame = await readFrame(app)
    if (ready(frame)) return frame
    if (performance.now() >= deadline) {
      throw new Error(`${what} was not reached within ${timeoutMs}ms; last frame:\n${frame}`)
    }
    await pause(round)
  }
}
