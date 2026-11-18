// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { coalesce, runningTail } from "../../src/session/shell"

/**
 * What an explicit `!cmd` shows while it runs (#1446): the tail of its output,
 * published at a bounded rate. The final output is bounded separately, when
 * the command ends.
 */

describe("runningTail", () => {
  test("shows a short output as it is", () => {
    expect(runningTail("")).toBe("")
    expect(runningTail("hello")).toBe("hello")
    expect(runningTail("x".repeat(30_000))).toBe("x".repeat(30_000))
  })

  test("shows only the end of a long output, marked as cut at the start", () => {
    const text = "a".repeat(10) + "b".repeat(30_000)

    const tail = runningTail(text)

    expect(tail).toBe("...\n\n" + "b".repeat(30_000))
    expect(tail.length).toBe(30_005)
  })
})

describe("coalesce", () => {
  /** A clock the test moves by hand, and a publish that counts. */
  const setup = () => {
    let time = 10_000
    let published = 0
    const live = coalesce(
      Effect.sync(() => {
        published++
      }),
      () => time,
    )
    return {
      live,
      advance: (ms: number) => {
        time += ms
      },
      published: () => published,
    }
  }

  test("publishes the first touch at once", () => {
    const { live, published } = setup()

    Effect.runSync(live.touch)

    expect(published()).toBe(1)
  })

  test("holds touches that come within the interval and publishes them on a tick once it has passed", () => {
    const { live, advance, published } = setup()
    Effect.runSync(live.touch)

    advance(50)
    Effect.runSync(live.touch)
    Effect.runSync(live.touch)
    expect(published()).toBe(1)

    // The interval has not passed since the last publish: a tick does not publish what waits yet.
    advance(100)
    Effect.runSync(live.tick)
    expect(published()).toBe(1)

    advance(50)
    Effect.runSync(live.tick)
    expect(published()).toBe(2)
  })

  test("publishes a touch that comes after the interval, with nothing left waiting", () => {
    const { live, advance, published } = setup()
    Effect.runSync(live.touch)

    advance(200)
    Effect.runSync(live.touch)
    expect(published()).toBe(2)

    advance(200)
    Effect.runSync(live.tick)
    expect(published()).toBe(2)
  })

  test("a tick with nothing waiting publishes nothing", () => {
    const { live, advance, published } = setup()
    Effect.runSync(live.touch)

    advance(1_000)
    Effect.runSync(live.tick)

    expect(published()).toBe(1)
  })

  test("never publishes twice within the interval, however many touches and ticks come", () => {
    let now = 0
    const times: number[] = []
    const live = coalesce(
      Effect.sync(() => {
        times.push(now)
      }),
      () => now,
    )

    for (now = 0; now <= 2_000; now += 7) {
      Effect.runSync(live.touch)
      if (now % 49 === 0) Effect.runSync(live.tick)
    }

    expect(times.length).toBeGreaterThan(1)
    for (let index = 1; index < times.length; index++) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(200)
    }
  })
})
