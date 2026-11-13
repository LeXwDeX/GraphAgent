// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compareReports, type PerfReport } from "./compare"
import { createFixture, type FixtureSize } from "./fixtures"
import { mountHarness } from "./harness"
import { watchKeymapErrors } from "./keymap-errors"
import {
  runCharacterProfile,
  runScenarios,
  runSlashProfile,
  runStream,
  scaleResult,
  type ScenarioResult,
} from "./scenarios"

const sizes: FixtureSize[] = ["S", "M", "L", "XL"]
/** The machine calibration is the mount of the three sessions that scale with nothing: `XL` would make it a measure of transcript size. */
const CALIBRATION_SIZES = new Set<FixtureSize>(["S", "M", "L"])

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

/**
 * `--profile=stream` runs P12 and P13 alone, `--repeats` times, and reports their medians. `--size` picks the
 * session and `--parts-per-message=N` rescales its transcript: on `XL`, 20 is about 1900 rows (fully mounted)
 * and 40 about 3700 (windowed). `--rounds=N` is the number of streamed frames.
 */
async function streamProfile() {
  const size = arg("--size")
  const perMessage = arg("--parts-per-message")
  const frames = arg("--rounds") === undefined ? undefined : Number(arg("--rounds"))
  const repeats = Number(arg("--repeats") ?? 5)
  const fixtureSize = size === "S" || size === "M" || size === "XL" ? size : "L"
  const options = perMessage === undefined ? {} : { partsPerMessage: Number(perMessage) }
  const samples: Record<string, ScenarioResult[]> = {}
  let rows = 0
  for (let repeat = 0; repeat < repeats; repeat++) {
    const fixture = createFixture(fixtureSize, false, options)
    rows = fixture.rows
    const harness = await mountHarness(fixture)
    try {
      for (const item of await runStream(harness, frames)) (samples[item.id] ??= []).push(item)
    } finally {
      await harness.dispose()
    }
  }
  const result = Object.values(samples).map(medianResult)
  console.log(
    JSON.stringify(
      { profile: "stream", commit: gitCommit(), opentui: await opentuiVersion(), rows, repeats, result },
      null,
      2,
    ),
  )
}

async function profile(kind: string) {
  if (kind === "stream") return streamProfile()
  const size = arg("--size")
  const fixture = createFixture(size === "S" || size === "M" || size === "XL" ? size : "L")
  const rounds = Number(arg("--rounds") ?? 1)
  const harness = await mountHarness(fixture)
  try {
    const result =
      kind === "slash" ? await runSlashProfile(harness, rounds) : await runCharacterProfile(harness, rounds)
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
    XL: {},
  }
  const layoutSamples: number[] = []
  const loop = calibrateLoop()

  // The keymap reports a key it cannot resolve on stderr and carries on, so a
  // run can finish with exit code 0 on numbers taken from swallowed keys.
  const keymapErrors = watchKeymapErrors()
  try {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const size of sizes) {
        const started = performance.now()
        const harness = await mountHarness(createFixture(size, size === "M"))
        if (CALIBRATION_SIZES.has(size)) layoutSamples.push(performance.now() - started)
        try {
          const scope = size === "XL" ? "windowed" : "all"
          for (const item of await runScenarios(harness, scope)) (samples[size][item.id] ??= []).push(item)
        } finally {
          await harness.dispose()
        }
      }
    }
  } finally {
    keymapErrors.restore()
  }
  if (keymapErrors.hits.length > 0) {
    console.error(`bench invalid: the keymap reported ${keymapErrors.hits.length} error(s) while the scenarios ran`)
    for (const hit of keymapErrors.hits) console.error(`  ${hit}`)
    process.exit(1)
  }

  const scenarios: Record<FixtureSize, Record<string, ScenarioResult>> = { S: {}, M: {}, L: {}, XL: {} }
  for (const size of sizes) {
    for (const [id, values] of Object.entries(samples[size])) scenarios[size][id] = medianResult(values)
  }

  const sP95 = Number(scenarios.S.P1?.p95Ms ?? 0)
  for (const size of sizes) scenarios[size].P2 = scaleResult(size, Number(scenarios[size].P1?.p95Ms ?? 0), sP95)

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
  const { rows, failures, missing, pending } = compareReports(before, report)
  const name = path.basename(baselineFile(baselineRef))
  if (pending.length > 0) {
    console.log(
      `bench gate: baseline-relative timing check skipped for ${pending.join(", ")} (pending baseline regeneration)`,
    )
  }
  if (failures.length === 0 && missing.length === 0) {
    console.log(`bench gate passed: ${rows.length} metric(s) compared against ${name}`)
    return
  }
  if (failures.length > 0) console.error(`bench gate failed: ${failures.length} regression(s) against ${name}`)
  for (const failure of failures) {
    const row = rows.find(
      (item) => item.size === failure.size && item.id === failure.id && item.metric === failure.metric,
    )
    const measured = row ? `baseline=${row.baseline} current=${row.current} ratio=${row.ratio}` : `value=${failure.value}`
    console.error(`  ${failure.size} ${failure.id} ${failure.metric}: ${measured} limit ${failure.limit}`)
  }
  if (missing.length > 0) {
    console.error(
      `bench gate failed: ${missing.length} gate metric(s) missing from the report (a scenario stopped emitting them)`,
    )
    for (const item of missing) console.error(`  ${item.size} ${item.id} ${item.metric}`)
  }
  process.exit(1)
}

await main()
