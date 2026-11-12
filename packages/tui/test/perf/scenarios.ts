// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import { CodeRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Part } from "@graphagent/sdk"
import { TICK_MS } from "../../src/context/ticker"
import { type FixtureSize, type MeasuredSize, updatePartEvent } from "./fixtures"
import type { PerfHarness, PerfStream } from "./harness"
import { within } from "./settle"

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
  size: MeasuredSize
  [metric: string]: number | string
}

/**
 * The stdin parser holds a lone ESC until a 20 ms timer decides it is not the
 * start of an escape sequence. A ManualClock never fires that timer on its own:
 * the menu stays open and the next key arrives merged with the ESC as Alt+<key>,
 * which the keymap rejects as an empty key name.
 */
const ESC_FLUSH_MS = 100
/** Open/filter/close rounds per slash scenario; at 50 samples p95 is the 48th value, not the maximum. */
const SLASH_ROUNDS = 50
/** A wheel tick scrolls a few rows; a page key scrolls a whole viewport. Both are sampled. */
const WHEEL_ROWS = 3
const WHEEL_STEPS = 100
const STREAM_SCROLL_STEPS = 100
const STREAM_SCROLL_ROWS = 5
/**
 * Server command declared by the fixture. It only ever appears as a menu row:
 * the input line holds "/mod", never "/mode".
 */
const MENU_MARKER = "/mode"

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0
  const ordered = values.toSorted((a, b) => a - b)
  return Number(ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)].toFixed(2))
}

async function action(harness: PerfHarness, key: string) {
  const start = performance.now()
  harness.app.mockInput.pressKey(key)
  if (key === "ESCAPE") harness.clock.advance(ESC_FLUSH_MS)
  await harness.app.renderOnce()
  return performance.now() - start
}

async function typeText(harness: PerfHarness, text: string) {
  const times: number[] = []
  for (const key of text) times.push(await action(harness, key))
  return times
}

function result(id: ScenarioID, size: MeasuredSize, values: Record<string, number>): ScenarioResult {
  return {
    id,
    size,
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value.toFixed(2))])),
  }
}

/** A scenario that no longer does what its name says would pass every gate; fail loudly instead. */
function invalid(scenario: string, message: string, frame?: string): never {
  throw new Error(`${scenario}: ${message}${frame ? `\n${frame}` : ""}`)
}

function assertPromptText(harness: PerfHarness, expected: string, scenario: string) {
  const actual = harness.prompt.current.input
  if (actual !== expected)
    invalid(scenario, `typed input did not reach the prompt (got ${JSON.stringify(actual.slice(0, 60))})`)
}

function assertMenu(harness: PerfHarness, open: boolean, scenario: string) {
  const frame = harness.app.captureCharFrame()
  if (frame.includes(MENU_MARKER) === open) return
  invalid(
    scenario,
    `the slash menu is ${open ? "closed" : "still open"}, expected it ${open ? "open" : "closed"}`,
    frame,
  )
}

/**
 * A delta for a part the store does not hold is dropped without a trace, and a
 * dropped delta writes nothing, which is also what the zero-write gate of P13
 * wants to see. The part must carry every delta the scenario sent.
 */
function assertStreamed(harness: PerfHarness, stream: PerfStream, scenario: string) {
  const part = (harness.sync.data.part[stream.part.messageID] ?? []).find((item) => item.id === stream.part.id)
  if (!part) invalid(scenario, `the streaming part ${stream.part.id} never reached the store`)
  const actual = harness.sync.readPartText(part)
  if (actual !== stream.text()) {
    invalid(scenario, `the stream holds ${actual.length} of the ${stream.text().length} characters sent`)
  }
}

function codeBlocks(node: Renderable): CodeRenderable[] {
  return [...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeBlocks)]
}

/**
 * Fenced code highlights asynchronously on a parser worker. A highlight that
 * lands inside a measured window adds a frame the scenario did not cause, so
 * wait for every mounted block before measuring.
 */
export async function settleHighlights(harness: PerfHarness) {
  await within(
    Promise.all(codeBlocks(harness.app.renderer.root).map((node) => node.highlightingDone)),
    "code block highlighting",
  )
  await harness.app.renderOnce()
}

/** Resets the composer and scroll position, then waits for the rows it remounted. */
async function fresh(harness: PerfHarness) {
  await harness.reset()
  await settleHighlights(harness)
}

/** Scrolls to the live end of the transcript, where a reply is being written. */
async function followTail(harness: PerfHarness) {
  const scroll = harness.scroll()
  if (!scroll) return
  scroll.stickyScroll = true
  scroll.scrollTo(Infinity)
  await harness.app.renderOnce()
  await settleHighlights(harness)
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
  // The first frame applies the queued events, the second lays out the rows they added.
  await harness.app.renderOnce()
  await harness.app.renderOnce()
}

type SlashRound = {
  open: number
  filter: number[]
  escape: number
  registerLayer: number
}

/**
 * One `/` round: open the menu, filter with "mod", close with ESC. The menu
 * state is checked against the frame after the filter and after ESC, so a round
 * whose keys were swallowed or merged cannot contribute timings.
 */
async function slashRound(
  harness: PerfHarness,
  round: number,
  press: (key: string) => Promise<number> = (key) => action(harness, key),
): Promise<SlashRound> {
  const before = harness.snapshot()
  const open = await press("/")
  const filter: number[] = []
  for (const key of ["m", "o", "d"]) filter.push(await press(key))
  assertMenu(harness, true, `slash round ${round} after "/mod"`)
  const escape = await press("ESCAPE")
  assertMenu(harness, false, `slash round ${round} after ESC`)
  return { open, filter, escape, registerLayer: harness.counters.delta(before).registerLayer }
}

function slashMetrics(rounds: SlashRound[]) {
  const open = rounds.map((round) => round.open)
  const filter = rounds.flatMap((round) => round.filter)
  const escape = rounds.map((round) => round.escape)
  return {
    openP95Ms: percentile(open, 0.95),
    sequenceP95Ms: percentile(
      rounds.flatMap((round) => [round.open, ...round.filter]),
      0.95,
    ),
    filterP95Ms: percentile(filter, 0.95),
    escapeP95Ms: percentile(escape, 0.95),
    // Every key-to-frame time of the sequence, ESC included: one frame over the
    // ceiling is a visible hitch no matter how good the percentiles are.
    maxMs: Math.max(...open, ...filter, ...escape),
    // A layer may be registered when the menu opens; never once per key.
    registerLayer: Math.max(0, ...rounds.map((round) => round.registerLayer)),
  }
}

async function scrollStep(harness: PerfHarness, move: () => void) {
  const start = performance.now()
  move()
  await harness.app.renderOnce()
  return performance.now() - start
}

const maxScrollTop = (scroll: ScrollBoxRenderable) => Math.max(0, scroll.scrollHeight - scroll.viewport.height)

/**
 * Cold scroll: bottom to top one page per step, so every region is entered for
 * the first time, then back down, then wheel-sized steps up from the bottom.
 * The positions are derived from the live content height; fixed offsets clamp to
 * the bottom on a short transcript and the walk never leaves it.
 */
async function coldScroll(harness: PerfHarness, scroll: ScrollBoxRenderable) {
  scroll.stickyScroll = false
  scroll.scrollTo(maxScrollTop(scroll))
  await harness.app.renderOnce()
  const page = Math.max(1, scroll.viewport.height - 1)
  const bottom = scroll.scrollTop
  if (bottom < 2 * page) {
    invalid("P8", `the transcript (${scroll.scrollHeight} rows) is too short to scroll through unmounted rows`)
  }

  const times: number[] = []
  for (let top = bottom - page; ; top -= page) {
    times.push(await scrollStep(harness, () => scroll.scrollTo(Math.max(0, top))))
    if (top <= 0) break
  }
  if (scroll.scrollTop > 1) invalid("P8", `the upward walk stopped at row ${scroll.scrollTop}, not at the top`)

  for (let top = page; top < maxScrollTop(scroll); top += page) {
    times.push(await scrollStep(harness, () => scroll.scrollTo(top)))
  }
  times.push(await scrollStep(harness, () => scroll.scrollTo(maxScrollTop(scroll))))
  if (maxScrollTop(scroll) - scroll.scrollTop > 1) invalid("P8", "the downward walk did not return to the bottom")

  const wheelSteps = Math.min(WHEEL_STEPS, Math.floor(maxScrollTop(scroll) / WHEEL_ROWS))
  const wheelStart = scroll.scrollTop
  for (let step = 0; step < wheelSteps; step++) {
    times.push(await scrollStep(harness, () => scroll.scrollBy(-WHEEL_ROWS)))
  }
  if (wheelStart - scroll.scrollTop < wheelSteps * WHEEL_ROWS - 1) {
    invalid("P8", "the wheel-sized steps did not move the viewport")
  }
  return times
}

/**
 * Streaming scroll: a reply keeps growing at the pinned tail while the viewport
 * scrolls up away from it. Each step delivers one `message.part.delta`, the way
 * the server writes a reply; the stream part is the last row of the transcript.
 */
async function streamingScroll(harness: PerfHarness, scroll: ScrollBoxRenderable) {
  const stream = harness.openStream()
  scroll.stickyScroll = true
  scroll.scrollTo(maxScrollTop(scroll))
  await harness.app.renderOnce()
  const start = scroll.scrollTop
  const times: number[] = []
  for (let index = 0; index < STREAM_SCROLL_STEPS; index++) {
    stream.delta(`t${index} `)
    times.push(await scrollStep(harness, () => scroll.scrollBy(-STREAM_SCROLL_ROWS)))
  }
  assertStreamed(harness, stream, "P8'")
  stream.finish()
  await harness.app.renderOnce()
  const reachable = Math.min(start, STREAM_SCROLL_STEPS * STREAM_SCROLL_ROWS)
  if (start - scroll.scrollTop < reachable / 2) invalid("P8'", "the viewport stayed pinned to the streaming tail")
  return times
}

/**
 * P2: how much slower a keystroke is in this session than in the small one.
 * Derived across sizes, so the runner adds it after every size has run.
 */
export function scaleResult(size: FixtureSize, p95Ms: number, smallP95Ms: number): ScenarioResult {
  return result("P2", size, { p95Scale: smallP95Ms === 0 ? 0 : p95Ms / smallP95Ms })
}

/**
 * One ordinary character, or `rounds` of 50 for a profile: a sampler at 1 ms sees
 * nothing of a keystroke that costs a tenth of that, so a CPU profile repeats the
 * operation until the steady state outweighs the process start. The composer is
 * cleared between rounds: the cost of a keystroke grows with the text already in
 * it (a grapheme pass over the whole input), and 15 000 characters in one input
 * would profile that instead of typing. The first round warms the JIT and stays
 * out of the numbers.
 */
export async function runCharacterProfile(harness: PerfHarness, rounds = 1): Promise<ScenarioResult> {
  await fresh(harness)
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"
  if (rounds <= 1) {
    const values = await typeText(harness, "a")
    return result("P1", harness.fixture.size, { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) })
  }
  const round = async () => {
    const times = await typeText(harness, alphabet)
    harness.prompt.reset()
    await harness.app.renderOnce()
    return times
  }
  await round()
  const values: number[] = []
  for (let index = 0; index < rounds; index++) values.push(...(await round()))
  return result("P1", harness.fixture.size, {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  })
}

/** One `/mod` + ESC round, or `rounds` of them after one warm-up round. */
export async function runSlashProfile(harness: PerfHarness, rounds = 1): Promise<ScenarioResult> {
  await fresh(harness)
  if (rounds <= 1) {
    const round = await slashRound(harness, 0)
    return result("P5", harness.fixture.size, {
      openP95Ms: round.open,
      sequenceP95Ms: Math.max(round.open, ...round.filter),
      maxMs: Math.max(round.open, ...round.filter, round.escape),
    })
  }
  await slashRound(harness, 0)
  const measured: SlashRound[] = []
  for (let round = 1; round <= rounds; round++) measured.push(await slashRound(harness, round))
  const slash = slashMetrics(measured)
  return result("P5", harness.fixture.size, {
    openP95Ms: slash.openP95Ms,
    sequenceP95Ms: slash.sequenceP95Ms,
    maxMs: slash.maxMs,
  })
}

export async function runScenarios(harness: PerfHarness): Promise<ScenarioResult[]> {
  const size = harness.fixture.size
  const all: ScenarioResult[] = []

  await fresh(harness)
  const p1Before = harness.snapshot()
  // 200 keystrokes: at 50 samples p95 is the 48th value and moves with a
  // single scheduler hiccup, which made the 1.30x gate flaky.
  const typed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX".repeat(4)
  const p1 = await typeText(harness, typed)
  assertPromptText(harness, typed, "P1")
  const p1Delta = harness.counters.delta(p1Before)
  all.push(result("P1", size, { p50Ms: percentile(p1, 0.5), p95Ms: percentile(p1, 0.95), p99Ms: percentile(p1, 0.99) }))
  all.push(result("P3", size, { registerLayer: p1Delta.registerLayer }))
  all.push(
    result("P4", size, {
      selectorEvaluations: p1Delta.selectorEvaluations,
      selectorEvaluationsPerKey: p1Delta.selectorEvaluations / typed.length,
    }),
  )

  await fresh(harness)
  const slashRounds: SlashRound[] = []
  const slashBefore = harness.snapshot()
  for (let round = 0; round < SLASH_ROUNDS; round++) slashRounds.push(await slashRound(harness, round))
  const slash = slashMetrics(slashRounds)
  all.push(
    result("P5", size, {
      openP95Ms: slash.openP95Ms,
      sequenceP95Ms: slash.sequenceP95Ms,
      maxMs: slash.maxMs,
      frames: harness.counters.delta(slashBefore).frameEvents,
    }),
  )
  all.push(result("P6", size, { filterP95Ms: slash.filterP95Ms, escapeP95Ms: slash.escapeP95Ms }))
  all.push(result("P7", size, { registerLayer: slash.registerLayer }))

  if (size === "M") {
    await fresh(harness)
    await followTail(harness)
    // Interference: every key arrives together with one token of a reply being
    // written at the tail and a burst from the eight background sessions. Both are
    // queued through the SDK event path and applied by the frame the key renders.
    const noisyStream = harness.openStream()
    // The snapshot that opens the reply lands before the first key, so no round
    // pays for the one-time store write.
    await harness.app.renderOnce()
    let tick = 0
    const noisyPress = async (key: string) => {
      tick++
      noisyStream.delta(`w${tick} `)
      harness.tickBackground(tick)
      return action(harness, key)
    }
    const noisyRounds: SlashRound[] = []
    const noisyBefore = harness.snapshot()
    for (let round = 0; round < SLASH_ROUNDS; round++) noisyRounds.push(await slashRound(harness, round, noisyPress))
    const noisy = slashMetrics(noisyRounds)
    assertStreamed(harness, noisyStream, "P5'")
    noisyStream.finish()
    await harness.app.renderOnce()
    all.push(
      result("P5'", size, {
        openP95Ms: noisy.openP95Ms,
        sequenceP95Ms: noisy.sequenceP95Ms,
        maxMs: noisy.maxMs,
        frames: harness.counters.delta(noisyBefore).frameEvents,
      }),
    )
  } else {
    all.push(result("P5'", size, { openP95Ms: 0, sequenceP95Ms: 0, maxMs: 0, frames: 0 }))
  }

  const scroll = harness.scroll()
  if (scroll) {
    await fresh(harness)
    const cold = await coldScroll(harness, scroll)
    all.push(result("P8", size, { p99Ms: percentile(cold, 0.99), maxMs: Math.max(...cold), steps: cold.length }))

    await fresh(harness)
    const streaming = await streamingScroll(harness, scroll)
    all.push(
      result("P8'", size, {
        p99Ms: percentile(streaming, 0.99),
        maxMs: Math.max(...streaming),
        steps: streaming.length,
      }),
    )

    const hot: number[] = []
    for (let index = 0; index < 200; index++) {
      const start = performance.now()
      scroll.scrollTo(index % 2 ? 200 : 0)
      await harness.app.renderOnce()
      hot.push(performance.now() - start)
    }
    all.push(result("P9", size, { p99Ms: percentile(hot, 0.99) }))

    await fresh(harness)
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
        stepMismatches: anchor.filter((top, index) => top - (index === 0 ? anchorStart : anchor[index - 1]) !== -1)
          .length,
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
    all.push(result("P8", size, { p99Ms: 0, maxMs: 0, steps: 0 }))
    all.push(result("P8'", size, { p99Ms: 0, maxMs: 0, steps: 0 }))
    all.push(result("P9", size, { p99Ms: 0 }))
    all.push(result("P11", size, { driftPx: 0, stepMismatches: 0 }))
    all.push(result("P10", size, { mountedRows: 0, scrollChildren: 0, viewportRows: 0 }))
  }

  await fresh(harness)
  await followTail(harness)
  // A reply being written at the tail while the user types. The snapshot that
  // opens it is applied outside the measured window; the window is the deltas
  // and the one terminal snapshot that closes the reply.
  const typingStream = harness.openStream()
  await harness.app.renderOnce()
  const streamTimes: number[] = []
  const streamBefore = harness.snapshot()
  for (let index = 0; index < 100; index++) {
    typingStream.delta(`w${index} `)
    const start = performance.now()
    harness.prompt.set({ input: String(index % 10), parts: [] })
    await harness.app.renderOnce()
    streamTimes.push(performance.now() - start)
  }
  assertStreamed(harness, typingStream, "P13")
  const deltaPhase = harness.counters.delta(streamBefore)
  typingStream.finish()
  await harness.app.renderOnce()
  const streamDelta = harness.counters.delta(streamBefore)
  all.push(result("P12", size, { p95Ms: percentile(streamTimes, 0.95) }))
  all.push(
    result("P13", size, {
      // The delta phase alone: a token goes to the stream buffer, never to the store.
      deltaMessageWrites: deltaPhase.storeMessageWrites,
      deltaPartWrites: deltaPhase.storePartWrites,
      // The whole window, terminal snapshot included.
      messageWritesPerFrame: streamDelta.storeMessageWrites / Math.max(1, streamDelta.frameEvents),
      partWritesPerFrame: streamDelta.storePartWrites / Math.max(1, streamDelta.frameEvents),
    }),
  )

  await fresh(harness)
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
  all.push(
    result("P14", size, {
      p95Ms: withNoise,
      quietP95Ms: noNoise,
      // Sub-millisecond samples make the ratio a measure of the scheduler, so
      // the gate also reads the absolute increase.
      increaseMs: withNoise - noNoise,
      relativeIncrease: noNoise === 0 ? 0 : (withNoise - noNoise) / noNoise,
      nonCurrentMessageWrites: noiseDelta.storeMessageWrites,
      nonCurrentPartWrites: noiseDelta.storePartWrites,
    }),
  )

  await fresh(harness)
  const idleFramesValue = await tickerFrames(harness, 2_000)
  all.push(result("P15", size, { frames: idleFramesValue }))

  await fresh(harness)
  harness.sync.set("session_status", harness.fixture.session.id, { type: "busy" })
  const busyFrames = await tickerFrames(harness, 2_000)
  all.push(result("P16", size, { frames: busyFrames }))

  await fresh(harness)
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
  await harness.app.renderOnce()
  const hiddenPromptFrames = await tickerFrames(harness, 2_000)
  harness.closePanel()
  await harness.app.renderOnce()
  await harness.app.renderOnce()
  all.push(result("P17b", size, { frames: hiddenPromptFrames }))

  harness.app.renderer.emit("blur")
  const blurredFrames = await tickerFrames(harness, 2_000)
  harness.app.renderer.emit("focus")
  await harness.app.renderOnce()
  all.push(result("P18", size, { frames: blurredFrames }))

  await fresh(harness)
  const scrollForMouse = harness.scroll()
  if (scrollForMouse) {
    scrollForMouse.stickyScroll = false
    scrollForMouse.scrollTo(0)
    await harness.app.renderOnce()
  }
  harness.sync.set("session_status", harness.fixture.session.id, { type: "idle" })
  await harness.app.renderOnce()
  await settleHighlights(harness)
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
    const switchStream = harness.openStream()
    for (let windowIndex = 0; windowIndex < 3; windowIndex++) {
      for (let index = 0; index < 50; index++) {
        switchStream.delta(`m${windowIndex}-${index} `)
        harness.navigate({ type: "session", sessionID: childID })
        await harness.app.renderOnce()
        harness.navigate({ type: "session", sessionID: harness.fixture.session.id })
        await harness.app.renderOnce()
      }
      Bun.gc(true)
      nodes.push(harness.counters.mountedNodes(harness.app.renderer.root))
      heaps.push(process.memoryUsage().heapUsed)
    }
    assertStreamed(harness, switchStream, "P20")
    switchStream.finish()
    await harness.app.renderOnce()
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
    all.push(result("P20", size, { nodes2: 0, nodes3: 0, growth: 0, heap2: 0, heap3: 0, heapGrowth: 0 }))
  }

  return all
}
