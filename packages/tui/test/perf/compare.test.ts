// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import path from "node:path"
import {
  ABSOLUTE_CAPS,
  compareReports,
  FRAME_CEILING_MS,
  MIN_COMPARE_MS,
  P12_MAX_SCALE,
  P12_NOISE_FLOOR_MS,
  P14_ABSOLUTE_INCREASE_MS,
  P2_MAX_SCALE,
  P2_NOISE_FLOOR_MS,
  P95_ALLOWANCE_BELOW_MS,
  P95_NOISE_ALLOWANCE_MS,
  P99_NOISE_ALLOWANCE_MS,
  P99_TIMING_RATIO,
  PENDING_BASELINE_COMMIT,
  PENDING_REBASELINE,
  SUB_MS_ALLOWANCE_MS,
  TIMING_RATIO,
  WINDOWED_RELATIVE_EXEMPT,
  WINDOWED_REQUIRED,
  type PerfReport,
  type ScenarioMetrics,
} from "./compare"
import { PART_OVERSCAN, TAIL_ALWAYS } from "../../src/routes/session/rows"
import { SCENARIO_IDS, WINDOWED_SKIPS } from "./scenarios"
import { tmpdir } from "../fixture/fixture"

/** An id the gate has no fixed rule for, so only the baseline-relative check applies. */
const PLAIN = "PX"

function report(
  metrics: Record<string, number>,
  calibration?: { fixedLayoutMsMedian?: number },
  id: string = PLAIN,
): PerfReport {
  return { calibration, scenarios: { L: { [id]: metrics } } }
}

test("a sub-millisecond baseline is compared by absolute increase", () => {
  const baseline = report({ p95Ms: 0.49 })

  // Within the allowance: sub-millisecond noise must not gate.
  expect(compareReports(baseline, report({ p95Ms: 0.49 + SUB_MS_ALLOWANCE_MS - 0.1 })).failures).toEqual([])
  // Beyond it, however far below the ratio-times-baseline the old floor skipped: 0.49 -> 40 ms.
  const { failures } = compareReports(baseline, report({ p95Ms: 40 }))
  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("p95Ms")
})

test("the in-memory regressions from the audit now fail", () => {
  // The audit rewrote these baselines in memory and the gate let all of them through.
  const cases = [
    { id: "P1", metric: "p95Ms", before: 0.49, after: 40 },
    { id: "P5", metric: "openP95Ms", before: 0.5, after: 50 },
    { id: "P9", metric: "p99Ms", before: 12.84, after: 19 },
  ]
  for (const item of cases) {
    const baseline = report({ [item.metric]: item.before }, undefined, item.id)
    const current = report({ [item.metric]: item.after }, undefined, item.id)
    expect(compareReports(baseline, current).failures.length).toBeGreaterThan(0)
  }
})

test("the sub-millisecond allowance does not relax baselines at or above the floor", () => {
  // p50, not p95: a p95 under 3 ms has its own allowance, tested below.
  const baseline = report({ p50Ms: MIN_COMPARE_MS })

  expect(compareReports(baseline, report({ p50Ms: MIN_COMPARE_MS * TIMING_RATIO - 0.01 })).failures).toEqual([])
  expect(compareReports(baseline, report({ p50Ms: MIN_COMPARE_MS * TIMING_RATIO + 0.01 })).failures).toHaveLength(1)
})

test("a baseline at the floor still gates a regression beyond the p99 allowance", () => {
  const baseline = report({ p99Ms: MIN_COMPARE_MS })
  const current = report({ p99Ms: MIN_COMPARE_MS + P99_NOISE_ALLOWANCE_MS + 0.1 })

  const { failures } = compareReports(baseline, current)

  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("p99Ms")
})

test("the p99 allowance absorbs a hosted-CI scheduler tail", () => {
  // Observed on the hosted runner: the same scenario moved from 7.03 to
  // 14.02 ms while the layout calibration moved from 23.29 to 30.24 ms.
  const baseline = report({ p99Ms: 7.03 }, { fixedLayoutMsMedian: 23.29 })
  const current = report({ p99Ms: 14.02 }, { fixedLayoutMsMedian: 30.24 })

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("the p99 allowance absorbs the smaller-factor hosted runs", () => {
  // Build 854 (M P1): 1.66 → 3.39 ms with a 1.331 factor; build 851 (S P1):
  // 1.28 → 3.90 ms with a 1.450 factor. The factor shrinks the ratio limit,
  // so the absolute allowance is what keeps these runs from failing.
  const cases = [
    { baseline: 1.66, current: 3.39, factor: 1.331 },
    { baseline: 1.28, current: 3.9, factor: 1.45 },
  ]
  for (const item of cases) {
    const baseline = report({ p99Ms: item.baseline }, { fixedLayoutMsMedian: 23.29 })
    const current = report({ p99Ms: item.current }, { fixedLayoutMsMedian: 23.29 * item.factor })

    expect(compareReports(baseline, current).failures).toEqual([])
  }
})

test("a p99 regression beyond both the ratio and the allowance still fails", () => {
  const baseline = report({ p99Ms: 7.03 }, { fixedLayoutMsMedian: 23.29 })
  const current = report({ p99Ms: 30 }, { fixedLayoutMsMedian: 30.24 })

  const { failures } = compareReports(baseline, current)

  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("p99Ms")
})

test("the p99 allowance does not relax other percentiles", () => {
  const baseline = report({ p95Ms: 7.03 }, { fixedLayoutMsMedian: 23.29 })
  const current = report({ p95Ms: 12 }, { fixedLayoutMsMedian: 30.24 })

  expect(compareReports(baseline, current).failures).toHaveLength(1)
})

test("an improvement never fails, whatever the baseline", () => {
  const baseline = report({ p50Ms: 2 })
  const current = report({ p50Ms: 0.5 })

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("p99 uses the wider ratio while other percentiles use the relative one", () => {
  // At 10 ms neither percentile gets an absolute allowance, so the ratios decide.
  const baseline = report({ p95Ms: 10, p99Ms: 10 })
  const current = report({
    p95Ms: 10 * TIMING_RATIO + 0.01,
    p99Ms: 10 * P99_TIMING_RATIO - 0.01,
  })

  const { failures } = compareReports(baseline, current)

  expect(failures.map((failure) => failure.metric)).toEqual(["p95Ms"])
})

test("maxMs is left to the absolute frame ceiling", () => {
  const baseline = report({ maxMs: 2 })
  const current = report({ maxMs: 20 })

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("the machine factor normalizes the current timing", () => {
  const baseline = report({ p99Ms: 2 }, { fixedLayoutMsMedian: 10 })
  const current = report({ p99Ms: 3.9 }, { fixedLayoutMsMedian: 20 })

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("a p95 under 3 ms gets an absolute allowance on top of the ratio", () => {
  // Measured: S P5 open p95 moved from a 1.83 ms baseline to 3.62 ms with nothing changed.
  const baseline = report({ openP95Ms: 1.83 }, undefined, "P5")
  const compare = (value: number) => compareReports(baseline, report({ openP95Ms: value }, undefined, "P5")).failures

  expect(compare(3.62)).toEqual([])
  // The limit is the baseline plus the allowance; the ratio (2.38) is the smaller of the two.
  expect(compare(1.83 + P95_NOISE_ALLOWANCE_MS)).toEqual([])
  expect(compare(1.83 + P95_NOISE_ALLOWANCE_MS + 0.01)).toHaveLength(1)
  // A real regression still fails.
  const regressed = compare(8)
  expect(regressed).toHaveLength(1)
  expect(regressed[0]?.limit).toContain(`+${P95_NOISE_ALLOWANCE_MS} ms p95 allowance`)
})

test("the p95 allowance covers every p95 metric and only those", () => {
  const baseline = report({ p95Ms: 1.83, openP95Ms: 1.83, escapeP95Ms: 1.83, p50Ms: 1.83, p99Ms: 1.83 })

  // 3.62 ms: inside baseline + 2 ms for the three p95 names; p50 has only the ratio (2.38) and p99 its own 5 ms.
  const { failures } = compareReports(
    baseline,
    report({ p95Ms: 3.62, openP95Ms: 3.62, escapeP95Ms: 3.62, p50Ms: 3.62, p99Ms: 3.62 }),
  )

  expect(failures.map((failure) => failure.metric)).toEqual(["p50Ms"])
})

test("the p95 allowance ends at the baseline it was written for", () => {
  const compare = (before: number, now: number) =>
    compareReports(report({ p95Ms: before }), report({ p95Ms: now })).failures

  // Just under 3 ms: baseline + 2 ms is 4.99.
  expect(compare(P95_ALLOWANCE_BELOW_MS - 0.01, 4.9)).toEqual([])
  expect(compare(P95_ALLOWANCE_BELOW_MS - 0.01, 5.0)).toHaveLength(1)
  // At 3 ms the ratio decides alone: 3.9.
  expect(compare(P95_ALLOWANCE_BELOW_MS, 3.9)).toEqual([])
  expect(compare(P95_ALLOWANCE_BELOW_MS, 4.0)).toHaveLength(1)
})

test("a machine faster than the baseline's does not tighten the ratio", () => {
  // P5' open p95 on M: baseline 4.89 ms. 6.1 ms is 1.25x, inside the 1.30x ratio.
  const baseline = report({ openP95Ms: 4.89 }, { fixedLayoutMsMedian: 20 }, "P5'")
  const faster = report({ openP95Ms: 6.1 }, { fixedLayoutMsMedian: 18 }, "P5'")
  const same = report({ openP95Ms: 6.1 }, { fixedLayoutMsMedian: 20 }, "P5'")

  // A calibration 10% faster would have scaled 6.1 ms up to 6.78 and failed it.
  expect(compareReports(baseline, faster).failures).toEqual([])
  expect(compareReports(baseline, same).failures).toEqual([])
  // The ratio is still enforced on that machine.
  const over = report({ openP95Ms: 6.4 }, { fixedLayoutMsMedian: 18 }, "P5'")
  expect(compareReports(baseline, over).failures).toHaveLength(1)
})

test("a slower machine is still normalized by its factor", () => {
  const baseline = report({ openP95Ms: 4.89 }, { fixedLayoutMsMedian: 20 }, "P5'")

  // 1.5x slower: 9.0 ms normalizes to 6.0 ms, inside 6.36.
  expect(compareReports(baseline, report({ openP95Ms: 9 }, { fixedLayoutMsMedian: 30 }, "P5'")).failures).toEqual([])
  expect(compareReports(baseline, report({ openP95Ms: 10 }, { fixedLayoutMsMedian: 30 }, "P5'")).failures).toHaveLength(1)
})

function scenarioReport(id: string, metrics: Record<string, number>, calibration?: { fixedLayoutMsMedian?: number }) {
  return report(metrics, calibration, id)
}

test("every absolute cap fails just above its limit and passes at it, with no baseline entry", () => {
  for (const cap of ABSOLUTE_CAPS) {
    const at = compareReports({ scenarios: {} }, scenarioReport(cap.id, { [cap.metric]: cap.max }))
    const above = compareReports({ scenarios: {} }, scenarioReport(cap.id, { [cap.metric]: cap.max + 0.01 }))
    expect(at.failures).toEqual([])
    expect(above.failures.map((failure) => `${failure.id}.${failure.metric}`)).toEqual([`${cap.id}.${cap.metric}`])
  }
})

test("the absolute caps match the issue's budgets", () => {
  const caps = Object.fromEntries(ABSOLUTE_CAPS.map((cap) => [`${cap.id}.${cap.metric}`, cap.max]))
  expect(caps).toMatchObject({
    "P1.p95Ms": 16,
    "P1.p99Ms": 33,
    "P5.openP95Ms": 33,
    "P5.maxMs": FRAME_CEILING_MS,
    "P6.filterP95Ms": 16,
    "P6.escapeP95Ms": 16,
    "P8.p99Ms": 33,
    "P8.maxMs": FRAME_CEILING_MS,
    "P8'.maxMs": FRAME_CEILING_MS,
    "P9.p99Ms": 16,
    "P12.p95Ms": 33,
  })
})

test("absolute caps get headroom on a slower runner in proportion to its machine factor", () => {
  // Hosted CI run of #1257: layout calibration 35.48 ms against the baseline's 23.29 ms, P9 p99 18.64 ms.
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 23.29 }, scenarios: {} }
  const slower: PerfReport = { calibration: { fixedLayoutMsMedian: 35.48 }, scenarios: { L: { P9: { p99Ms: 18.64 } } } }
  expect(compareReports(baseline, slower).failures).toEqual([])

  // The headroom is the factor and no more: 16 ms × 1.523 is about 24.4 ms.
  const tooSlow: PerfReport = { calibration: { fixedLayoutMsMedian: 35.48 }, scenarios: { L: { P9: { p99Ms: 25 } } } }
  const { failures } = compareReports(baseline, tooSlow)
  expect(failures.map((failure) => failure.metric)).toEqual(["p99Ms"])
  expect(failures[0]?.limit).toContain("16 ms × machine factor 1.523")
})

test("absolute caps never tighten on a faster machine", () => {
  // A runner twice as fast as the baseline machine is still held to the plain budget.
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 20 }, scenarios: {} }
  const atCap: PerfReport = { calibration: { fixedLayoutMsMedian: 10 }, scenarios: { L: { P9: { p99Ms: 16 } } } }
  expect(compareReports(baseline, atCap).failures).toEqual([])

  const over: PerfReport = { calibration: { fixedLayoutMsMedian: 10 }, scenarios: { L: { P9: { p99Ms: 17 } } } }
  const { failures } = compareReports(baseline, over)
  expect(failures.map((failure) => failure.metric)).toEqual(["p99Ms"])
  expect(failures[0]?.limit).toBe("≤ 16 ms")
})

test("the 100 ms frame ceiling covers the slash and scroll scenarios", () => {
  for (const id of ["P5", "P5'", "P8", "P8'"]) {
    const { failures } = compareReports({ scenarios: {} }, scenarioReport(id, { maxMs: FRAME_CEILING_MS + 1 }))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ id, metric: "maxMs" })
  }
})

function p2(scale: number, small: number, large: number): PerfReport {
  return {
    scenarios: {
      S: { P1: { p95Ms: small }, P2: { p95Scale: 1 } },
      L: { P1: { p95Ms: large }, P2: { p95Scale: scale } },
    },
  }
}

test("P2 fails when the larger transcript is both proportionally and absolutely slower", () => {
  const { failures } = compareReports({ scenarios: {} }, p2(P2_MAX_SCALE + 0.5, 4, 4 * (P2_MAX_SCALE + 0.5)))

  expect(failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)).toEqual(["L.P2.p95Scale"])
})

test("P2 passes at the limit and when the difference is below the noise floor", () => {
  expect(compareReports({ scenarios: {} }, p2(P2_MAX_SCALE, 4, 4 * P2_MAX_SCALE)).failures).toEqual([])
  // Observed on one machine: S 0.24 ms, M 0.97 ms. A 4x ratio, 0.73 ms of noise.
  expect(compareReports({ scenarios: {} }, p2(4.04, 0.24, 0.97)).failures).toEqual([])
  expect(4.04 > P2_MAX_SCALE && 0.97 - 0.24 < P2_NOISE_FLOOR_MS).toBe(true)
})

test("P2 does not tighten on a machine faster than the baseline's", () => {
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 24 }, scenarios: {} }
  const current = p2(4, 0.5, 2)
  current.calibration = { fixedLayoutMsMedian: 12 }

  // 1.5 ms slower on a 0.5x machine: scaling by the factor would read 3 ms and fail.
  expect(compareReports(baseline, current).failures).toEqual([])
})

/** The streamed frame of `L` and of the windowed `XL`, as the gate reads them. */
function p12(short: number, long: number, calibration?: { fixedLayoutMsMedian?: number }): PerfReport {
  return {
    calibration,
    scenarios: {
      L: { P10: { windowed: 0 }, P12: { p95Ms: short } },
      XL: { P10: { windowed: 1 }, P12: { p95Ms: long } },
    },
  }
}

const scaleFailures = (report: PerfReport) =>
  compareReports({ scenarios: {} }, report)
    .failures.filter((failure) => failure.metric === "p95Scale")
    .map((failure) => `${failure.size}.${failure.id}`)

test("P12 fails when a streamed frame over the windowed transcript costs far more than over L", () => {
  // Before #1260: 11 ms over 2080 rows against 1.2 ms over 190.
  expect(scaleFailures(p12(1.2, 11))).toEqual(["XL.P12"])
  // More than twice L, and just past the noise floor above it.
  expect(scaleFailures(p12(1, 1 + P12_NOISE_FLOOR_MS))).toEqual([])
  expect(scaleFailures(p12(1, 1 + P12_NOISE_FLOOR_MS + 0.1))).toEqual(["XL.P12"])
})

test("P12 passes at twice L and when the difference is below the noise floor", () => {
  expect(scaleFailures(p12(3, 3 * P12_MAX_SCALE))).toEqual([])
  // Sub-millisecond p95s: a 3x ratio that is 0.9 ms of noise.
  expect(scaleFailures(p12(0.45, 1.35))).toEqual([])
  expect(1.35 > P12_MAX_SCALE * 0.45 && 1.35 - 0.45 < P12_NOISE_FLOOR_MS).toBe(true)
})

test("P12 holds only the windowed session to the scale, and a slower machine gets the floor scaled", () => {
  // A fully mounted session above L would pay for its own mounted nodes; only the windowed one is gated.
  const mounted: PerfReport = {
    scenarios: {
      L: { P10: { windowed: 0 }, P12: { p95Ms: 1 } },
      M: { P10: { windowed: 0 }, P12: { p95Ms: 20 } },
    },
  }
  expect(scaleFailures(mounted)).toEqual([])
  // 3 ms slower than L: over the floor on the reference machine, inside it on one twice as slow.
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 20 }, scenarios: {} }
  const slow = p12(1, 4.5, { fixedLayoutMsMedian: 40 })
  expect(compareReports(baseline, slow).failures.filter((failure) => failure.metric === "p95Scale")).toEqual([])
  const same = p12(1, 4.5, { fixedLayoutMsMedian: 20 })
  expect(compareReports(baseline, same).failures.filter((failure) => failure.metric === "p95Scale")).toHaveLength(1)
  // A report without L is a partial one, not drift.
  const partial: PerfReport = { scenarios: { XL: { P10: { windowed: 1 }, P12: { p95Ms: 30 } } } }
  expect(scaleFailures(partial)).toEqual([])
})

function p4(small: number, large: number): PerfReport {
  return {
    scenarios: {
      S: { P4: { selectorEvaluations: small } },
      L: { P4: { selectorEvaluations: large } },
    },
  }
}

test("P4 requires zero selector evaluations per key, equal for the small and the large session", () => {
  expect(compareReports({ scenarios: {} }, p4(0, 0)).failures).toEqual([])
  // The cascade that grew with the message count: one selector per message.
  const grown = compareReports({ scenarios: {} }, p4(0, 8))
  expect(grown.failures.map((failure) => `${failure.size}.${failure.metric}`)).toContain("L.selectorEvaluations")
  // A constant nonzero count is not the contract either.
  expect(compareReports({ scenarios: {} }, p4(3, 3)).failures).toHaveLength(2)
})

function p14(
  p95Ms: number,
  relativeIncrease: number,
  increaseMs: number,
  calibration?: { fixedLayoutMsMedian?: number },
) {
  return { calibration, scenarios: { L: { P14: { p95Ms, relativeIncrease, increaseMs } } } } satisfies PerfReport
}

test("a sub-millisecond P14 sample is gated by absolute increase, not by ratio", () => {
  // +80% of 0.12 ms is scheduler noise; +0.4 ms is within the allowance.
  expect(compareReports({ scenarios: {} }, p14(0.3, 0.8, P14_ABSOLUTE_INCREASE_MS - 0.1)).failures).toEqual([])
  const { failures } = compareReports({ scenarios: {} }, p14(0.9, 1.5, P14_ABSOLUTE_INCREASE_MS + 0.1))
  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("increaseMs")
})

test("a slower runner gets headroom on the P14 absolute increase, a faster one gets no extra strictness", () => {
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 20 }, scenarios: {} }
  const slower = p14(0.9, 1, P14_ABSOLUTE_INCREASE_MS + 0.2, { fixedLayoutMsMedian: 40 })
  const faster = p14(0.9, 1, P14_ABSOLUTE_INCREASE_MS - 0.05, { fixedLayoutMsMedian: 10 })

  expect(compareReports(baseline, slower).failures).toEqual([])
  expect(compareReports(baseline, faster).failures).toEqual([])
})

test("a P14 sample at the floor still gates the relative increase", () => {
  expect(compareReports({ scenarios: {} }, p14(MIN_COMPARE_MS, 0.09, 0.09)).failures).toEqual([])
  const { failures } = compareReports({ scenarios: {} }, p14(MIN_COMPARE_MS, 0.11, 0.11))
  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("relativeIncrease")
})

test("a gate metric the report does not carry is reported, not skipped", () => {
  // The slash scenario once emitted `maxFrame` while the ceiling read `maxMs`:
  // the ceiling never ran and nothing said so.
  const stale: PerfReport = { scenarios: { L: { P5: { openP95Ms: 4, maxFrame: 250 } } } }

  const { failures, missing } = compareReports({ scenarios: {} }, stale)

  expect(failures).toEqual([])
  expect(missing).toContainEqual({ size: "L", id: "P5", metric: "maxMs" })
})

test("a scenario the report omits entirely is a partial report, not drift", () => {
  const { missing } = compareReports({ scenarios: {} }, { scenarios: { L: { P3: { registerLayer: 0 } } } })

  expect(missing.filter((item) => item.id === "P5")).toEqual([])
})

function p13(metrics: Record<string, number>): PerfReport {
  return {
    scenarios: {
      L: {
        P13: { deltaMessageWrites: 0, deltaPartWrites: 0, messageWritesPerFrame: 0, partWritesPerFrame: 0.01, ...metrics },
      },
    },
  }
}

test("P13 requires every streamed delta to leave the store untouched", () => {
  expect(compareReports({ scenarios: {} }, p13({})).failures).toEqual([])

  // A delta that reached store.part (the old per-token write) fails, however few frames it spans.
  const part = compareReports({ scenarios: {} }, p13({ deltaPartWrites: 1 }))
  expect(part.failures.map((failure) => failure.metric)).toEqual(["deltaPartWrites"])
  const message = compareReports({ scenarios: {} }, p13({ deltaMessageWrites: 1 }))
  expect(message.failures.map((failure) => failure.metric)).toEqual(["deltaMessageWrites"])
})

test("P13 keeps the per-frame bound on the snapshots that open and close a reply", () => {
  expect(compareReports({ scenarios: {} }, p13({ partWritesPerFrame: 1 })).failures).toEqual([])
  const { failures } = compareReports({ scenarios: {} }, p13({ partWritesPerFrame: 1.5 }))
  expect(failures.map((failure) => failure.metric)).toEqual(["partWritesPerFrame"])
})

test("a P13 report that stops separating the delta phase is drift, not a pass", () => {
  // Before the scenario sent real deltas it emitted per-frame ratios only, and "0 writes while streaming" was never measured.
  const stale: PerfReport = { scenarios: { L: { P13: { messageWritesPerFrame: 0, partWritesPerFrame: 1 } } } }

  const { missing } = compareReports({ scenarios: {} }, stale)

  expect(missing).toContainEqual({ size: "L", id: "P13", metric: "deltaPartWrites" })
  expect(missing).toContainEqual({ size: "L", id: "P13", metric: "deltaMessageWrites" })
})

test("P10 bounds the mounted rows of a windowed session and leaves a fully mounted one alone", () => {
  const limit = 19 + 2 * PART_OVERSCAN + TAIL_ALWAYS

  const within = compareReports(
    { scenarios: {} },
    fullReport((size, items) => {
      if (size === "XL") items.P10 = { ...items.P10, mountedRows: limit, scrollChildren: limit + 2 }
    }),
  )
  expect(within.failures).toEqual([])

  const over = compareReports(
    { scenarios: {} },
    fullReport((size, items) => {
      if (size === "XL") items.P10 = { ...items.P10, mountedRows: limit + 1, scrollChildren: limit + 3 }
    }),
  )
  expect(over.failures.map((failure) => `${failure.size}.${failure.metric}`)).toEqual([
    "XL.mountedRows",
    "XL.scrollChildren",
  ])

  // 190 mounted rows in a session below the threshold is the design, not a leak.
  expect(fullReport().scenarios.L?.P10?.mountedRows).toBeGreaterThan(limit)
})

test("a report without a windowed session fails P10 instead of passing it vacuously", () => {
  const { failures } = compareReports(
    { scenarios: {} },
    fullReport((size, items) => {
      if (size === "XL") items.P10 = { ...items.P10, windowed: 0 }
    }),
  )

  expect(failures.map((failure) => `${failure.id}.${failure.metric}`)).toEqual(["P10.windowed"])
  // A partial report that never measured P10 is not drift.
  expect(compareReports({ scenarios: {} }, { scenarios: { L: { P3: { registerLayer: 0 } } } }).failures).toEqual([])
})

test("a P10 that does not say whether its session is windowed is drift", () => {
  const stale: PerfReport = { scenarios: { XL: { P10: { mountedRows: 22, scrollChildren: 26, viewportRows: 19 } } } }

  const { missing } = compareReports({ scenarios: {} }, stale)

  expect(missing).toContainEqual({ size: "XL", id: "P10", metric: "windowed" })
})

test("a session marked windowed has to carry the cold scroll, or the budget leaves with the scenario", () => {
  // Codex review of #1266: with the cold scroll out of the windowed scope, a frame of
  // 150 ms in the windowed scroll passed the gate because nothing measured it.
  expect(WINDOWED_REQUIRED.map((item) => item.id)).toEqual(["P8", "P8'", "P12", "P13"])
  // The scope has to run what the gate requires of it.
  for (const item of WINDOWED_REQUIRED) expect([...WINDOWED_SKIPS]).not.toContain(item.id)

  for (const id of ["P8", "P8'"]) {
    const { missing, failures } = compareReports(
      { scenarios: {} },
      fullReport((size, items) => {
        if (size === "XL") delete items[id]
      }),
    )

    expect(failures).toEqual([])
    expect(missing).toEqual([
      { size: "XL", id, metric: "p99Ms" },
      { size: "XL", id, metric: "maxMs" },
    ])
  }

  // The stream is part of what a windowed session carries: its frame cost and its zero store writes.
  const metricsOf = (id: string) => WINDOWED_REQUIRED.find((item) => item.id === id)?.metrics ?? []
  for (const id of ["P12", "P13"]) {
    const { missing, failures } = compareReports(
      { scenarios: {} },
      fullReport((size, items) => {
        if (size === "XL") delete items[id]
      }),
    )

    expect(failures).toEqual([])
    expect(missing).toEqual(metricsOf(id).map((metric) => ({ size: "XL", id, metric })))
  }

  // A scenario that is there without one of its metrics is the drift the gate already reported.
  const partial = compareReports(
    { scenarios: {} },
    fullReport((size, items) => {
      if (size === "XL") items.P8 = { steps: 1310 }
    }),
  )
  expect(partial.missing.map((item) => `${item.id}.${item.metric}`)).toEqual(["P8.p99Ms", "P8.maxMs"])

  // A fully mounted session is not required to carry it in a report that has none (a partial report).
  const fullyMounted = compareReports(
    { scenarios: {} },
    fullReport((size, items) => {
      if (size === "L") delete items.P8
    }),
  )
  expect(fullyMounted.missing).toEqual([])
})

test("the windowed cold scroll answers to the absolute ceilings, scaled only by a slower machine", () => {
  const withScroll = (metrics: Record<string, number>, id = "P8", calibration?: { fixedLayoutMsMedian?: number }) => {
    const report = fullReport((size, items) => {
      if (size === "XL") items[id] = { ...items[id], ...metrics }
    })
    report.calibration = calibration ?? report.calibration
    return report
  }
  const failed = (report: PerfReport) =>
    compareReports({ scenarios: {} }, report).failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)

  for (const id of ["P8", "P8'"]) {
    // At the ceilings: p99 33 ms, and no frame over 100 ms.
    expect(failed(withScroll({ p99Ms: 33, maxMs: FRAME_CEILING_MS }, id))).toEqual([])
    expect(failed(withScroll({ p99Ms: 33.01 }, id))).toEqual([`XL.${id}.p99Ms`])
    expect(failed(withScroll({ maxMs: FRAME_CEILING_MS + 1 }, id))).toEqual([`XL.${id}.maxMs`])
  }

  // The machine factor comes from the report's calibration (mount of S, M and L): 1.5x slower gives 150 ms.
  const baseline: PerfReport = { calibration: { fixedLayoutMsMedian: 20 }, scenarios: {} }
  const slow = withScroll({ maxMs: 140 }, "P8", { fixedLayoutMsMedian: 30 })
  expect(compareReports(baseline, slow).failures).toEqual([])
  expect(compareReports(baseline, withScroll({ maxMs: 151 }, "P8", { fixedLayoutMsMedian: 30 })).failures).toHaveLength(1)
  // A faster machine is held to the plain 100 ms.
  expect(compareReports(baseline, withScroll({ maxMs: 101 }, "P8", { fixedLayoutMsMedian: 10 })).failures).toHaveLength(1)
})

test("the windowed session's scroll scenarios skip the ratio against the baseline but not the ceilings", () => {
  expect([...WINDOWED_RELATIVE_EXEMPT].sort()).toEqual(["P8", "P8'", "P9"])

  const grown = (size: string) => {
    const before = fullReport((name, items) => {
      if (name === size) {
        items.P8 = { p99Ms: 5, maxMs: 6, steps: 100 }
        items["P8'"] = { p99Ms: 5, maxMs: 6, steps: 100 }
        items.P9 = { p99Ms: 5 }
      }
    })
    const after = fullReport((name, items) => {
      if (name === size) {
        items.P8 = { p99Ms: 25, maxMs: 30, steps: 100 }
        items["P8'"] = { p99Ms: 25, maxMs: 30, steps: 100 }
        items.P9 = { p99Ms: 15 }
      }
    })
    return compareReports(before, after).failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)
  }

  // Five times the baseline on the windowed session is within the ceilings (33 ms, 16 ms), so it passes...
  expect(grown("XL")).toEqual([])
  // ...and the same growth on a fully mounted session fails the ratio (L is held to its baseline).
  expect(grown("L").sort()).toEqual(["L.P8'.p99Ms", "L.P8.p99Ms", "L.P9.p99Ms"])

  // The ceilings still bind the windowed session whatever its baseline says.
  const over = compareReports(
    fullReport(),
    fullReport((name, items) => {
      if (name === "XL") items.P9 = { p99Ms: 16.5 }
    }),
  )
  expect(over.failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)).toEqual(["XL.P9.p99Ms"])
})

/** Stand-in for the real table, so these cases keep working after the real entries are deleted. */
const PENDING = { PY: "measurement changed" }

test("a baseline captured at the pending commit skips the relative check for the pending scenarios only", () => {
  const baseline: PerfReport = {
    commit: "captured",
    scenarios: { L: { PY: { p95Ms: 5 }, [PLAIN]: { p95Ms: 5 } } },
  }
  const current: PerfReport = { scenarios: { L: { PY: { p95Ms: 10 }, [PLAIN]: { p95Ms: 10 } } } }

  const result = compareReports(baseline, current, { pending: PENDING, pendingCommit: "captured" })

  expect(result.pending).toEqual(["PY"])
  expect(result.failures.map((failure) => failure.id)).toEqual([PLAIN])
})

test("a baseline from any other commit gets the full relative check", () => {
  const baseline: PerfReport = { commit: "regenerated", scenarios: { L: { PY: { p95Ms: 5 } } } }
  const current: PerfReport = { scenarios: { L: { PY: { p95Ms: 10 } } } }

  const result = compareReports(baseline, current, { pending: PENDING, pendingCommit: "captured" })

  expect(result.pending).toEqual([])
  expect(result.failures).toHaveLength(1)
})

test("a pending scenario still answers to the fixed ceilings", () => {
  const baseline: PerfReport = { commit: "captured", scenarios: { L: { P6: { escapeP95Ms: 0.13 } } } }
  const current: PerfReport = { scenarios: { L: { P6: { escapeP95Ms: 20 } } } }

  const result = compareReports(baseline, current, {
    pending: { P6: "measurement changed" },
    pendingCommit: "captured",
  })

  expect(result.pending).toEqual(["P6"])
  expect(result.failures.map((failure) => failure.metric)).toEqual(["escapeP95Ms"])
})

async function committedBaseline() {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed benchmark report
  return (await Bun.file(path.join(import.meta.dir, "baseline.json")).json()) as PerfReport
}

test("the pending entries name real scenarios", () => {
  for (const id of Object.keys(PENDING_REBASELINE)) expect(SCENARIO_IDS.some((known) => known === id)).toBe(true)
})

test("the pending entries are deleted once baseline.json is regenerated", async () => {
  const baseline = await committedBaseline()
  if (baseline.commit === PENDING_BASELINE_COMMIT) return

  // baseline.json now comes from a newer run, so the entries no longer apply and
  // would only mislead; compare.ts ignores them already.
  expect(Object.keys(PENDING_REBASELINE)).toEqual([])
})

test("the committed baseline satisfies its own gate", async () => {
  const baseline = await committedBaseline()

  expect(compareReports(baseline, baseline).failures).toEqual([])
})

/**
 * A full set of metrics for one size, shaped like a real report with plausible
 * millisecond values. `XL` is the windowed session; the others mount every row.
 */
function scenarios(size = "L"): Record<string, ScenarioMetrics> {
  const windowed = size === "XL"
  const all: Record<string, ScenarioMetrics> = {
    P1: { p50Ms: 3, p95Ms: 6, p99Ms: 9 },
    P2: { p95Scale: 1 },
    P3: { registerLayer: 0 },
    P4: { selectorEvaluations: 0, selectorEvaluationsPerKey: 0 },
    P5: { openP95Ms: 6, sequenceP95Ms: 5, maxMs: 14, frames: 250 },
    "P5'": { openP95Ms: 7, sequenceP95Ms: 6, maxMs: 15, frames: 250 },
    P6: { filterP95Ms: 4, escapeP95Ms: 5 },
    P7: { registerLayer: 0 },
    P8: { p99Ms: 12, maxMs: 15, steps: 100 },
    "P8'": { p99Ms: 12, maxMs: 15, steps: 100 },
    P9: { p99Ms: 10 },
    P10: windowed
      ? { mountedRows: 22, scrollChildren: 26, viewportRows: 19, rows: 2080, windowed: 1 }
      : { mountedRows: 190, scrollChildren: 191, viewportRows: 19, rows: 190, windowed: 0 },
    P11: { driftPx: 0, stepMismatches: 0 },
    P12: { p95Ms: 8 },
    P13: { deltaMessageWrites: 0, deltaPartWrites: 0, messageWritesPerFrame: 0, partWritesPerFrame: 0.01 },
    P14: {
      p95Ms: 4,
      quietP95Ms: 4,
      increaseMs: 0,
      relativeIncrease: 0,
      nonCurrentMessageWrites: 0,
      nonCurrentPartWrites: 0,
    },
    P15: { frames: 0 },
    P16: { frames: 22 },
    P17: { framesEmpty: 22, framesEight: 22 },
    P17b: { frames: 0 },
    P18: { frames: 0 },
    P19: { frames: 0 },
    P20: { growth: 0, heapGrowth: 0.05 },
  }
  // The windowed session does not time a long scroll or a stream.
  if (windowed) for (const id of WINDOWED_SKIPS) delete all[id]
  return all
}

function fullReport(change?: (size: string, scenarios: Record<string, ScenarioMetrics>) => void): PerfReport {
  const result: PerfReport = { calibration: { fixedLayoutMsMedian: 20 }, scenarios: {} }
  for (const size of ["S", "M", "L", "XL"]) {
    const items = scenarios(size)
    change?.(size, items)
    result.scenarios[size] = items
  }
  return result
}

test("the synthetic report is clean against itself", () => {
  const baseline = fullReport()

  const result = compareReports(baseline, fullReport())

  expect(result.failures).toEqual([])
  expect(result.missing).toEqual([])
})

// The three CI failures Issue #1025 asks to see, fed to the gate as forged reports.

test("CI demo: a keystroke that re-registers layers (the P3 cascade) fails the gate", () => {
  const current = fullReport((size, items) => {
    if (size === "L") items.P3 = { registerLayer: 500 }
  })

  const { failures } = compareReports(fullReport(), current)

  expect(failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)).toEqual(["L.P3.registerLayer"])
})

test("CI demo: a 150 ms frame in the slash sequence fails the gate", () => {
  const current = fullReport((size, items) => {
    if (size === "L") items.P5 = { ...items.P5, maxMs: 150 }
  })

  const { failures } = compareReports(fullReport(), current)

  expect(failures.map((failure) => `${failure.size}.${failure.id}.${failure.metric}`)).toEqual(["L.P5.maxMs"])
})

test("CI demo: every timing 1.5x slower than the baseline fails the gate", () => {
  const slower = fullReport((_size, items) => {
    for (const metrics of Object.values(items)) {
      for (const [name, value] of Object.entries(metrics)) {
        if (name.endsWith("Ms") && typeof value === "number") metrics[name] = value * 1.5
      }
    }
  })

  const { failures } = compareReports(fullReport(), slower)

  // Ratio failures: every percentile with a 1.30x tolerance. p99 (1.50x) sits on its edge.
  const relative = failures.filter((failure) => failure.limit.includes("baseline"))
  expect(relative.length).toBeGreaterThan(0)
  expect(relative.some((failure) => failure.metric === "p95Ms")).toBe(true)
})

test("CI demo: the standalone gate exits 1 on a forged report and 0 on a clean one", async () => {
  await using directory = await tmpdir()
  const write = async (name: string, value: PerfReport) => {
    const file = path.join(directory.path, name)
    await Bun.write(file, JSON.stringify(value))
    return file
  }
  const baseline = await write("baseline.json", fullReport())
  const clean = await write("clean.json", fullReport())
  const forged = await write(
    "forged.json",
    fullReport((size, items) => {
      if (size === "L") items.P5 = { ...items.P5, maxMs: 150 }
    }),
  )
  const compare = path.join(import.meta.dir, "compare.ts")
  const run = (current: string, ...flags: string[]) =>
    Bun.spawnSync(["bun", compare, baseline, current, ...flags], { stdout: "pipe", stderr: "pipe" })

  expect(run(clean, "--enforce").exitCode).toBe(0)
  expect(run(forged, "--enforce").exitCode).toBe(1)
  // Without --enforce the command only reports.
  expect(run(forged).exitCode).toBe(0)
})
