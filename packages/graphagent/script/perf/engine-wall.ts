#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Wall-clock companion to the count gate (Issue #1009).
 *
 * Counts are deterministic and gate CI; wall time is not. This script runs one
 * perf scenario on a file database (WAL, synchronous=NORMAL, the production
 * baseline) 20 times on the self-hosted Linux CI machine and prints p50/p95 as
 * JSON for PR descriptions.
 *
 * With `--latency` it instead records, for the S5 load (Issue #1021), the
 * event-loop delay and the end-to-end time to first token (TTFT) of interactive
 * turns, one fresh process per run, and prints the aggregate together with the
 * machine it ran on. The instruments live in `test/perf/s5-latency.ts`; nothing
 * is gated on the numbers.
 *
 * It is intentionally not referenced by `.github/` or `azure-pipelines.yml`:
 * shared CI is too noisy for wall-clock numbers.
 *
 * Usage: bun script/perf/engine-wall.ts [s1|s3] [iterations]
 *        bun script/perf/engine-wall.ts --latency [s5] [runs]
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { arch, availableParallelism, cpus, loadavg, release, tmpdir, totalmem, type as osType } from "node:os"
import { join } from "node:path"

const SCENARIOS: Record<string, string> = {
  // Single-session warm turn: the interactive latency shape.
  s1: "test/perf/s1.test.ts",
  // Long compacted history: the cold-start shape the H1/H3 work targets.
  s3: "test/perf/s3.test.ts",
}

// Not named `*.test.ts`, so the CI run never discovers it; the explicit `./` path
// is what makes `bun test` run it.
const LATENCY_RUNNER = "./test/perf/s5-latency.probe.ts"

const cwd = join(import.meta.dir, "..", "..")

const sortAscending = (values: ReadonlyArray<number>) => [...values].sort((left, right) => left - right)
const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]

async function wall(name: string, iterations: number) {
  const durations: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const directory = await mkdtemp(join(tmpdir(), "graphagent-wall-"))
    const database = join(directory, "db.sqlite")
    try {
      const started = performance.now()
      const proc = Bun.spawnSync({
        cmd: ["bun", "test", SCENARIOS[name]],
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

  const sorted = sortAscending(durations)
  console.log(
    JSON.stringify(
      {
        scenario: name,
        database: "file (WAL, synchronous=NORMAL)",
        iterations,
        unit: "ms",
        min: Math.round(sorted[0]),
        p50: Math.round(percentile(sorted, 0.5)),
        p95: Math.round(percentile(sorted, 0.95)),
        max: Math.round(sorted[sorted.length - 1]),
      },
      null,
      2,
    ),
  )
}

// What `test/perf/s5-latency.probe.ts` writes (`LatencyReport` in
// `test/perf/s5-latency.ts`), reduced to the fields read here.
interface LatencyPass {
  readonly probed: boolean
  readonly windowMs: number
  readonly eventLoop: { readonly samples: number; readonly p50: number; readonly p99: number; readonly max: number }
  readonly probes: ReadonlyArray<{ readonly due: number; readonly at: number; readonly ttft: number }>
}
interface LatencyReport {
  readonly database: string
  readonly resolutionMs: number
  readonly probePeriodMs: number
  readonly passes: ReadonlyArray<LatencyPass>
}

const round = (value: number, digits: number) => Number(value.toFixed(digits))

function median(values: ReadonlyArray<number>) {
  const sorted = sortAscending(values)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Median and range of one per-window figure across the windows. */
const spread = (values: ReadonlyArray<number>, digits: number) => ({
  median: round(median(values), digits),
  min: round(Math.min(...values), digits),
  max: round(Math.max(...values), digits),
})

/** Distribution of the samples pooled over all runs. */
function distribution(values: ReadonlyArray<number>) {
  const sorted = sortAscending(values)
  return {
    samples: sorted.length,
    min: round(sorted[0], 1),
    p50: round(percentile(sorted, 0.5), 1),
    p95: round(percentile(sorted, 0.95), 1),
    p99: round(percentile(sorted, 0.99), 1),
    max: round(sorted[sorted.length - 1], 1),
  }
}

/** One load window per pass: its p50/p99/max timer lateness, then the spread over windows. */
function eventLoopSummary(passes: ReadonlyArray<LatencyPass>) {
  return {
    windows: passes.length,
    windowMs: round(median(passes.map((pass) => pass.windowMs)), 0),
    ticksPerWindow: round(median(passes.map((pass) => pass.eventLoop.samples)), 0),
    p50: spread(
      passes.map((pass) => pass.eventLoop.p50),
      2,
    ),
    p99: spread(
      passes.map((pass) => pass.eventLoop.p99),
      1,
    ),
    max: spread(
      passes.map((pass) => pass.eventLoop.max),
      1,
    ),
  }
}

async function osName() {
  try {
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(await readFile("/etc/os-release", "utf8"))?.[1]
    if (pretty) return pretty
  } catch {
    // not a Linux distribution: fall back to the kernel name
  }
  return `${osType()} ${release()}`
}

async function latency(runs: number) {
  const loadBefore = loadavg()[0]
  const reports: LatencyReport[] = []
  const wallMs: number[] = []
  for (let index = 0; index < runs; index += 1) {
    const directory = await mkdtemp(join(tmpdir(), "graphagent-latency-"))
    try {
      const output = join(directory, "report.json")
      const started = performance.now()
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", LATENCY_RUNNER],
        cwd,
        env: { ...process.env, PERF_DB_PATH: join(directory, "db.sqlite"), PERF_LATENCY_OUT: output },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (proc.exitCode !== 0) {
        console.error(proc.stdout.toString())
        console.error(proc.stderr.toString())
        console.error(`run ${index + 1} failed with exit code ${proc.exitCode}`)
        process.exit(1)
      }
      const report: LatencyReport = JSON.parse(await readFile(output, "utf8"))
      reports.push(report)
      wallMs.push(performance.now() - started)
      console.error(
        `run ${index + 1}/${runs}: ${wallMs[index].toFixed(0)}ms, ` +
          `event-loop p99 ${report.passes.map((pass) => pass.eventLoop.p99.toFixed(1)).join(" / ")}ms, ` +
          `${report.passes.flatMap((pass) => pass.probes).length} probes`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const passes = reports.flatMap((report) => report.passes)
  const probed = passes.filter((pass) => pass.probed)
  const probes = probed.flatMap((pass) => pass.probes)
  console.log(
    JSON.stringify(
      {
        scenario: "s5",
        mode: "latency",
        database: reports[0].database,
        machine: {
          cpu: cpus()[0]?.model.trim() ?? "unknown",
          logicalCpus: availableParallelism(),
          memoryGiB: Math.round(totalmem() / 2 ** 30),
          os: await osName(),
          kernel: `${osType()} ${release()} ${arch()}`,
          bun: Bun.version,
          loadAverage1m: { before: round(loadBefore, 2), after: round(loadavg()[0], 2) },
        },
        runs,
        unit: "ms",
        // Wall time of one run (process start to exit); a quiet machine repeats it closely, so a
        // spread or a drift between batches points at other work on the machine.
        runWallMs: spread(wallMs, 0),
        // Timer lateness from `monitorEventLoopDelay` over the load window of one pass. `alone`
        // is S5 as the gate runs it; `withProbes` is the pass that also runs the interactive probes.
        eventLoopDelay: {
          resolutionMs: reports[0].resolutionMs,
          alone: eventLoopSummary(passes.filter((pass) => !pass.probed)),
          withProbes: eventLoopSummary(probed),
        },
        // Interactive turns submitted on a fixed schedule while S5 runs. `fromSubmission` starts at
        // the `prompt` call (admission); `fromSchedule` starts when the schedule meant to submit,
        // so it also counts the timer lateness that delayed the submission itself.
        ttft: {
          probePeriodMs: reports[0].probePeriodMs,
          fromSubmission: distribution(probes.map((probe) => probe.ttft)),
          fromSchedule: distribution(probes.map((probe) => probe.at - probe.due + probe.ttft)),
        },
      },
      null,
      2,
    ),
  )
}

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"))
const operands = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const unknownFlags = flags.filter((flag) => flag !== "--latency")
if (unknownFlags.length > 0) {
  console.error(`unknown option: ${unknownFlags.join(", ")} (expected --latency)`)
  process.exit(2)
}

if (flags.includes("--latency")) {
  // S5 is the only scenario with latency instruments; naming it is optional.
  if (operands[0]?.toLowerCase() === "s5") operands.shift()
  const runs = Number(operands[0] ?? process.env.PERF_WALL_ITERATIONS ?? 10)
  if (!Number.isInteger(runs) || runs < 1 || operands.length > 1) {
    console.error(`usage: bun script/perf/engine-wall.ts --latency [s5] [runs] (got: ${operands.join(" ")})`)
    process.exit(2)
  }
  await latency(runs)
} else {
  const name = operands[0] ?? "s3"
  const iterations = Number(operands[1] ?? process.env.PERF_WALL_ITERATIONS ?? 20)
  if (!(name in SCENARIOS)) {
    console.error(`unknown scenario: ${name} (expected one of ${Object.keys(SCENARIOS).join(", ")})`)
    process.exit(2)
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    console.error(`invalid iteration count: ${iterations}`)
    process.exit(2)
  }
  await wall(name, iterations)
}
