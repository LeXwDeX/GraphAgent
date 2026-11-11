// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compareReports, type PerfReport } from "./compare"
import { createFixture, type FixtureSize } from "./fixtures"
import { mountHarness } from "./harness"
import { runCharacterProfile, runScenarios, runSlashProfile, type ScenarioResult } from "./scenarios"

const sizes: FixtureSize[] = ["S", "M", "L"]

function arg(name: string) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** `--baseline=<name>` reads `baseline-<name>.json`; the default is `baseline.json`. */
function baselineFile(name?: string) {
  return path.join(import.meta.dir, name ? `baseline-${name}.json` : "baseline.json")
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = values.toSorted((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]
}

function medianResult(values: ScenarioResult[]): ScenarioResult {
  const first = values[0]
  const keys = new Set(values.flatMap((value) => Object.keys(value)))
  const result: ScenarioResult = { id: first.id, size: first.size }
  for (const key of keys) {
    if (key === "id" || key === "size") continue
    const numbers = values
      .map((value) => value[key])
      .filter((value): value is number => typeof value === "number")
    if (numbers.length > 0) result[key] = Number(median(numbers).toFixed(2))
  }
  return result
}

function gitCommit() {
  try {
    const output = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
    return new TextDecoder().decode(output.stdout).trim()
  } catch {
    return "unknown"
  }
}

async function opentuiVersion() {
  const entry = fileURLToPath(import.meta.resolve("@opentui/core"))
  const packagePath = path.join(path.dirname(entry), "package.json")
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- package metadata
  return ((await Bun.file(packagePath).json()) as { version?: string }).version ?? "unknown"
}

function calibrateLoop() {
  const start = performance.now()
  let value = 0
  for (let index = 0; index < 200_000; index++) value = (value + index) % 997
  return { value, ms: Number((performance.now() - start).toFixed(2)) }
}

async function profile(kind: string) {
  const fixture = createFixture("L")
  const harness = await mountHarness(fixture)
  try {
    const result = kind === "slash" ? await runSlashProfile(harness) : await runCharacterProfile(harness)
    console.log(JSON.stringify({ profile: kind, commit: gitCommit(), opentui: await opentuiVersion(), result }, null, 2))
  } finally {
    await harness.dispose()
  }
}

async function main() {
  const profileName = arg("--profile")
  if (profileName) {
    await profile(profileName)
    return
  }

  // `--update-baseline` (no value) writes baseline.json; `--update-baseline=<name>`
  // writes the historical comparison file baseline-<name>.json.
  const updateBaseline = process.argv.some(
    (value) => value === "--update-baseline" || value.startsWith("--update-baseline="),
  )
  const baselineName = arg("--update-baseline")
  const baselineRef = arg("--baseline")
  const enforce = process.argv.includes("--enforce")
  const out = arg("--out")
  const repeats = Number(arg("--repeats") ?? process.env.PERF_REPEATS ?? 5)
  const samples: Record<FixtureSize, Record<string, ScenarioResult[]>> = {
    S: {},
    M: {},
    L: {},
  }
  const layoutSamples: number[] = []
  const loop = calibrateLoop()

  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const size of sizes) {
      const started = performance.now()
      const harness = await mountHarness(createFixture(size, size === "M"))
      layoutSamples.push(performance.now() - started)
      try {
        for (const item of await runScenarios(harness)) (samples[size][item.id] ??= []).push(item)
      } finally {
        await harness.dispose()
      }
    }
  }

  const scenarios: Record<FixtureSize, Record<string, ScenarioResult>> = { S: {}, M: {}, L: {} }
  for (const size of sizes) {
    for (const [id, values] of Object.entries(samples[size])) scenarios[size][id] = medianResult(values)
  }

  const sP95 = Number(scenarios.S.P1?.p95Ms ?? 0)
  for (const size of sizes) {
    const p95 = Number(scenarios[size].P1?.p95Ms ?? 0)
    scenarios[size].P2 = { id: "P2", size, p95Scale: sP95 === 0 ? 0 : Number((p95 / sP95).toFixed(2)) }
  }

  const report = {
    schemaVersion: 1,
    baseline: baselineName,
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    opentuiVersion: await opentuiVersion(),
    bun: Bun.version,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
    },
    calibration: {
      fixedLoopMs: loop.ms,
      fixedLoopValue: loop.value,
      fixedLayoutMsMedian: Number(median(layoutSamples).toFixed(2)),
    },
    repeats,
    scenarios,
  }

  if (updateBaseline) await Bun.write(baselineFile(baselineName), JSON.stringify(report, null, 2) + "\n")
  if (out) await Bun.write(path.resolve(out), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))

  if (!enforce) return
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
  const before = (await Bun.file(baselineFile(baselineRef)).json()) as PerfReport
  const { rows, failures } = compareReports(before, report)
  if (failures.length === 0) {
    console.log(`bench gate passed: ${rows.length} metric(s) compared against ${path.basename(baselineFile(baselineRef))}`)
    return
  }
  console.error(`bench gate failed: ${failures.length} regression(s) against ${path.basename(baselineFile(baselineRef))}`)
  for (const failure of failures) {
    const row = rows.find(
      (item) => item.size === failure.size && item.id === failure.id && item.metric === failure.metric,
    )
    const measured = row ? `baseline=${row.baseline} current=${row.current} ratio=${row.ratio}` : `value=${failure.value}`
    console.error(`  ${failure.size} ${failure.id} ${failure.metric}: ${measured} limit ${failure.limit}`)
  }
  process.exit(1)
}

await main()
