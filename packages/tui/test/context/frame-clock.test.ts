// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createFrameClock, FRAME_FALLBACK_MS } from "../../src/context/frame-clock"

function manualTimers() {
  const pending = new Map<number, () => void>()
  const cleared: number[] = []
  let next = 0
  return {
    setTimer: (callback: () => void) => {
      const handle = ++next
      pending.set(handle, callback)
      return handle
    },
    clearTimer: (handle: unknown) => {
      if (typeof handle !== "number") throw new Error("unexpected timer handle")
      cleared.push(handle)
      pending.delete(handle)
    },
    fire() {
      const callbacks = Array.from(pending.values())
      pending.clear()
      for (const callback of callbacks) callback()
    },
    get size() {
      return pending.size
    },
    cleared,
  }
}

describe("frame clock", () => {
  test("runs scheduled work once per frame, in order", () => {
    const timers = manualTimers()
    const clock = createFrameClock({ setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    const order: string[] = []
    clock.schedule(() => order.push("a"))
    clock.schedule(() => order.push("b"))
    expect(order).toEqual([])
    expect(timers.size).toBe(1)

    timers.fire()
    expect(order).toEqual(["a", "b"])
    expect(timers.size).toBe(0)

    timers.fire()
    expect(order).toEqual(["a", "b"])
    clock.dispose()
  })

  test("requests a render and falls back to the frame timer", () => {
    const timers = manualTimers()
    let renders = 0
    const clock = createFrameClock({
      requestRender: () => renders++,
      setTimer: (callback) => timers.setTimer(callback),
      clearTimer: timers.clearTimer,
    })
    clock.schedule(() => {})
    expect(renders).toBe(1)
    expect(timers.size).toBe(1)
    clock.schedule(() => {})
    expect(renders).toBe(1)
    clock.dispose()
  })

  test("flushNow runs queued work without waiting for a frame", () => {
    const timers = manualTimers()
    const clock = createFrameClock({ setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    let runs = 0
    clock.schedule(() => runs++)
    clock.flushNow()
    expect(runs).toBe(1)
    expect(timers.size).toBe(0)
    clock.flushNow()
    expect(runs).toBe(1)
    clock.dispose()
  })

  test("work scheduled during a flush runs on the next frame", () => {
    const timers = manualTimers()
    const clock = createFrameClock({ setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    const order: string[] = []
    clock.schedule(() => {
      order.push("first")
      clock.schedule(() => order.push("second"))
    })
    timers.fire()
    expect(order).toEqual(["first"])
    expect(timers.size).toBe(1)
    timers.fire()
    expect(order).toEqual(["first", "second"])
    clock.dispose()
  })

  test("notifies flush listeners only when work ran", () => {
    const timers = manualTimers()
    const clock = createFrameClock({ setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    let flushes = 0
    const unsubscribe = clock.onFlush(() => flushes++)
    clock.flushNow()
    expect(flushes).toBe(0)

    clock.schedule(() => {})
    clock.flushNow()
    expect(flushes).toBe(1)

    unsubscribe()
    clock.schedule(() => {})
    clock.flushNow()
    expect(flushes).toBe(1)
    clock.dispose()
  })

  test("an external lifecycle pass consumes the queue and cancels the fallback timer", () => {
    const timers = manualTimers()
    let pass: (() => void) | undefined
    const clock = createFrameClock({
      registerPass(run) {
        pass = run
        return () => {
          pass = undefined
        }
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    let runs = 0
    clock.schedule(() => runs++)
    expect(timers.size).toBe(1)

    pass!()
    expect(runs).toBe(1)
    expect(timers.size).toBe(0)
    expect(timers.cleared).toHaveLength(1)
    clock.dispose()
  })

  test("dispose drops queued work, cancels the timer, and unregisters the pass", () => {
    const timers = manualTimers()
    let unregistered = 0
    const clock = createFrameClock({
      registerPass() {
        return () => unregistered++
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    let runs = 0
    clock.schedule(() => runs++)
    clock.dispose()
    expect(unregistered).toBe(1)
    expect(timers.size).toBe(0)
    timers.fire()
    expect(runs).toBe(0)
  })

  test("exports the 16ms fallback budget", () => {
    expect(FRAME_FALLBACK_MS).toBe(16)
  })
})
