// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Longest a scenario waits for background work, such as an async syntax highlight, before failing the run. */
export const SETTLE_DEADLINE_MS = 15_000

/**
 * Awaits `work`, but fails with a message instead of hanging the job when it
 * never settles. The deadline is wall-clock on purpose: it bounds a hang, it
 * does not time a measurement.
 */
export async function within<T>(work: Promise<T>, what: string, deadlineMs = SETTLE_DEADLINE_MS): Promise<T> {
  const deadline = AbortSignal.timeout(deadlineMs)
  let onAbort: (() => void) | undefined
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(`${what} did not settle within ${deadlineMs} ms`))
    deadline.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort)
  }
}
