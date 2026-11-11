// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"
import { TICK_MS } from "../../src/context/ticker"
import { PART_OVERSCAN, TAIL_ALWAYS } from "../../src/routes/session/rows"

export type ScenarioMetrics = Record<string, number | string>
export type PerfReport = {
  calibration?: { fixedLoopMs?: number; fixedLayoutMsMedian?: number }
  scenarios: Record<string, Record<string, ScenarioMetrics>>
}
export type CompareRow = {
  size: string
  id: string
  metric: string
  baseline: number
  current: number
  ratio: number
}
export type Failure = {
  size: string
  id: string
  metric: string
  limit: string
  value: number
}

/** Relative timing tolerance. Tightening is safe; raising it needs review. */
export const TIMING_RATIO = 1.3
/**
 * p99 is the second-worst of 200 keystrokes, so one scheduler hiccup moves it.
 * It gets a wider ratio than the stable percentiles; the absolute frame ceiling
 * still caps pathological frames.
 */
export const P99_TIMING_RATIO = 1.5
/**
 * Timing floor for the ratio check. A sub-millisecond sample moves by tens of
 * microseconds under background load, so a 1.30x comparison there measures the
 * scheduler rather than the frame.
 */
export const MIN_COMPARE_MS = 1
/** Absolute ceiling for any interactive frame (Issue #1025 7.4). */
export const FRAME_CEILING_MS = 100
const SIZE_ORDER = ["S", "M", "L"]

/**
 * Normalize timings by the render-path calibration, not the fixed JavaScript
 * loop: the loop barely moves between a developer machine and a shared CI
 * runner, while mount + first layout moved 1.51x in the same comparison. The
 * loop stays as a fallback for reports captured before layout calibration.
 */
function machineFactor(baseline: PerfReport, current: PerfReport): number {
  const layoutBefore = baseline.calibration?.fixedLayoutMsMedian ?? 0
  const layoutNow = current.calibration?.fixedLayoutMsMedian ?? 0
  if (layoutBefore > 0 && layoutNow > 0) return layoutNow / layoutBefore
  const before = baseline.calibration?.fixedLoopMs ?? 0
  const now = current.calibration?.fixedLoopMs ?? 0
  if (before <= 0 || now <= 0) return 1
  return now / before
}

function scenario(report: PerfReport, size: string, id: string): ScenarioMetrics | undefined {
  return report.scenarios[size]?.[id]
}

function metric(report: PerfReport, size: string, id: string, name: string): number | undefined {
  const value = scenario(report, size, id)?.[name]
  return typeof value === "number" ? value : undefined
}

export function compareReports(baseline: PerfReport, current: PerfReport): { rows: CompareRow[]; failures: Failure[] } {
  const rows: CompareRow[] = []
  const failures: Failure[] = []
  const factor = machineFactor(baseline, current)
  const sizes = Object.keys(current.scenarios).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b))

  const fail = (size: string, id: string, name: string, limit: string, value: number) => {
    failures.push({ size, id, metric: name, limit, value })
  }

  for (const size of sizes) {
    for (const [id, metrics] of Object.entries(current.scenarios[size] ?? {})) {
      const before = scenario(baseline, size, id)
      if (!before) continue
      for (const [name, value] of Object.entries(metrics)) {
        const old = before[name]
        if (typeof value !== "number" || typeof old !== "number") continue
        rows.push({
          size,
          id,
          metric: name,
          baseline: old,
          current: value,
          ratio: old === 0 ? 0 : Number((value / old).toFixed(3)),
        })
        // `maxMs` is one worst frame; a single scheduler hiccup moves it far
        // past the ratio. It is gated by the absolute ceiling below instead.
        if (!name.endsWith("Ms") || name === "maxMs") continue
        const adjusted = value / factor
        if (adjusted < MIN_COMPARE_MS) continue
        const tolerance = name.endsWith("p99Ms") ? P99_TIMING_RATIO : TIMING_RATIO
        if (adjusted > old * tolerance) {
          fail(
            size,
            id,
            name,
            `≤ ${(old * tolerance).toFixed(2)} (${tolerance.toFixed(2)}× baseline, machine factor ${factor.toFixed(3)})`,
            adjusted,
          )
        }
      }
    }

    const check = (id: string, name: string, limit: string, allowed: (value: number) => boolean) => {
      const value = metric(current, size, id, name)
      if (value === undefined) return
      if (!allowed(value)) fail(size, id, name, limit, value)
    }

    // P3/P4: a keystroke must not register keymap layers.
    check("P3", "registerLayer", "0", (value) => value === 0)
    check("P7", "registerLayer", "≤ 2", (value) => value <= 2)

    // P10: only viewport + overscan + tail rows stay mounted.
    const viewport = metric(current, size, "P10", "viewportRows") ?? 0
    const rowLimit = viewport + 2 * PART_OVERSCAN + TAIL_ALWAYS
    check("P10", "mountedRows", `≤ ${rowLimit}`, (value) => value <= rowLimit)
    check("P10", "scrollChildren", `≤ ${rowLimit + 2}`, (value) => value <= rowLimit + 2)

    // P11: the viewport anchor may not drift by more than one line (2px rows).
    check("P11", "driftPx", "≤ 2", (value) => value <= 2)

    // P13: at most one store write per rendered frame.
    check("P13", "messageWritesPerFrame", "≤ 1", (value) => value <= 1)
    check("P13", "partWritesPerFrame", "≤ 1", (value) => value <= 1)

    // P14: background sessions must not write the active session's store.
    check("P14", "nonCurrentMessageWrites", "0", (value) => value === 0)
    check("P14", "nonCurrentPartWrites", "0", (value) => value === 0)
    check("P14", "relativeIncrease", "≤ 0.10", (value) => value <= 0.1)

    // P15-P19: timer and mouse frames.
    const tickLimit = Math.ceil((2 * 1_000) / TICK_MS) + 2
    check("P15", "frames", "0", (value) => value === 0)
    check("P16", "frames", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    const empty = metric(current, size, "P17", "framesEmpty")
    const eight = metric(current, size, "P17", "framesEight")
    if (empty !== undefined) check("P17", "framesEmpty", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    if (eight !== undefined) check("P17", "framesEight", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    if (empty !== undefined && eight !== undefined && empty !== eight) {
      fail(size, "P17", "framesEight", `= ${empty} (same as framesEmpty)`, eight)
    }
    check("P17b", "frames", "0", (value) => value === 0)
    check("P18", "frames", "0", (value) => value === 0)
    check("P19", "frames", "0", (value) => value === 0)

    // P20: switching sessions must not accumulate mounted view nodes. Heap
    // growth stays a coarse backstop because JSC keeps swept blocks and dead
    // cells, so allocator retention is visible there even with a stable
    // reachable object graph.
    check("P20", "growth", "≤ 0.05", (value) => value <= 0.05)
    check("P20", "heapGrowth", "≤ 0.25", (value) => value <= 0.25)
  }

  // P5/P8: no single interactive frame may exceed the absolute ceiling.
  for (const size of sizes) {
    const p5 = metric(current, size, "P5", "maxMs")
    if (p5 !== undefined && p5 > FRAME_CEILING_MS) fail(size, "P5", "maxMs", `≤ ${FRAME_CEILING_MS}`, p5)
    const p8 = metric(current, size, "P8", "maxMs")
    if (p8 !== undefined && p8 > FRAME_CEILING_MS) fail(size, "P8", "maxMs", `≤ ${FRAME_CEILING_MS}`, p8)
    const p8Streaming = metric(current, size, "P8'", "maxMs")
    if (p8Streaming !== undefined && p8Streaming > FRAME_CEILING_MS)
      fail(size, "P8'", "maxMs", `≤ ${FRAME_CEILING_MS}`, p8Streaming)
  }

  return { rows, failures }
}

async function main() {
  const [baselinePath, currentPath, ...flags] = process.argv.slice(2)
  if (!baselinePath || !currentPath) {
    console.error("usage: bun test/perf/compare.ts <baseline.json> <current.json> [--enforce]")
    process.exit(2)
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
  const baseline = (await Bun.file(path.resolve(baselinePath)).json()) as PerfReport
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
  const current = (await Bun.file(path.resolve(currentPath)).json()) as PerfReport
  const { rows, failures } = compareReports(baseline, current)
  console.log(
    JSON.stringify(
      { baseline: path.resolve(baselinePath), current: path.resolve(currentPath), rows, failures },
      null,
      2,
    ),
  )
  if (flags.includes("--enforce") && failures.length > 0) process.exit(1)
}

if (import.meta.main) await main()
