// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import type { Part } from "@graphagent/sdk"
import { TICK_MS } from "../../src/context/ticker"
import { type FixtureSize, updatePartEvent } from "./fixtures"
import type { PerfHarness } from "./harness"

export const SCENARIO_IDS = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P5'",
  "P6",
  "P7",
  "P8",
  "P8'",
  "P9",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
  "P16",
  "P17",
  "P17b",
  "P18",
  "P19",
  "P20",
] as const

export type ScenarioID = (typeof SCENARIO_IDS)[number]
export type ScenarioResult = {
  id: ScenarioID
  size: FixtureSize
  [metric: string]: number | string
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0
  const ordered = values.toSorted((a, b) => a - b)
  return Number(ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)].toFixed(2))
}

async function action(harness: PerfHarness, key: string) {
  const start = performance.now()
  harness.app.mockInput.pressKey(key)
  await harness.app.renderOnce()
  return performance.now() - start
}

async function typeText(harness: PerfHarness, text: string) {
  const times: number[] = []
  for (const key of text) times.push(await action(harness, key))
  return times
}

function result(id: ScenarioID, size: FixtureSize, values: Record<string, number>): ScenarioResult {
  return { id, size, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value.toFixed(2))])) }
}

/**
 * Animation frames produced by the shared ticker over `ms`. The ticker arms
 * itself only while a visible spinner holds a subscription, so an idle screen
 * or a hidden bottom zone advances virtual time without a single frame.
 */
async function tickerFrames(harness: PerfHarness, ms: number) {
  await harness.app.renderOnce()
  const before = harness.ticker.frame()
  harness.clock.advance(ms)
  await harness.app.renderOnce()
  return harness.ticker.frame() - before
}

function runningToolPart(index: number, sessionID: string, messageID: string): Part {
  const output = `spinner-${index} output\n${"line ".repeat(30)}`
  return {
    id: `prt_offscreen_spinner_${index}`,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_offscreen_spinner_${index}`,
    tool: "bash",
    state: {
      status: "running",
      input: { command: `spinner-${index}` },
      metadata: { output },
      time: { start: 1 },
    },
  }
}

/** Adds `count` running tool parts at the transcript tail, then scrolls to the top. */
async function addOffscreenSpinners(harness: PerfHarness, count: number) {
  const messageID = harness.fixture.messages.at(-1)!.info.id
  for (let index = 0; index < count; index++) {
    harness.emit(
      updatePartEvent(
        runningToolPart(index, harness.fixture.session.id, messageID),
        10 + index,
        `evt_offscreen_spinner_${index}`,
      ),
    )
  }
  const scroll = harness.scroll()
  if (!scroll) return
  scroll.stickyScroll = false
  scroll.scrollTo(0)
  await harness.app.renderOnce()
  await Bun.sleep(10)
  await harness.app.renderOnce()
}

export async function runCharacterProfile(harness: PerfHarness): Promise<ScenarioResult> {
  await harness.reset()
  const values = await typeText(harness, "a")
  return result("P1", harness.fixture.size, { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) })
}

export async function runSlashProfile(harness: PerfHarness): Promise<ScenarioResult> {
  await harness.reset()
  const values = await typeText(harness, "/mod")
  await action(harness, "ESCAPE")
  return result("P5", harness.fixture.size, { openP95Ms: percentile(values.slice(0, 1), 0.95), sequenceP95Ms: percentile(values, 0.95) })
}

export async function runScenarios(harness: PerfHarness): Promise<ScenarioResult[]> {
  const size = harness.fixture.size
  const all: ScenarioResult[] = []

  await harness.reset()
  const p1Before = harness.snapshot()
  // 200 keystrokes: at 50 samples p95 is the 48th value and moves with a
  // single scheduler hiccup, which made the 1.30x gate flaky.
  const p1 = await typeText(harness, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX".repeat(4))
  const p1After = harness.snapshot()
  all.push(result("P1", size, { p50Ms: percentile(p1, 0.5), p95Ms: percentile(p1, 0.95), p99Ms: percentile(p1, 0.99) }))
  all.push(
    result("P3", size, {
      registerLayer: harness.counters.delta(p1Before).registerLayer,
    }),
  )
  all.push(
    result("P4", size, {
      selectorEvaluations: harness.counters.delta(p1Before).selectorEvaluations,
      selectorEvaluationsPerKey: harness.counters.delta(p1Before).selectorEvaluations / 200,
    }),
  )
  void p1After

  await harness.reset()
  const slashTimes: number[] = []
  const openTimes: number[] = []
  const filterTimes: number[] = []
  const escapeTimes: number[] = []
  const slashBefore = harness.snapshot()
  // 50 open/filter/close rounds: the first `/` used to be the only sample, so
  // the open metric was dominated by first-call JIT, and at ten samples p95 is
  // the maximum, which moves with any single scheduler hiccup.
  for (let round = 0; round < 50; round++) {
    const open = await action(harness, "/")
    openTimes.push(open)
    slashTimes.push(open)
    for (const key of ["m", "o", "d"]) {
      const time = await action(harness, key)
      filterTimes.push(time)
      slashTimes.push(time)
    }
    escapeTimes.push(await action(harness, "ESCAPE"))
  }
  const openMs = percentile(openTimes, 0.95)
  const filterP95Ms = percentile(filterTimes, 0.95)
  const escapeMs = percentile(escapeTimes, 0.95)
  const slashAfter = harness.snapshot()
  all.push(result("P5", size, { openP95Ms: openMs, maxFrame: harness.counters.delta(slashBefore).frameEvents, sequenceP95Ms: percentile(slashTimes, 0.95) }))
  all.push(result("P6", size, { filterP95Ms, escapeP95Ms: escapeMs }))
  all.push(result("P7", size, { registerLayer: harness.counters.delta(slashBefore).registerLayer }))
  void slashAfter

  if (size === "M") {
    await harness.reset()
    const interferenceBefore = harness.snapshot()
    harness.updateStream("streaming main answer", 1)
    harness.prompt.focus()
    const noisyStart = performance.now()
    harness.prompt.set({ input: "/", parts: [] })
    harness.tickBackground(1)
    await harness.app.renderOnce()
    const noisy = performance.now() - noisyStart
    let noisyInput = "/"
    for (const key of ["m", "o", "d"]) {
      harness.prompt.focus()
      const keyStart = performance.now()
      noisyInput += key
      harness.prompt.set({ input: noisyInput, parts: [] })
      harness.tickBackground(2)
      await harness.app.renderOnce()
      noisy + (performance.now() - keyStart)
    }
    const noisyEscape = await action(harness, "ESCAPE")
    const interferenceDelta = harness.counters.delta(interferenceBefore)
    all.push(result("P5'", size, { openP95Ms: noisy, sequenceP95Ms: Math.max(noisy, noisyEscape), maxFrame: interferenceDelta.frameEvents }))
  } else {
    all.push(result("P5'", size, { openP95Ms: 0, sequenceP95Ms: 0, maxFrame: 0 }))
  }

  const scroll = harness.scroll()
  if (scroll) {
    await harness.reset()
    scroll.scrollTo(1_000_000)
    await harness.app.renderOnce()
    const cold: number[] = []
    for (let index = 0; index < 100; index++) {
      const start = performance.now()
      scroll.scrollTo(Math.max(0, 1_000_000 - index * 200))
      await harness.app.renderOnce()
      cold.push(performance.now() - start)
    }
    for (let index = 0; index < 100; index++) {
      const start = performance.now()
      scroll.scrollTo(index * 200)
      await harness.app.renderOnce()
      cold.push(performance.now() - start)
    }
    all.push(result("P8", size, { p99Ms: percentile(cold, 0.99), maxMs: Math.max(...cold) }))

    await harness.reset()
    const streaming: number[] = []
    for (let index = 0; index < 200; index++) {
      harness.updateStream(`stream ${index}`, index)
      const start = performance.now()
      scroll.scrollBy(-5)
      await harness.app.renderOnce()
      streaming.push(performance.now() - start)
    }
    all.push(result("P8'", size, { p99Ms: percentile(streaming, 0.99), maxMs: Math.max(...streaming) }))

    const hot: number[] = []
    for (let index = 0; index < 200; index++) {
      const start = performance.now()
      scroll.scrollTo(index % 2 ? 200 : 0)
      await harness.app.renderOnce()
      hot.push(performance.now() - start)
    }
    all.push(result("P9", size, { p99Ms: percentile(hot, 0.99) }))

    await harness.reset()
    scroll.stickyScroll = false
    scroll.scrollTo(1_000_000)
    await harness.app.renderOnce()
    const anchorStart = scroll.scrollTop
    const anchor: number[] = []
    for (let index = 0; index < 200; index++) {
      scroll.scrollBy(-1)
      await harness.app.renderOnce()
      anchor.push(scroll.scrollTop)
    }
    const anchorEnd = scroll.scrollTop
    const expected = Math.max(0, anchorStart - 200)
    all.push(
      result("P11", size, {
        driftPx: Math.abs(anchorEnd - expected),
        stepMismatches: anchor.filter((top, index) => top - (index === 0 ? anchorStart : anchor[index - 1]) !== -1).length,
      }),
    )

    all.push(
      result("P10", size, {
        mountedRows: harness.counters.mountedRows(scroll),
        scrollChildren: harness.counters.scrollChildren(scroll),
        viewportRows: scroll.viewport.height,
      }),
    )
  } else {
    all.push(result("P8", size, { p99Ms: 0, maxMs: 0 }))
    all.push(result("P8'", size, { p99Ms: 0, maxMs: 0 }))
    all.push(result("P9", size, { p99Ms: 0 }))
    all.push(result("P11", size, { driftPx: 0, stepMismatches: 0 }))
    all.push(result("P10", size, { mountedRows: 0, scrollChildren: 0, viewportRows: 0 }))
  }

  await harness.reset()
  const streamTimes: number[] = []
  const streamBefore = harness.snapshot()
  for (let index = 0; index < 100; index++) {
    harness.updateStream(`main stream ${index}`, index)
    const start = performance.now()
    harness.prompt.set({ input: String(index % 10), parts: [] })
    await harness.app.renderOnce()
    streamTimes.push(performance.now() - start)
  }
  const streamDelta = harness.counters.delta(streamBefore)
  all.push(result("P12", size, { p95Ms: percentile(streamTimes, 0.95) }))
  all.push(result("P13", size, { messageWritesPerFrame: streamDelta.storeMessageWrites / Math.max(1, streamDelta.frameEvents), partWritesPerFrame: streamDelta.storePartWrites / Math.max(1, streamDelta.frameEvents) }))

  await harness.reset()
  const measureInput = async () => {
    const times: number[] = []
    for (let index = 0; index < 50; index++) {
      const start = performance.now()
      harness.prompt.set({ input: "x", parts: [] })
      await harness.app.renderOnce()
      times.push(performance.now() - start)
    }
    return percentile(times, 0.95)
  }
  const noNoise = await measureInput()
  const noiseBefore = harness.snapshot()
  const noisyTimes: number[] = []
  for (let index = 0; index < 50; index++) {
    harness.tickBackground(index)
    const start = performance.now()
    harness.prompt.set({ input: "x", parts: [] })
    await harness.app.renderOnce()
    noisyTimes.push(performance.now() - start)
  }
  const withNoise = percentile(noisyTimes, 0.95)
  const noiseDelta = harness.counters.delta(noiseBefore)
  all.push(result("P14", size, { p95Ms: withNoise, relativeIncrease: noNoise === 0 ? 0 : (withNoise - noNoise) / noNoise, nonCurrentMessageWrites: noiseDelta.storeMessageWrites, nonCurrentPartWrites: noiseDelta.storePartWrites }))

  await harness.reset()
  const idleFramesValue = await tickerFrames(harness, 2_000)
  all.push(result("P15", size, { frames: idleFramesValue }))

  await harness.reset()
  harness.sync.set("session_status", harness.fixture.session.id, { type: "busy" })
  const busyFrames = await tickerFrames(harness, 2_000)
  all.push(result("P16", size, { frames: busyFrames }))

  await harness.reset()
  const scrollForSpinners = harness.scroll()
  if (scrollForSpinners) {
    scrollForSpinners.stickyScroll = false
    scrollForSpinners.scrollTo(0)
    await harness.app.renderOnce()
  }
  const emptyOffscreenFrames = await tickerFrames(harness, 2_000)
  await addOffscreenSpinners(harness, 8)
  const eightOffscreenFrames = await tickerFrames(harness, 2_000)
  all.push(
    result("P17", size, {
      framesEmpty: emptyOffscreenFrames,
      framesEight: eightOffscreenFrames,
      limit: (2 * 1_000) / TICK_MS + 2,
    }),
  )

  harness.openPanel()
  await harness.app.renderOnce()
  await Bun.sleep(10)
  const hiddenPromptFrames = await tickerFrames(harness, 2_000)
  harness.closePanel()
  await harness.app.renderOnce()
  await Bun.sleep(10)
  all.push(result("P17b", size, { frames: hiddenPromptFrames }))

  harness.app.renderer.emit("blur")
  const blurredFrames = await tickerFrames(harness, 2_000)
  harness.app.renderer.emit("focus")
  await harness.app.renderOnce()
  all.push(result("P18", size, { frames: blurredFrames }))

  await harness.reset()
  const scrollForMouse = harness.scroll()
  if (scrollForMouse) {
    scrollForMouse.stickyScroll = false
    scrollForMouse.scrollTo(0)
    await harness.app.renderOnce()
  }
  harness.sync.set("session_status", harness.fixture.session.id, { type: "idle" })
  await harness.app.renderOnce()
  const mouseBefore = harness.snapshot()
  for (let index = 0; index < 200; index++) await harness.app.mockMouse.moveTo(index % 100, 0)
  harness.clock.advance(200)
  await harness.app.renderOnce()
  all.push(result("P19", size, { frames: harness.counters.delta(mouseBefore).renderRequests, moves: 200 }))

  const childID = harness.fixture.sessions[1]?.id
  if (size === "M" && childID) {
    // Session switching is judged by mounted view nodes: JSC retains swept
    // heap blocks and dead cells well after `Bun.gc(true)` (a 50-round window
    // can report ~5 MB of heap growth with a byte-identical reachable graph),
    // so heap usage alone cannot distinguish a leak from allocator retention.
    // The heap numbers stay in the report as a coarse backstop.
    const nodes: number[] = []
    const heaps: number[] = []
    for (let windowIndex = 0; windowIndex < 3; windowIndex++) {
      for (let index = 0; index < 50; index++) {
        harness.updateStream(`memory stream ${windowIndex}-${index}`, 100 + index)
        harness.navigate({ type: "session", sessionID: childID })
        await harness.app.renderOnce()
        harness.navigate({ type: "session", sessionID: harness.fixture.session.id })
        await harness.app.renderOnce()
        await Bun.sleep(0)
      }
      Bun.gc(true)
      nodes.push(harness.counters.mountedNodes(harness.app.renderer.root))
      heaps.push(process.memoryUsage().heapUsed)
    }
    const second = nodes[1] ?? 0
    const third = nodes[2] ?? 0
    const heapSecond = heaps[1] ?? 0
    const heapThird = heaps[2] ?? 0
    all.push(
      result("P20", size, {
        nodes2: second,
        nodes3: third,
        growth: second === 0 ? 0 : (third - second) / second,
        heap2: heapSecond,
        heap3: heapThird,
        heapGrowth: heapSecond === 0 ? 0 : (heapThird - heapSecond) / heapSecond,
      }),
    )
  } else {
    all.push(
      result("P20", size, { nodes2: 0, nodes3: 0, growth: 0, heap2: 0, heap3: 0, heapGrowth: 0 }),
    )
  }

  return all
}
