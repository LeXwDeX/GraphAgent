import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"

/** Animation frame interval. Matches the design prototype, about 11 fps. */
export const TICK_MS = 90
/** One-second signal interval. */
export const SECOND_MS = 1000

export interface Ticker {
  /** Animation frame; advances every `TICK_MS` while subscribed, focused and animations are enabled. */
  frame: Accessor<number>
  /** One-second signal; advances every `SECOND_MS` while subscribed. */
  second: Accessor<number>
  /** Subscribe to animation frames. Returns the unsubscribe function. */
  subscribe(): () => void
  /** Subscribe to the one-second signal. Returns the unsubscribe function. */
  subscribeSecond(): () => void
  /** Run `cb` once at the absolute time `time` (epoch milliseconds). Returns the cancel function. */
  at(time: number, cb: () => void): () => void
}

export interface TickerOptions {
  /** Read the `animations_enabled` setting; `frame` is always 0 while this returns false. */
  animationsEnabled?: Accessor<boolean>
  /** Window focus; frame ticks pause while this returns false. */
  focused?: Accessor<boolean>
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface Deadline {
  time: number
  callback: () => void
}

/**
 * TUI's only time source. `frame` drives animations, `second` drives visible
 * second-level displays, and `at` schedules one-shot callbacks.
 *
 * Timers are created only while someone is subscribed: no subscriber, no timer.
 * `setTimeout`/`setInterval` in the TUI are confined to this file, the future
 * `frame-clock.ts` and `terminal-win32.ts`.
 */
export function createTicker(options: TickerOptions = {}): Ticker {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const animationsEnabled = options.animationsEnabled ?? (() => true)
  const focused = options.focused ?? (() => true)

  const [frameCount, setFrameCount] = createSignal(0)
  const [secondCount, setSecondCount] = createSignal(0)
  const frame = createMemo(() => (animationsEnabled() ? frameCount() : 0))

  const frameSubscribers = new Set<symbol>()
  const secondSubscribers = new Set<symbol>()
  const deadlines = new Set<Deadline>()

  let handle: ReturnType<typeof setTimeout> | undefined
  let armedFor: number | undefined
  let lastFrameAt = now()
  let lastSecondAt = now()

  const frameActive = () => frameSubscribers.size > 0 && animationsEnabled() && focused()

  function nextDeadline() {
    let next: number | undefined
    if (frameActive()) next = lastFrameAt + TICK_MS
    if (secondSubscribers.size > 0) {
      const second = lastSecondAt + SECOND_MS
      next = next === undefined ? second : Math.min(next, second)
    }
    for (const deadline of deadlines) next = next === undefined ? deadline.time : Math.min(next, deadline.time)
    return next
  }

  function arm() {
    const next = nextDeadline()
    if (next === undefined) {
      if (handle !== undefined) clearTimer(handle)
      handle = undefined
      armedFor = undefined
      return
    }
    if (handle !== undefined && armedFor === next) return
    if (handle !== undefined) clearTimer(handle)
    armedFor = next
    handle = setTimer(tick, Math.max(0, next - now()))
  }

  function tick() {
    handle = undefined
    armedFor = undefined
    const at = now()
    if (frameActive() && at >= lastFrameAt + TICK_MS) {
      lastFrameAt = at
      setFrameCount((value) => value + 1)
    }
    if (secondSubscribers.size > 0 && at >= lastSecondAt + SECOND_MS) {
      lastSecondAt = at
      setSecondCount((value) => value + 1)
    }
    for (const deadline of [...deadlines]) {
      if (at < deadline.time) continue
      deadlines.delete(deadline)
      deadline.callback()
    }
    arm()
  }

  function subscribeTo(subscribers: Set<symbol>, onFirst: () => void) {
    const key = Symbol()
    subscribers.add(key)
    if (subscribers.size === 1) onFirst()
    arm()
    return () => {
      if (!subscribers.delete(key)) return
      arm()
    }
  }

  function subscribe() {
    return subscribeTo(frameSubscribers, () => {
      lastFrameAt = now()
    })
  }

  function subscribeSecond() {
    return subscribeTo(secondSubscribers, () => {
      lastSecondAt = now()
    })
  }

  function at(time: number, callback: () => void) {
    const deadline: Deadline = { time, callback }
    deadlines.add(deadline)
    arm()
    return () => {
      if (!deadlines.delete(deadline)) return
      arm()
    }
  }

  createEffect(() => {
    animationsEnabled()
    focused()
    arm()
  })

  return { frame, second: secondCount, subscribe, subscribeSecond, at }
}
