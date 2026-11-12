// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { FrameClock } from "../../src/context/frame-clock"

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
