// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { SECOND_MS, TICK_MS, createTicker } from "../../src/context/ticker"

function fakeClock() {
  let current = 1_000_000
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => current,
    setTimer: (callback: () => void, delay: number) => {
      const id = ++nextId
      timers.set(id, { at: current + delay, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    },
    advance(ms: number) {
      const target = current + ms
      while (true) {
        let due: { id: number; at: number; callback: () => void } | undefined
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!due || timer.at < due.at)) due = { id, ...timer }
        }
        if (!due) break
        timers.delete(due.id)
        current = due.at
        due.callback()
      }
      current = target
    },
    pending: () => timers.size,
  }
}

test("frame stays at zero while animations are disabled and creates no timer", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const [enabled] = createSignal(false)
    const ticker = createTicker({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      animationsEnabled: enabled,
    })
    const unsubscribe = ticker.subscribe()
    clock.advance(TICK_MS * 10)
    expect(ticker.frame()).toBe(0)
    expect(clock.pending()).toBe(0)
    unsubscribe()
    dispose()
  })
})

test("frame advances while subscribed and pauses after unsubscribe", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const ticker = createTicker({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const unsubscribe = ticker.subscribe()
    clock.advance(TICK_MS)
    expect(ticker.frame()).toBe(1)
    clock.advance(TICK_MS * 2)
    expect(ticker.frame()).toBe(3)
    unsubscribe()
    expect(clock.pending()).toBe(0)
    clock.advance(TICK_MS * 5)
    expect(ticker.frame()).toBe(3)
    dispose()
  })
})

test("frame pauses while the window is blurred", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const [focused, setFocused] = createSignal(true)
    const ticker = createTicker({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      focused,
    })
    const unsubscribe = ticker.subscribe()
    clock.advance(TICK_MS)
    expect(ticker.frame()).toBe(1)
    setFocused(false)
    // The next tick observes the blur, does not advance and stops the timer.
    clock.advance(TICK_MS)
    expect(ticker.frame()).toBe(1)
    expect(clock.pending()).toBe(0)
    clock.advance(TICK_MS * 3)
    expect(ticker.frame()).toBe(1)
    unsubscribe()
    dispose()
  })
})

test("second creates no timer without subscribers", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const ticker = createTicker({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    clock.advance(SECOND_MS * 5)
    expect(clock.pending()).toBe(0)
    expect(ticker.second()).toBe(0)
    dispose()
  })
})

test("second advances every second while subscribed", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const ticker = createTicker({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const unsubscribe = ticker.subscribeSecond()
    clock.advance(SECOND_MS)
    expect(ticker.second()).toBe(1)
    clock.advance(SECOND_MS * 2)
    expect(ticker.second()).toBe(3)
    unsubscribe()
    expect(clock.pending()).toBe(0)
    clock.advance(SECOND_MS * 3)
    expect(ticker.second()).toBe(3)
    dispose()
  })
})

test("at runs once at the deadline and can be cancelled", () => {
  createRoot((dispose) => {
    const clock = fakeClock()
    const ticker = createTicker({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    let calls = 0
    ticker.at(clock.now() + 50, () => calls++)
    clock.advance(49)
    expect(calls).toBe(0)
    clock.advance(1)
    expect(calls).toBe(1)
    clock.advance(100)
    expect(calls).toBe(1)

    const cancel = ticker.at(clock.now() + 10, () => calls++)
    cancel()
    expect(clock.pending()).toBe(0)
    clock.advance(20)
    expect(calls).toBe(1)
    dispose()
  })
})
