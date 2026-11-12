// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { compareReports, type PerfReport, type ScenarioMetrics } from "./compare"
import { createFixture, type FixtureSize } from "./fixtures"
import { mountHarness } from "./harness"
import { watchKeymapErrors } from "./keymap-errors"
import { runScenarios, scaleResult, SCENARIO_IDS } from "./scenarios"

/** Counters that must hold on any machine. Timing rules are exercised on forged reports; here they would only measure the test host. */
const COUNT_SCENARIOS = new Set(["P3", "P4", "P7", "P10", "P11", "P13", "P15", "P16", "P17", "P17b", "P18", "P19"])

async function liveReport(sizes: FixtureSize[]) {
  const report: PerfReport = { scenarios: {} }
  const p95: Record<string, number> = {}
  for (const size of sizes) {
    const harness = await mountHarness(createFixture(size, size === "M"))
    try {
      const results = await runScenarios(harness)
      report.scenarios[size] = Object.fromEntries(
        results.map(({ id, size: _size, ...metrics }): [string, ScenarioMetrics] => [id, metrics]),
      )
      p95[size] = Number(report.scenarios[size]?.P1?.p95Ms ?? 0)
    } finally {
      await harness.dispose()
    }
  }
  for (const size of sizes) {
    const { id, size: _size, ...metrics } = scaleResult(size, p95[size] ?? 0, p95.S ?? 0)
    report.scenarios[size][id] = metrics
  }
  return report
}

/** One live run of `S` and `M` serves every assertion below; each scenario pass costs seconds. */
let cached: Promise<{ report: PerfReport; keymapErrors: readonly string[] }> | undefined
function live() {
  cached ??= (async () => {
    const keymapErrors = watchKeymapErrors({ quiet: true })
    try {
      return { report: await liveReport(["S", "M"]), keymapErrors: keymapErrors.hits }
    } finally {
      keymapErrors.restore()
    }
  })()
  return cached
}

test("the runner emits every scenario with every metric the gate reads, and the keymap stays quiet", async () => {
  const { report, keymapErrors } = await live()

  expect(keymapErrors).toEqual([])
  for (const size of ["S", "M"]) {
    expect(Object.keys(report.scenarios[size] ?? {}).sort()).toEqual([...SCENARIO_IDS].sort())
  }
  const { missing, failures } = compareReports(report, report)
  expect(missing).toEqual([])
  expect(failures.filter((failure) => COUNT_SCENARIOS.has(failure.id))).toEqual([])
}, 120_000)

test("the slash scenarios walk 50 valid rounds: every key is consumed and the menu opens and closes", async () => {
  const { report } = await live()
  const p5 = report.scenarios.M?.P5
  const noisy = report.scenarios.M?.["P5'"]

  // `maxMs` and `frames` come from the same 50 rounds: 5 keys each, at least one frame per key.
  expect(Number(p5?.frames)).toBeGreaterThanOrEqual(250)
  expect(Number(p5?.maxMs)).toBeGreaterThan(0)
  expect(Number(noisy?.frames)).toBeGreaterThanOrEqual(250)
  expect(Number(noisy?.maxMs)).toBeGreaterThan(0)
}, 120_000)

test("an ESC that is never flushed merges with the next key and the guard reports it", async () => {
  // The failure that made 49 of 50 slash rounds meaningless: under a ManualClock a
  // lone ESC waits for a timer nothing fires, so the next `/` arrives as Alt+/.
  const harness = await mountHarness(createFixture("S"))
  const keymapErrors = watchKeymapErrors({ quiet: true })
  try {
    await harness.reset()
    harness.app.mockInput.pressKey("/")
    await harness.app.renderOnce()
    harness.app.mockInput.pressKey("ESCAPE")
    await harness.app.renderOnce()
    harness.app.mockInput.pressKey("/")
    await harness.app.renderOnce()
  } finally {
    keymapErrors.restore()
    await harness.dispose()
  }

  expect(keymapErrors.hits.length).toBeGreaterThan(0)
})
