// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { within } from "./settle"

/** The message the work ended with: its value, or what it rejected with. */
function outcome(work: Promise<unknown>) {
  return work.then(
    (value) => `resolved ${String(value)}`,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  )
}

test("work that settles in time resolves with its value", async () => {
  expect(await outcome(within(Promise.resolve(42), "work", 1_000))).toBe("resolved 42")
})

test("work that rejects keeps its own error", async () => {
  expect(await outcome(within(Promise.reject(new Error("boom")), "work", 1_000))).toBe("boom")
})

test("work that never settles fails with what it was waiting for", async () => {
  expect(await outcome(within(new Promise<never>(() => {}), "code block highlighting", 20))).toBe(
    "code block highlighting did not settle within 20 ms",
  )
})
