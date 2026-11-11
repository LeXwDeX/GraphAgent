// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import {
  compareReports,
  MIN_COMPARE_MS,
  P99_NOISE_ALLOWANCE_MS,
  P99_TIMING_RATIO,
  TIMING_RATIO,
  type PerfReport,
} from "./compare"

function report(metrics: Record<string, number>, calibration?: { fixedLayoutMsMedian?: number }): PerfReport {
  return { calibration, scenarios: { L: { P1: metrics } } }
}

test("a sub-millisecond baseline does not gate the ratio check", () => {
  const baseline = report({ p99Ms: 0.97 })
  const current = report({ p99Ms: 2.15 })

  const { rows, failures } = compareReports(baseline, current)

  expect(failures).toEqual([])
  expect(rows).toHaveLength(1)
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

test("a sub-millisecond current sample stays below the floor", () => {
  const baseline = report({ p50Ms: 2 })
  const current = report({ p50Ms: 0.5 })

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("p99 uses the wider ratio while other percentiles use the relative one", () => {
  const baseline = report({ p95Ms: 2, p99Ms: 2 })
  const current = report({
    p95Ms: 2 * TIMING_RATIO + 0.01,
    p99Ms: 2 * P99_TIMING_RATIO - 0.01,
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

function p14(p95Ms: number, relativeIncrease: number): PerfReport {
  return { scenarios: { L: { P14: { p95Ms, relativeIncrease } } } }
}

test("a sub-millisecond P14 sample does not gate the relative increase", () => {
  const baseline = p14(0.12, 0.09)
  const current = p14(0.3, 0.11)

  expect(compareReports(baseline, current).failures).toEqual([])
})

test("a P14 sample at the floor still gates the relative increase", () => {
  const baseline = p14(2, 0.09)
  const current = p14(2, 0.11)

  const { failures } = compareReports(baseline, current)

  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("relativeIncrease")
})
