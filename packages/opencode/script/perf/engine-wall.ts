#!/usr/bin/env bun
/**
 * Wall-clock companion to the count gate (Issue #1009).
 *
 * Counts are deterministic and gate CI; wall time is not. This script runs one
 * perf scenario on a file database (WAL, synchronous=NORMAL, the production
 * baseline) 20 times on the self-hosted Linux CI machine and prints p50/p95 as
 * JSON for PR descriptions.
 *
 * It is intentionally not referenced by `.github/` or `azure-pipelines.yml`:
 * shared CI is too noisy for wall-clock numbers.
 *
 * Usage: bun script/perf/engine-wall.ts [s1|s3] [iterations]
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCENARIOS: Record<string, string> = {
  // Single-session warm turn: the interactive latency shape.
  s1: "test/perf/s1.test.ts",
  // Long compacted history: the cold-start shape the H1/H3 work targets.
  s3: "test/perf/s3.test.ts",
}

const name = process.argv[2] ?? "s3"
const iterations = Number(process.argv[3] ?? process.env.PERF_WALL_ITERATIONS ?? 20)
if (!(name in SCENARIOS)) {
  console.error(`unknown scenario: ${name} (expected one of ${Object.keys(SCENARIOS).join(", ")})`)
  process.exit(2)
}
if (!Number.isInteger(iterations) || iterations < 1) {
  console.error(`invalid iteration count: ${iterations}`)
  process.exit(2)
}

const cwd = join(import.meta.dir, "..", "..")
const durations: number[] = []
for (let index = 0; index < iterations; index += 1) {
  const directory = await mkdtemp(join(tmpdir(), "graphagent-wall-"))
  const database = join(directory, "db.sqlite")
  try {
    const started = performance.now()
    const proc = Bun.spawnSync({
      cmd: ["bun", "test", SCENARIOS[name]!],
      cwd,
      env: { ...process.env, PERF_DB_PATH: database },
      stdout: "pipe",
      stderr: "pipe",
    })
    const elapsed = performance.now() - started
    if (proc.exitCode !== 0) {
      console.error(proc.stdout.toString())
      console.error(proc.stderr.toString())
      console.error(`iteration ${index + 1} failed with exit code ${proc.exitCode}`)
      process.exit(1)
    }
    durations.push(elapsed)
    console.error(`iteration ${index + 1}/${iterations}: ${elapsed.toFixed(0)}ms`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const sorted = [...durations].sort((left, right) => left - right)
const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
console.log(
  JSON.stringify(
    {
      scenario: name,
      database: "file (WAL, synchronous=NORMAL)",
      iterations,
      unit: "ms",
      min: Math.round(sorted[0]!),
      p50: Math.round(percentile(0.5)),
      p95: Math.round(percentile(0.95)),
      max: Math.round(sorted[sorted.length - 1]!),
    },
    null,
    2,
  ),
)
