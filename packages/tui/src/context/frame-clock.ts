// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Frame-aligned work queue (#886 5.2).
 *
 * The worker already merges events into ~16ms batches. This clock is the only
 * client-side queue: everything scheduled inside one render frame runs once,
 * in order, right before the next layout. `flushNow` bypasses the wait for
 * urgent events (permission and question prompts).
 *
 * `setTimeout` is used only as a fallback when the renderer does not produce a
 * lifecycle pass; the allow-list is `context/ticker.ts`, this file and
 * `terminal-win32.ts`.
 */

export const FRAME_FALLBACK_MS = 16

export interface FrameClockOptions {
  /** Called when a frame is needed, e.g. `renderer.requestRender`. */
  requestRender?: () => void
  /**
   * Register a callback that runs before the next layout. Returns an
   * unsubscribe function. When absent, the fallback timer is the only wake-up.
   */
  registerPass?: (run: () => void) => () => void
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface FrameClock {
  /** Run `fn` before the next frame. Multiple calls in one frame run in order. */
  schedule(fn: () => void): void
  /** Run everything queued now, without waiting for a frame. */
  flushNow(): void
  /** Run after a flush that processed work. Returns the unsubscribe function. */
  onFlush(fn: () => void): () => void
  dispose(): void
}

export function createFrameClock(options: FrameClockOptions = {}): FrameClock {
  const scheduleTimer =
    options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay) as unknown)
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- timer handles are opaque; the value is passed back exactly as `setTimer` returned it.
  const cancelDefault = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  const cancelTimer = options.clearTimer ?? cancelDefault

  let queue: Array<() => void> = []
  let scheduled = false
  let flushing = false
  let timer: unknown
  const listeners = new Set<() => void>()

  function clearPendingTimer() {
    if (timer === undefined) return
    cancelTimer(timer)
    timer = undefined
  }

  function flush() {
    if (flushing) return
    if (queue.length === 0) {
      scheduled = false
      clearPendingTimer()
      return
    }
    flushing = true
    try {
      const jobs = queue
      queue = []
      scheduled = false
      clearPendingTimer()
      for (const job of jobs) job()
      for (const listener of Array.from(listeners)) listener()
    } finally {
      flushing = false
    }
    // Work scheduled by a job belongs to the next frame.
    if (queue.length > 0) arm()
  }

  function arm() {
    if (scheduled) return
    scheduled = true
    options.requestRender?.()
    timer = scheduleTimer(flush, FRAME_FALLBACK_MS)
  }

  const unregisterPass = options.registerPass?.(flush)

  return {
    schedule(fn) {
      queue.push(fn)
      arm()
    },
    flushNow() {
      if (queue.length === 0) return
      flush()
    },
    onFlush(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    dispose() {
      queue = []
      scheduled = false
      clearPendingTimer()
      listeners.clear()
      unregisterPass?.()
    },
  }
}
