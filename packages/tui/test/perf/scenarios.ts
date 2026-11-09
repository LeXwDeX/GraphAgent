// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import { type FixtureSize } from "./fixtures"
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
  "P12",
  "P13",
  "P14",
  "P15",
  "P16",
  "P19",
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
  const p1 = await typeText(harness, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX")
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
      selectorEvaluationsPerKey: harness.counters.delta(p1Before).selectorEvaluations / 50,
    }),
  )
  void p1After

  await harness.reset()
  const slashTimes: number[] = []
  const slashBefore = harness.snapshot()
  slashTimes.push(await action(harness, "/"))
  const openMs = slashTimes[0]
  for (const key of ["m", "o", "d"]) slashTimes.push(await action(harness, key))
  const filterP95Ms = percentile(slashTimes.slice(1), 0.95)
  const escapeMs = await action(harness, "ESCAPE")
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
    for (let index = 0; index < 50; index++) {
      const start = performance.now()
      scroll.scrollTo(Math.max(0, 1_000_000 - index * 200))
      await harness.app.renderOnce()
      cold.push(performance.now() - start)
    }
    for (let index = 0; index < 50; index++) {
      const start = performance.now()
      scroll.scrollTo(index * 200)
      await harness.app.renderOnce()
      cold.push(performance.now() - start)
    }
    all.push(result("P8", size, { p99Ms: percentile(cold, 0.99), maxMs: Math.max(...cold) }))

    await harness.reset()
    const streaming: number[] = []
    for (let index = 0; index < 50; index++) {
      harness.updateStream(`stream ${index}`, index)
      const start = performance.now()
      scroll.scrollBy(-5)
      await harness.app.renderOnce()
      streaming.push(performance.now() - start)
    }
    all.push(result("P8'", size, { p99Ms: percentile(streaming, 0.99), maxMs: Math.max(...streaming) }))

    const hot: number[] = []
    for (let index = 0; index < 50; index++) {
      const start = performance.now()
      scroll.scrollTo(index % 2 ? 200 : 0)
      await harness.app.renderOnce()
      hot.push(performance.now() - start)
    }
    all.push(result("P9", size, { p99Ms: percentile(hot, 0.99) }))
  } else {
    all.push(result("P8", size, { p99Ms: 0, maxMs: 0 }))
    all.push(result("P8'", size, { p99Ms: 0, maxMs: 0 }))
    all.push(result("P9", size, { p99Ms: 0 }))
  }
  all.push(result("P10", size, { mountedNodes: harness.counters.mountedNodes(harness.app.renderer.root) }))

  await harness.reset()
  const streamTimes: number[] = []
  const streamBefore = harness.snapshot()
  for (let index = 0; index < 20; index++) {
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
  const noNoiseBefore = harness.snapshot()
  const noNoiseStart = performance.now()
  harness.prompt.set({ input: "x", parts: [] })
  await harness.app.renderOnce()
  const noNoise = performance.now() - noNoiseStart
  const noiseBefore = harness.snapshot()
  for (let index = 0; index < 8; index++) harness.tickBackground(index)
  const withNoiseStart = performance.now()
  harness.prompt.set({ input: "x", parts: [] })
  await harness.app.renderOnce()
  const withNoise = performance.now() - withNoiseStart
  const noiseDelta = harness.counters.delta(noiseBefore)
  const noNoiseDelta = harness.counters.delta(noNoiseBefore)
  all.push(result("P14", size, { p95Ms: withNoise, relativeIncrease: noNoise === 0 ? 0 : (withNoise - noNoise) / noNoise, nonCurrentMessageWrites: noiseDelta.storeMessageWrites - noNoiseDelta.storeMessageWrites, nonCurrentPartWrites: noiseDelta.storePartWrites }))

  await harness.reset()
  const idleBefore = harness.snapshot()
  harness.clock.advance(2_000)
  await harness.app.renderOnce()
  all.push(result("P15", size, { frames: harness.counters.delta(idleBefore).frameEvents }))

  await harness.reset()
  harness.sync.set("session_status", harness.fixture.session.id, { type: "busy" })
  const busyBefore = harness.snapshot()
  harness.clock.advance(2_000)
  await harness.app.renderOnce()
  all.push(result("P16", size, { frames: harness.counters.delta(busyBefore).frameEvents }))

  await harness.reset()
  const mouseBefore = harness.snapshot()
  for (let index = 0; index < 200; index++) {
    await harness.app.mockMouse.moveTo(index % 100, index % 30)
    await harness.app.renderOnce()
  }
  all.push(result("P19", size, { frames: harness.counters.delta(mouseBefore).frameEvents }))

  return all
}
