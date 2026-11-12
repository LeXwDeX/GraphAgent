// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@graphagent/sdk"
import { createComputed, createRoot, createSignal, onMount } from "solid-js"
import { SDKProvider, useSDK, type EventSource } from "../../src/context/sdk"
import { createFetch, directory } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"

function event(id: string, type = "vcs.branch.updated"): GlobalEvent {
  return {
    directory,
    payload: { id, type, properties: type === "vcs.branch.updated" ? { branch: id } : {} },
  } as unknown as GlobalEvent
}

async function mount(source: EventSource) {
  const seen: string[] = []
  let ready!: () => void
  let sdk!: ReturnType<typeof useSDK>
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sdk = useSDK()
    onMount(() => {
      sdk.event.on("event", (evt) => seen.push(evt.payload.id!))
      void sdk.setInterest(["ses_a"]).then(ready)
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={source} fetch={createFetch().fetch}>
        <Probe />
      </SDKProvider>
    </TestTuiContexts>
  ))
  await mounted
  return { app, seen, sdk }
}

describe("SDK event transport", () => {
  test("prefers a worker batch and flushes it as one frame batch", async () => {
    let handler: ((events: GlobalEvent[]) => void) | undefined
    const source: EventSource = {
      subscribe: async () => () => {},
      subscribeBatch: async (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
      setInterest: async () => {},
    }
    const { app, seen, sdk } = await mount(source)

    try {
      handler!([event("evt_1"), event("evt_2")])
      // The frame clock owns the batch; until it flushes nothing is emitted.
      expect(seen).toEqual([])
      sdk.frameClock.flushNow()
      expect(seen).toEqual(["evt_1", "evt_2"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("forwards setInterest through the event source", async () => {
    const interest: Array<readonly string[]> = []
    const source: EventSource = {
      subscribe: async () => () => {},
      setInterest: async (full) => {
        interest.push(full)
      },
    }
    const { app } = await mount(source)

    try {
      expect(interest).toEqual([["ses_a"]])
    } finally {
      app.renderer.destroy()
    }
  })

  test("falls back to per-event subscription for sources without batching", async () => {
    let handler: ((event: GlobalEvent) => void) | undefined
    const source: EventSource = {
      subscribe: async (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    }
    const { app, seen, sdk } = await mount(source)

    try {
      handler!(event("evt_3"))
      sdk.frameClock.flushNow()
      expect(seen).toEqual(["evt_3"])
    } finally {
      app.renderer.destroy()
    }
  })
})

/** A worker source whose batch handler the test drives by hand. */
function batchSource() {
  let handler: ((events: GlobalEvent[]) => void) | undefined
  const source: EventSource = {
    subscribe: async () => () => {},
    subscribeBatch: async (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
    setInterest: async () => {},
  }
  return { source, push: (events: GlobalEvent[]) => handler!(events) }
}

/**
 * Watches what one frame does to reactive state. Every delivered event writes a
 * signal; a computation reading it reruns once per flush of pending updates, so
 * `batches()` equals the number of `batch()` calls that wrote. `frames()` counts
 * the frame-clock flushes that processed work.
 */
function watchFrames(sdk: ReturnType<typeof useSDK>) {
  const order: string[] = []
  const [delivered, setDelivered] = createSignal(0)
  let runs = 0
  const stopComputation = createRoot((dispose) => {
    createComputed(() => {
      delivered()
      runs++
    })
    return dispose
  })
  const stopEvents = sdk.event.on("event", (evt) => {
    order.push(evt.payload.id)
    setDelivered((count) => count + 1)
  })
  let frameFlushes = 0
  const stopFrames = sdk.frameClock.onFlush(() => {
    frameFlushes++
  })
  return {
    order,
    delivered: () => order.length,
    /** Reactive flushes since watching started; the initial computation run is not one. */
    batches: () => runs - 1,
    frames: () => frameFlushes,
    stop() {
      stopEvents()
      stopFrames()
      stopComputation()
    },
  }
}

function ids(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`)
}

describe("frame batching", () => {
  test("100 events of one worker batch are written in a single batch on the next frame", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      const expected = ids("evt", 100)
      push(expected.map((id) => event(id)))
      // Nothing is applied before the frame.
      expect(watch.delivered()).toBe(0)
      expect(watch.batches()).toBe(0)

      await app.renderOnce()
      expect(watch.order).toEqual(expected)
      expect(watch.batches()).toBe(1)
      expect(watch.frames()).toBe(1)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })

  test("100 single-event messages of one frame are also written in a single batch", async () => {
    let handler: ((event: GlobalEvent) => void) | undefined
    const source: EventSource = {
      subscribe: async (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    }
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      const expected = ids("evt", 100)
      for (const id of expected) handler!(event(id))
      expect(watch.delivered()).toBe(0)

      await app.renderOnce()
      expect(watch.order).toEqual(expected)
      expect(watch.batches()).toBe(1)
      expect(watch.frames()).toBe(1)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })

  test("events of two frames are written in two batches, in order", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      const first = ids("first", 50)
      const second = ids("second", 50)
      push(first.map((id) => event(id)))
      await app.renderOnce()
      expect(watch.batches()).toBe(1)

      push(second.map((id) => event(id)))
      await app.renderOnce()
      expect(watch.order).toEqual([...first, ...second])
      expect(watch.batches()).toBe(2)
      expect(watch.frames()).toBe(2)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })

  test("high-volume event types wait for the frame", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)
    const types = [
      "message.part.delta",
      "message.part.updated",
      "message.updated",
      "todo.updated",
      "vcs.branch.updated",
      "session.created",
    ]

    try {
      types.forEach((type, index) => push([event(`evt_${index}`, type)]))
      expect(watch.delivered()).toBe(0)
      expect(watch.frames()).toBe(0)

      await app.renderOnce()
      expect(watch.delivered()).toBe(types.length)
      expect(watch.batches()).toBe(1)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })
})

describe("urgent events", () => {
  // Permission and question prompts block the agent: they must not sit behind a frame.
  const urgent = [
    "permission.asked",
    "permission.replied",
    "question.asked",
    "question.replied",
    "question.rejected",
    "question.timed_out",
    "session.status",
    "session.idle",
    "session.error",
  ]

  test("are delivered at once, without a frame", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      urgent.forEach((type, index) => {
        push([event(`evt_${index}`, type)])
        expect(watch.delivered(), type).toBe(index + 1)
      })
      // No frame was rendered: every delivery came from `flushNow`.
      expect(watch.frames()).toBe(urgent.length)
      expect(watch.batches()).toBe(urgent.length)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })

  test("flush the events queued before them, in order, as one batch", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      const before = ids("evt", 50)
      push(before.map((id) => event(id)))
      expect(watch.delivered()).toBe(0)

      push([event("evt_ask", "permission.asked")])
      expect(watch.order).toEqual([...before, "evt_ask"])
      expect(watch.batches()).toBe(1)
      expect(watch.frames()).toBe(1)

      // The frame that follows has nothing left to flush.
      await app.renderOnce()
      expect(watch.delivered()).toBe(51)
      expect(watch.batches()).toBe(1)
      expect(watch.frames()).toBe(1)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })

  test("share one worker batch with ordinary events without splitting it", async () => {
    const { source, push } = batchSource()
    const { app, sdk } = await mount(source)
    const watch = watchFrames(sdk)

    try {
      push([event("evt_a"), event("evt_ask", "question.asked"), event("evt_b")])
      expect(watch.order).toEqual(["evt_a", "evt_ask", "evt_b"])
      expect(watch.batches()).toBe(1)
    } finally {
      watch.stop()
      app.renderer.destroy()
    }
  })
})
