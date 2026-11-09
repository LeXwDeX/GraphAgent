// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createInterestAggregator } from "../../src/context/interest"

function manualFrame() {
  let pending: (() => void) | undefined
  return {
    schedule(fn: () => void) {
      pending = fn
    },
    flush() {
      const run = pending
      pending = undefined
      run?.()
    },
    get pending() {
      return pending !== undefined
    },
  }
}

describe("interest aggregator", () => {
  test("submits the sorted union of every source after the frame flushes", async () => {
    const submits: string[][] = []
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
      },
      frame,
    })

    const route = interest.set("route", ["ses_b", "ses_a"])
    expect(submits).toEqual([])
    frame.flush()
    await route
    expect(submits).toEqual([["ses_a", "ses_b"]])

    // Same content from the same source resolves without touching the worker.
    await interest.set("route", ["ses_a", "ses_b"])
    expect(submits).toEqual([["ses_a", "ses_b"]])
    interest.dispose()
  })

  test("coalesces several source changes in one frame into one submit", async () => {
    const submits: string[][] = []
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
      },
      frame,
    })

    const route = interest.set("route", ["ses_b", "ses_a"])
    const hydrated = interest.set("hydrated", ["ses_c"])
    expect(frame.pending).toBe(true)
    frame.flush()
    await Promise.all([route, hydrated])
    expect(submits).toEqual([["ses_a", "ses_b", "ses_c"]])
    interest.dispose()
  })

  test("skips the submit when the union did not change", async () => {
    const submits: string[][] = []
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
      },
      frame,
    })

    const route = interest.set("route", ["ses_a"])
    frame.flush()
    await route

    const hydrated = interest.set("hydrated", ["ses_a"])
    frame.flush()
    await hydrated
    expect(submits).toEqual([["ses_a"]])
    interest.dispose()
  })

  test("resolves set only after the worker confirmed the union", async () => {
    let release!: () => void
    const confirmation = new Promise<void>((resolve) => {
      release = resolve
    })
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: () => confirmation,
      frame,
    })

    let resolved = false
    const done = interest.set("route", ["ses_a"]).then(() => {
      resolved = true
    })
    frame.flush()
    await Bun.sleep(0)
    expect(resolved).toBe(false)

    release()
    await done
    expect(resolved).toBe(true)
    interest.dispose()
  })

  test("reruns when sources change during an in-flight submit", async () => {
    const submits: string[][] = []
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
        if (submits.length === 1) await first
      },
      frame,
    })

    const route = interest.set("route", ["ses_a"])
    frame.flush()
    await Bun.sleep(0)
    expect(submits).toEqual([["ses_a"]])

    const hydrated = interest.set("hydrated", ["ses_b"])
    release()
    await Bun.sleep(0)
    expect(frame.pending).toBe(true)
    frame.flush()
    await Promise.all([route, hydrated])
    expect(submits).toEqual([["ses_a"], ["ses_a", "ses_b"]])
    interest.dispose()
  })

  test("rejects waiters when the submit fails, then accepts the next change", async () => {
    const submits: string[][] = []
    let fail = true
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
        if (fail) {
          fail = false
          throw new Error("worker unavailable")
        }
      },
      frame,
    })

    const rejection = interest.set("route", ["ses_a"]).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    frame.flush()
    expect(await rejection).toBe("worker unavailable")

    const accepted = interest.set("route", ["ses_a", "ses_b"])
    frame.flush()
    await accepted
    expect(submits).toEqual([["ses_a"], ["ses_a", "ses_b"]])
    interest.dispose()
  })

  test("submits the empty set when the last source is deleted", async () => {
    const submits: string[][] = []
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
      },
      frame,
    })

    const route = interest.set("route", ["ses_a"])
    frame.flush()
    await route

    const removed = interest.delete("route")
    frame.flush()
    await removed
    expect(submits).toEqual([["ses_a"], []])
    expect(interest.explicit().size).toBe(0)
    interest.dispose()
  })

  test("full adds pending-ask sessions that the worker does not receive", async () => {
    const submits: string[][] = []
    const frame = manualFrame()
    let asks = new Set<string>()
    const interest = createInterestAggregator({
      submit: async (full) => {
        submits.push([...full])
      },
      pendingAsks: () => asks,
      frame,
    })

    const route = interest.set("route", ["ses_a"])
    frame.flush()
    await route
    expect([...interest.explicit()]).toEqual(["ses_a"])
    expect([...interest.full()]).toEqual(["ses_a"])

    asks = new Set(["ses_ask"])
    expect([...interest.full()].toSorted()).toEqual(["ses_a", "ses_ask"])
    interest.refresh()
    expect(frame.pending).toBe(true)
    frame.flush()
    await Promise.resolve()
    expect(submits).toEqual([["ses_a"]])
    interest.dispose()
  })

  test("dispose resolves outstanding waiters", async () => {
    const frame = manualFrame()
    const interest = createInterestAggregator({
      submit: () => new Promise<void>(() => {}),
      frame,
    })

    const pending = interest.set("route", ["ses_a"])
    frame.flush()
    await Bun.sleep(0)
    interest.dispose()
    await pending
  })
})
