// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"
import { TICK_MS } from "../../src/context/ticker"
import { PART_OVERSCAN, TAIL_ALWAYS } from "../../src/routes/session/rows"

export type ScenarioMetrics = Record<string, number | string>
export type PerfReport = {
  /** Commit the report was captured at; scopes `PENDING_REBASELINE`. */
  commit?: string
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
/** A metric the gate needs, from a scenario the report contains, that the report does not carry. */
export type MissingMetric = {
  size: string
  id: string
  metric: string
}
export type CompareResult = {
  rows: CompareRow[]
  failures: Failure[]
  /**
   * A gate rule that reads a metric the scenario never emitted passes silently,
   * which is how a renamed metric turned a ceiling into dead code. Anything
   * listed here fails the gate.
   */
  missing: MissingMetric[]
  /** Scenarios whose baseline-relative timing check was skipped (see `PENDING_REBASELINE`). */
  pending: string[]
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
 * Below this a baseline is a sub-millisecond sample: it moves by tens of
 * microseconds under background load, so a ratio against it measures the
 * scheduler rather than the frame. Such a baseline is compared by absolute
 * increase (`SUB_MS_ALLOWANCE_MS`) instead of being skipped.
 */
export const MIN_COMPARE_MS = 1
/**
 * Absolute headroom, in normalized milliseconds, for a sub-millisecond baseline.
 * A regression from 0.5 ms to 40 ms used to pass: the ratio was the only rule
 * that could have caught it, and the floor switched the ratio off.
 */
export const SUB_MS_ALLOWANCE_MS = 2
/**
 * Absolute allowance for p99 regressions, in normalized milliseconds. p99 is
 * the second-worst of 200 samples, while the machine factor comes from a median
 * layout duration; a scheduler tail does not scale with that median. Hosted CI
 * moves the same scenario's p99 by several milliseconds between runs, so a p99
 * must exceed both the ratio and this allowance before it fails.
 */
export const P99_NOISE_ALLOWANCE_MS = 5
/**
 * Below this baseline a p95 is a short, fast sample (a slash menu opening in
 * 1.8 ms), and one process in a few lands well above its median: S `P5` open
 * p95 went from a 1.83 ms baseline to 3.62 ms with nothing changed, on a
 * machine running other work. The ratio alone reads that as a 2x regression.
 */
export const P95_ALLOWANCE_BELOW_MS = 3
/**
 * Absolute allowance, in normalized milliseconds, for a p95 under
 * `P95_ALLOWANCE_BELOW_MS`: it fails only when it exceeds both the ratio and
 * baseline + this. 3.62 ms against 1.83 passes; a real regression, 1.83 to
 * 8 ms, still fails, and the absolute ceilings above still cap the budget itself.
 * A baseline at or above `P95_ALLOWANCE_BELOW_MS` is compared by ratio alone.
 */
export const P95_NOISE_ALLOWANCE_MS = 2
/** Absolute ceiling for any interactive frame (Issue #1025 7.4). */
export const FRAME_CEILING_MS = 100
/** P2: input latency may not grow with transcript length (p95 L / p95 S). */
export const P2_MAX_SCALE = 1.5
/**
 * P2 is a ratio of two sub-millisecond samples, which swings several-fold on
 * noise alone (S 0.24 ms against M 0.97 ms was seen with nothing changed). It
 * fails only when the larger transcript is also this much slower in absolute
 * milliseconds. A cost that grows with the message count shows up in tens of
 * milliseconds, far above this floor.
 */
export const P2_NOISE_FLOOR_MS = 2
/**
 * P12: a reply written at the tail has to cost the same whatever the length of the transcript above it
 * (#1260), so the windowed session (`XL`, p95 of a streamed frame) may not cost more than this many times
 * the longest fully mounted one (`L`). Before #1260 it cost ten times as much.
 */
export const P12_MAX_SCALE = 2
/**
 * Like `P2_NOISE_FLOOR_MS`: two sub-millisecond p95s swing on noise alone, so `P12_MAX_SCALE` fails only when
 * the windowed session is also this much slower in absolute milliseconds (scaled by a slower runner's
 * machine factor). A cost that grows with the transcript shows up in milliseconds, above this floor.
 */
export const P12_NOISE_FLOOR_MS = 2
/**
 * P14: with a sub-millisecond p95 the 10% rule measures the scheduler, so the
 * gate reads the absolute increase instead.
 */
export const P14_ABSOLUTE_INCREASE_MS = 0.5

export type AbsoluteCap = { id: string; metric: string; max: number }

/**
 * Fixed ceilings from Issue #1025 7.4, in milliseconds. They do not depend on
 * `baseline.json`: they are the budgets a user feels on the reference machine
 * the calibration describes. A slower runner gets headroom in proportion to its
 * measured render-path factor (`noiseScale`, never below 1), so a shared CI host
 * that lays out 1.5x slower is not read as a regression; a faster machine is
 * never held to a tighter ceiling. Tightening is safe; loosening needs the
 * maintainer. The primed variants share the target of the scenario they extend.
 */
export const ABSOLUTE_CAPS: readonly AbsoluteCap[] = [
  { id: "P1", metric: "p95Ms", max: 16 },
  { id: "P1", metric: "p99Ms", max: 33 },
  { id: "P5", metric: "openP95Ms", max: 33 },
  { id: "P5", metric: "maxMs", max: FRAME_CEILING_MS },
  { id: "P5'", metric: "openP95Ms", max: 33 },
  { id: "P5'", metric: "maxMs", max: FRAME_CEILING_MS },
  { id: "P6", metric: "filterP95Ms", max: 16 },
  { id: "P6", metric: "escapeP95Ms", max: 16 },
  { id: "P8", metric: "p99Ms", max: 33 },
  { id: "P8", metric: "maxMs", max: FRAME_CEILING_MS },
  { id: "P8'", metric: "p99Ms", max: 33 },
  { id: "P8'", metric: "maxMs", max: FRAME_CEILING_MS },
  { id: "P9", metric: "p99Ms", max: 16 },
  { id: "P12", metric: "p95Ms", max: 33 },
]

/**
 * The baseline the `PENDING_REBASELINE` entries were written against. It names
 * the `commit` field of a baseline file; an entry applies only while
 * `baseline.json` still carries it.
 */
export const PENDING_BASELINE_COMMIT = "643c4e7fbf7a47b79fb87bc3f3e07817c6646042"

/**
 * Scenarios whose measurement changed after `baseline.json` was captured, so its
 * numbers describe a different experiment. Their baseline-relative timing check
 * is skipped; hard counters and absolute ceilings still apply. The skip is
 * scoped to `PENDING_BASELINE_COMMIT`: regenerating `baseline.json` ends it, and
 * `compare.test.ts` then fails until the entries are deleted.
 *
 * Empty since `baseline.json` was regenerated for P5, P5', P6, P8, P8', P9, P12
 * and P13 (#1025). To use the mechanism again, set `PENDING_BASELINE_COMMIT` to
 * the `commit` of the baseline the entries were written against and list each
 * scenario with the reason its measurement changed.
 */
export const PENDING_REBASELINE: Readonly<Record<string, string>> = {}

/**
 * Scenarios whose baseline-relative check is skipped on a windowed session. Over
 * 2000 rows a windowed scroll step costs O(rows): Solid mounts and unmounts rows
 * and rebuilds the row table, and its frame times scatter several-fold with the
 * machine's load (on one machine, streaming-scroll P8' p99 ranged from 18 ms at a
 * one-minute load of 1 to 2 to 87 ms under heavy load, and hot P9 p99 from 9 to
 * 44 ms). A 1.30x ratio against one baseline would mostly measure the scheduler
 * there. They still answer to the absolute ceilings, which are what a user feels
 * (P8 and P8' p99 33 ms with no frame over 100 ms, P9 p99 16 ms) and which scale
 * by `max(1, machine factor)` like every other ceiling; the factor comes from `S`,
 * `M`, and `L`, not from `XL`. The fully mounted sessions keep the
 * baseline-relative check for the same scenarios.
 */
export const WINDOWED_RELATIVE_EXEMPT: ReadonlySet<string> = new Set(["P8", "P8'", "P9"])

/**
 * What a session marked `windowed` has to carry. Its cold scroll is the only
 * measurement of the windowed path against the scroll budget, and its stream is
 * the only one over a transcript that long. `compareReports` lets a scenario be
 * absent from a partial report, so without this a scenario removed from the
 * windowed scope would take its budget with it and the run would still pass.
 */
export const WINDOWED_REQUIRED: readonly { id: string; metrics: readonly string[] }[] = [
  { id: "P8", metrics: ["p99Ms", "maxMs"] },
  { id: "P8'", metrics: ["p99Ms", "maxMs"] },
  { id: "P12", metrics: ["p95Ms"] },
  { id: "P13", metrics: ["deltaMessageWrites", "deltaPartWrites", "messageWritesPerFrame", "partWritesPerFrame"] },
]

const SIZE_ORDER = ["S", "M", "L", "XL"]
/** Not compared against the baseline: one frame, or a signed difference of two samples. */
const NO_RATIO = new Set(["maxMs", "increaseMs"])

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

/**
 * A faster machine has no reason to hold anything tighter: the calibration that
 * sets the factor is itself noisy (0.5x to 1.1x on one machine, 0.91 in a run
 * that otherwise matched its baseline), so a factor below 1 would only shrink a
 * limit by the calibration's own noise. A slower runner still gets the headroom.
 * The noise floors, the absolute ceilings, and the ratio checks all scale by it.
 */
const noiseScale = (factor: number) => Math.max(1, factor)

export type CompareOptions = {
  /** Scenarios to skip the baseline-relative check for; defaults to `PENDING_REBASELINE`. */
  pending?: Readonly<Record<string, string>>
  /** Commit the pending entries were written against; defaults to `PENDING_BASELINE_COMMIT`. */
  pendingCommit?: string
}

export function compareReports(baseline: PerfReport, current: PerfReport, options: CompareOptions = {}): CompareResult {
  const pendingTable = options.pending ?? PENDING_REBASELINE
  const pendingCommit = options.pendingCommit ?? PENDING_BASELINE_COMMIT
  const isPending = (id: string) => baseline.commit === pendingCommit && Object.hasOwn(pendingTable, id)
  const rows: CompareRow[] = []
  const failures: Failure[] = []
  const missing: MissingMetric[] = []
  const missingKeys = new Set<string>()
  const pending = new Set<string>()
  const factor = machineFactor(baseline, current)
  const sizes = Object.keys(current.scenarios).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b))
  const windowed: string[] = []
  let flagged = 0

  const fail = (size: string, id: string, name: string, limit: string, value: number) => {
    failures.push({ size, id, metric: name, limit, value })
  }

  /**
   * A scenario the report lacks is a partial report; a scenario it has without
   * the metric the gate needs is drift, and is recorded instead of skipped.
   */
  const read = (size: string, id: string, name: string): number | undefined => {
    const metrics = scenario(current, size, id)
    if (!metrics) return undefined
    const value = metrics[name]
    if (typeof value === "number") return value
    if (!missingKeys.has(`${size}/${id}/${name}`)) {
      missingKeys.add(`${size}/${id}/${name}`)
      missing.push({ size, id, metric: name })
    }
    return undefined
  }

  /** Like `read`, but a scenario that is absent altogether is missing too: the caller needs it. */
  const needs = (size: string, id: string, name: string) => {
    const value = scenario(current, size, id)?.[name]
    if (typeof value === "number") return value
    if (!missingKeys.has(`${size}/${id}/${name}`)) {
      missingKeys.add(`${size}/${id}/${name}`)
      missing.push({ size, id, metric: name })
    }
    return undefined
  }

  for (const size of sizes) {
    const windowedSession = scenario(current, size, "P10")?.windowed === 1
    for (const [id, metrics] of Object.entries(current.scenarios[size] ?? {})) {
      const before = scenario(baseline, size, id)
      if (!before) continue
      const skipped = isPending(id)
      if (skipped) pending.add(id)
      const exempt = windowedSession && WINDOWED_RELATIVE_EXEMPT.has(id)
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
        // past the ratio. It is gated by the absolute ceilings below instead.
        if (!name.endsWith("Ms") || NO_RATIO.has(name) || skipped || exempt) continue
        const scale = noiseScale(factor)
        const adjusted = value / scale
        const p99 = name.endsWith("p99Ms")
        const lowP95 = /p95ms$/i.test(name) && old < P95_ALLOWANCE_BELOW_MS
        const tolerance = p99 ? P99_TIMING_RATIO : TIMING_RATIO
        const subMillisecond = old < MIN_COMPARE_MS
        const allowance = p99
          ? P99_NOISE_ALLOWANCE_MS
          : Math.max(subMillisecond ? SUB_MS_ALLOWANCE_MS : 0, lowP95 ? P95_NOISE_ALLOWANCE_MS : 0)
        const limit = Math.max(old * tolerance, old + allowance)
        if (adjusted > limit) {
          const kind = p99 ? "p99" : subMillisecond ? "sub-millisecond" : "p95"
          const rule =
            allowance > 0
              ? `${tolerance.toFixed(2)}× baseline or +${allowance} ms ${kind} allowance`
              : `${tolerance.toFixed(2)}× baseline`
          fail(size, id, name, `≤ ${limit.toFixed(2)} (${rule}, machine factor ${scale.toFixed(3)})`, adjusted)
        }
      }
    }

    const check = (id: string, name: string, limit: string, allowed: (value: number) => boolean) => {
      const value = read(size, id, name)
      if (value === undefined) return
      if (!allowed(value)) fail(size, id, name, limit, value)
    }

    // Fixed ceilings, independent of the baseline values; scaled up on a slower runner only.
    for (const cap of ABSOLUTE_CAPS) {
      const ceiling = cap.max * noiseScale(factor)
      const label =
        ceiling === cap.max
          ? `≤ ${cap.max} ms`
          : `≤ ${ceiling.toFixed(2)} ms (${cap.max} ms × machine factor ${factor.toFixed(3)})`
      check(cap.id, cap.metric, label, (value) => value <= ceiling)
    }

    // P2: input latency must not scale with the transcript.
    const scale = read(size, "P2", "p95Scale")
    if (scale !== undefined && scale > P2_MAX_SCALE) {
      const small = read("S", "P1", "p95Ms")
      const here = read(size, "P1", "p95Ms")
      const slower = small === undefined || here === undefined ? Infinity : (here - small) / noiseScale(factor)
      if (slower > P2_NOISE_FLOOR_MS) {
        fail(size, "P2", "p95Scale", `≤ ${P2_MAX_SCALE} (or less than ${P2_NOISE_FLOOR_MS} ms slower than S)`, scale)
      }
    }

    // P12: a streamed frame over the windowed transcript costs what it costs over L, not what the
    // transcript is long. Only the windowed session is held to it; a partial report without L is not drift.
    if (windowedSession) {
      const streamed = read(size, "P12", "p95Ms")
      const reference = read("L", "P12", "p95Ms")
      if (streamed !== undefined && reference !== undefined && streamed > P12_MAX_SCALE * reference) {
        const slower = (streamed - reference) / noiseScale(factor)
        if (slower > P12_NOISE_FLOOR_MS) {
          fail(
            size,
            "P12",
            "p95Scale",
            `≤ ${P12_MAX_SCALE} × L (or less than ${P12_NOISE_FLOOR_MS} ms slower than L)`,
            Number((streamed / reference).toFixed(3)),
          )
        }
      }
    }

    // P3/P4: a keystroke must not register keymap layers or re-run selectors.
    check("P3", "registerLayer", "0", (value) => value === 0)
    check("P4", "selectorEvaluations", "0", (value) => value === 0)
    check("P7", "registerLayer", "≤ 2", (value) => value <= 2)

    // P10: only viewport + overscan + tail rows stay mounted, in a transcript at
    // or above `WINDOW_MIN_ROWS`. Below it every row is mounted by design, so the
    // bound says nothing about those sessions.
    const flag = read(size, "P10", "windowed")
    if (flag !== undefined) flagged++
    if (flag === 1) {
      windowed.push(size)
      for (const required of WINDOWED_REQUIRED) for (const name of required.metrics) needs(size, required.id, name)
      const viewport = read(size, "P10", "viewportRows") ?? 0
      const rowLimit = viewport + 2 * PART_OVERSCAN + TAIL_ALWAYS
      check("P10", "mountedRows", `≤ ${rowLimit}`, (value) => value <= rowLimit)
      check("P10", "scrollChildren", `≤ ${rowLimit + 2}`, (value) => value <= rowLimit + 2)
    }

    // P11: the viewport anchor may not drift by more than one line (2px rows).
    check("P11", "driftPx", "≤ 2", (value) => value <= 2)

    // P13: a streamed token goes to the stream buffer, never to the store; the
    // snapshots that open and close a reply stay within one write per frame.
    check("P13", "deltaMessageWrites", "0", (value) => value === 0)
    check("P13", "deltaPartWrites", "0", (value) => value === 0)
    check("P13", "messageWritesPerFrame", "≤ 1", (value) => value <= 1)
    check("P13", "partWritesPerFrame", "≤ 1", (value) => value <= 1)

    // P14: background sessions must not write the active session's store, nor
    // slow the main session's input.
    check("P14", "nonCurrentMessageWrites", "0", (value) => value === 0)
    check("P14", "nonCurrentPartWrites", "0", (value) => value === 0)
    const p14P95 = read(size, "P14", "p95Ms")
    if (p14P95 !== undefined && p14P95 >= MIN_COMPARE_MS) {
      check("P14", "relativeIncrease", "≤ 0.10", (value) => value <= 0.1)
    } else if (p14P95 !== undefined) {
      // A sub-millisecond p95 moves by tens of percent on noise alone; the
      // absolute increase is what the background load actually costs.
      const increase = read(size, "P14", "increaseMs")
      const scaled = increase === undefined ? undefined : increase / noiseScale(factor)
      if (scaled !== undefined && scaled > P14_ABSOLUTE_INCREASE_MS) {
        fail(size, "P14", "increaseMs", `≤ ${P14_ABSOLUTE_INCREASE_MS} ms (p95 below ${MIN_COMPARE_MS} ms)`, scaled)
      }
    }

    // P15-P19: timer and mouse frames.
    const tickLimit = Math.ceil((2 * 1_000) / TICK_MS) + 2
    check("P15", "frames", "0", (value) => value === 0)
    check("P16", "frames", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    check("P17", "framesEmpty", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    check("P17", "framesEight", `≤ ${tickLimit}`, (value) => value <= tickLimit)
    const empty = read(size, "P17", "framesEmpty")
    const eight = read(size, "P17", "framesEight")
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

  // P10 would pass vacuously if no session in the report were windowed. A P10
  // that carries no flag at all is drift and is already listed as missing.
  if (flagged > 0 && windowed.length === 0) {
    fail("all", "P10", "windowed", "at least one session at or above WINDOW_MIN_ROWS", 0)
  }

  // P4: the per-key selector count may not depend on how many messages exist.
  const smallSelectors = scenario(current, "S", "P4")?.selectorEvaluations
  for (const size of sizes) {
    const selectors = scenario(current, size, "P4")?.selectorEvaluations
    if (size !== "S" && typeof smallSelectors === "number" && typeof selectors === "number" && smallSelectors !== selectors) {
      fail(size, "P4", "selectorEvaluations", `= ${smallSelectors} (same as S)`, selectors)
    }
  }

  return { rows, failures, missing, pending: [...pending] }
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
  const { rows, failures, missing, pending } = compareReports(baseline, current)
  console.log(
    JSON.stringify(
      { baseline: path.resolve(baselinePath), current: path.resolve(currentPath), rows, failures, missing, pending },
      null,
      2,
    ),
  )
  if (flags.includes("--enforce") && (failures.length > 0 || missing.length > 0)) process.exit(1)
}

if (import.meta.main) await main()
