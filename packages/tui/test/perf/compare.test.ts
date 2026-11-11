// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { compareReports, MIN_COMPARE_MS, P99_TIMING_RATIO, TIMING_RATIO, type PerfReport } from "./compare"

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

test("a baseline at the floor still gates the ratio check", () => {
  const baseline = report({ p99Ms: MIN_COMPARE_MS })
  const current = report({ p99Ms: MIN_COMPARE_MS * P99_TIMING_RATIO + 0.1 })

  const { failures } = compareReports(baseline, current)

  expect(failures).toHaveLength(1)
  expect(failures[0]?.metric).toBe("p99Ms")
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
