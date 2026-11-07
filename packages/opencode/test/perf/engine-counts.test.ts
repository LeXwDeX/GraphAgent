import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { COUNTER_KEYS, type CounterKey } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { baselineEntry, compareScenario, type Baseline, type ScenarioActual } from "./baseline"
import { s1Scenario } from "./scenarios/s1"
import { s2Scenario } from "./scenarios/s2"
import { s3Scenario } from "./scenarios/s3"
import { s4Scenario } from "./scenarios/s4"
import { s5Scenario } from "./scenarios/s5"
import { s6Scenario } from "./scenarios/s6"
import { s7Scenario } from "./scenarios/s7"
import type { Scenario, ScenarioID } from "./scenarios/types"

// The H0 count gate (Issue #1009). Each scenario runs its warm-up and two
// measured passes exactly like its own `sN.test.ts`; the gate then compares the
// last pass's counters, request count and request shapes against
// `engine-baseline.json`.
//
// Rules (see the "Baseline updates" section in packages/opencode/AGENTS.md):
//   - a metric may not exceed `perTurn + Σdeclared`;
//   - a PR that is designed to change a count adds a `declared` entry in the
//     same PR, with the reason;
//   - after another Issue merges, re-capture in a dedicated baseline-only PR;
//   - volatile keys are recorded but not compared (the scenario test states
//     the tolerance in prose).
//
// Recapture: `PERF_WRITE_BASELINE=1 bun test test/perf/engine-counts.test.ts`.
const BASELINE_PATH = path.join(import.meta.dir, "engine-baseline.json")
const WRITE = process.env.PERF_WRITE_BASELINE === "1"

// Byte totals are volatile across processes: the fixture directory name has a
// random length (`Math.random().toString(36).slice(2)`), and both the parsed
// and published payloads embed that path, so a one-character difference shifts
// every affected payload by one byte. Within one process the two measured
// passes share the directory, so the scenario tests can still bound the
// difference (S1/S2/S7 assert 64 bytes); across processes only the counts,
// steps and request shapes are comparable.
const BYTES: ReadonlyArray<CounterKey> = ["json.parseBytes", "json.encodeBytes", "sha256Bytes"]
// S4's #523 dedup drops the repeated tool-part appends that land in the same
// real millisecond, which moves reads and writes together in three-statement
// units; the scenario test states the bound.
const S4_VOLATILE: ReadonlyArray<CounterKey> = [
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
  "sql.read",
  "sql.write",
]
// 15-way concurrency reorders SQL and lock waits (S5 test states the reason).
const CONCURRENCY: ReadonlyArray<CounterKey> = [
  "sql.read",
  "sql.write",
  "commits",
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
  "snapshot.lockWaits",
]

let cached: Baseline | undefined

async function loadBaseline(): Promise<Baseline> {
  if (cached) return cached
  try {
    cached = (await Bun.file(BASELINE_PATH).json()) as Baseline
  } catch {
    cached = { version: 1, collectedAt: new Date().toISOString(), commit: "", scenarios: {}, declared: [] }
  }
  return cached
}

function headCommit(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir })
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown"
}

async function record(id: ScenarioID, actual: ScenarioActual, volatile: ReadonlyArray<CounterKey>) {
  const current = await loadBaseline()
  cached = {
    ...current,
    collectedAt: new Date().toISOString(),
    commit: headCommit(),
    scenarios: { ...current.scenarios, [id]: baselineEntry(actual, volatile) },
  }
  await Bun.write(BASELINE_PATH, `${JSON.stringify(cached, null, 2)}\n`)
}

/**
 * Assert one scenario result. In recapture mode it writes the baseline entry
 * instead (and still verifies the counter key set, so a renamed counter cannot
 * silently leave a stale entry behind).
 */
async function assertScenario(id: ScenarioID, actual: ScenarioActual, volatile: ReadonlyArray<CounterKey>) {
  expect(Object.keys(actual.counts).sort()).toEqual([...COUNTER_KEYS].sort())
  if (WRITE) {
    await record(id, actual, volatile)
    return
  }
  expect(compareScenario(id, actual, await loadBaseline())).toEqual([])
}

function register<A extends ScenarioActual, R>(
  id: ScenarioID,
  scenario: Scenario<A, R>,
  volatile: ReadonlyArray<CounterKey>,
) {
  const it = testEffect(scenario.layer)
  it.instance(
    `${id} stays within engine-baseline.json`,
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run
        yield* Effect.promise(() => assertScenario(id, result, volatile))
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
}

register("S1", s1Scenario(), BYTES)
register("S2", s2Scenario(), BYTES)
register("S3", s3Scenario(), BYTES)
register("S4", s4Scenario(), S4_VOLATILE)
register("S5", s5Scenario(), CONCURRENCY)
register("S6", s6Scenario(), BYTES)
register("S7", s7Scenario(), BYTES)
