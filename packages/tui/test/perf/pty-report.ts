// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"

/**
 * The nightly ratio table (#1279): the median of several `pty.ts` runs against the committed PTY baseline, as markdown
 * for the run summary. The baseline is `pty-baseline.json`, not `baseline.json`: that file holds the in-process
 * scenarios and has no entry for a boot measured through a pseudo-terminal.
 */

export type Machine = { platform?: string; arch?: string; cpu?: string; cpuCount?: number }
/** One `pty.ts` report. `elapsedMs` is null when the run never reached the input box. */
export type PtyRun = {
  scenario?: string
  elapsedMs: number | null
  expected?: string
  commit?: string
  bun?: string
  machine?: Machine
  outputTail?: string
}
/**
 * The committed baseline. It has the shape of a `pty.ts` report, so `TUI_PTY_BASELINE` reads the same file;
 * `elapsedMs` is the median of `samples`.
 */
export type PtyBaseline = PtyRun & { schemaVersion: 1; elapsedMs: number; samples: number[]; generatedAt: string }
export type Status = "ok" | "slower" | "failed" | "no baseline" | "other platform"
export type Row = {
  scenario: string
  baselineMs?: number
  currentMs?: number
  ratio?: number
  /** The `elapsedMs` of the runs that reached the input box. */
  samples: number[]
  /** The runs that did not. */
  failed: number
  status: Status
}
export type Summary = { rows: Row[]; warnings: string[]; markdown: string }

export const DEFAULT_SCENARIO = "boot-to-prompt"
/**
 * The nightly warns when the median boot takes more than this many times the baseline. It is a warning, never a gate,
 * and a boot is one process start on a shared runner, so it is looser than the in-process 1.30.
 */
export const WARN_RATIO = 1.5
export const BASELINE_FILE = path.join(import.meta.dir, "pty-baseline.json")
/** What a run writes next to its summary so a maintainer can commit it as the baseline. */
export const CANDIDATE_FILE = "pty-baseline.candidate.json"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** The JSON object in `source`; whatever surrounds it (a script echo, a warning) is ignored. */
function parseObject(source: string) {
  const start = source.indexOf("{")
  const end = source.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  try {
    const value: unknown = JSON.parse(source.slice(start, end + 1))
    return record(value) ? value : undefined
  } catch {
    return undefined
  }
}

function toRun(value: Record<string, unknown>): PtyRun {
  const machine = record(value.machine) ? value.machine : undefined
  return {
    scenario: text(value.scenario),
    elapsedMs: finite(value.elapsedMs) ?? null,
    expected: text(value.expected),
    commit: text(value.commit),
    bun: text(value.bun),
    machine: machine && {
      platform: text(machine.platform),
      arch: text(machine.arch),
      cpu: text(machine.cpu),
      cpuCount: finite(machine.cpuCount),
    },
    outputTail: text(value.outputTail),
  }
}

/**
 * Reads the stdout of `pty.ts`. Output that holds no report counts as a run that failed: the table is still produced,
 * so a crashed run shows up in it instead of ending it.
 */
export function parseRun(source: string): PtyRun {
  const value = parseObject(source)
  return value ? toRun(value) : { elapsedMs: null, outputTail: "the run printed no readable report" }
}

export function parseBaseline(source: string): PtyBaseline {
  const value = parseObject(source)
  const run = value && toRun(value)
  if (!value || !run || run.elapsedMs === null) throw new Error("it has no elapsedMs")
  const listed = Array.isArray(value.samples) ? value.samples.flatMap((item) => finite(item) ?? []) : []
  return {
    ...run,
    schemaVersion: 1,
    elapsedMs: run.elapsedMs,
    samples: listed.length > 0 ? listed : [run.elapsedMs],
    generatedAt: text(value.generatedAt) ?? "unknown",
  }
}

/** The mean of the two middle values for an even count. */
export function median(values: number[]) {
  const ordered = values.toSorted((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

/** Boot time moves with the machine, so a ratio is only a verdict against a baseline from the same platform. */
function comparable(baseline?: Machine, current?: Machine) {
  if (!baseline?.platform || !current?.platform) return true
  return baseline.platform === current.platform && baseline.arch === current.arch
}

function describe(run: PtyRun, runs?: number) {
  const machine = run.machine
  const where = machine?.platform
    ? `${machine.platform} ${machine.arch ?? "?"}, ${machine.cpu ?? "unknown cpu"} (${machine.cpuCount ?? "?"} cores)`
    : "unknown machine"
  const parts = [runs === undefined ? undefined : `median of ${runs} runs`, run.commit?.slice(0, 7), where]
  return [...parts, run.bun ? `bun ${run.bun}` : undefined].filter(Boolean).join(", ")
}

const ms = (value: number | undefined) => (value === undefined ? "n/a" : value.toFixed(0))

function rowFor(scenario: string, group: PtyRun[], baseline: PtyBaseline | undefined, warnRatio: number): Row {
  const samples = group.flatMap((run) => (run.elapsedMs === null ? [] : [run.elapsedMs]))
  const currentMs = samples.length > 0 ? median(samples) : undefined
  const reference = baseline && (baseline.scenario ?? DEFAULT_SCENARIO) === scenario ? baseline : undefined
  const ratio = currentMs !== undefined && reference ? Number((currentMs / reference.elapsedMs).toFixed(2)) : undefined
  const machine = group.find((run) => run.machine)?.machine
  let status: Status = "ok"
  if (currentMs === undefined) status = "failed"
  else if (!reference) status = "no baseline"
  else if (!comparable(reference.machine, machine)) status = "other platform"
  else if (ratio !== undefined && ratio > warnRatio) status = "slower"
  return {
    scenario,
    baselineMs: reference?.elapsedMs,
    currentMs,
    ratio,
    samples,
    failed: group.length - samples.length,
    status,
  }
}

function warningsFor(row: Row) {
  const runs = row.samples.length + row.failed
  const warnings: string[] = []
  if (row.status === "failed") warnings.push(`${row.scenario}: none of ${runs} runs reached the input box`)
  else if (row.failed > 0) warnings.push(`${row.scenario}: ${row.failed} of ${runs} runs did not reach the input box`)
  if (row.status === "slower") {
    warnings.push(
      `${row.scenario}: ${row.ratio?.toFixed(2)}x the baseline (${ms(row.currentMs)} ms against ${ms(row.baselineMs)} ms)`,
    )
  }
  return warnings
}

export function summarize(runs: PtyRun[], baseline?: PtyBaseline, options: { warnRatio?: number } = {}): Summary {
  const warnRatio = options.warnRatio ?? WARN_RATIO
  const groups = new Map<string, PtyRun[]>()
  for (const run of runs) {
    const key = run.scenario ?? DEFAULT_SCENARIO
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const rows = [...groups].map(([scenario, group]) => rowFor(scenario, group, baseline, warnRatio))
  const notes = rows.flatMap((row) =>
    row.samples.length === 0
      ? []
      : [
          `${row.scenario}: median of ${row.samples.length} of ${row.samples.length + row.failed} runs, min ${ms(Math.min(...row.samples))}, max ${ms(Math.max(...row.samples))} ms`,
        ],
  )
  notes.push(`current: ${describe(runs.find((run) => run.machine) ?? runs[0] ?? { elapsedMs: null })}`)
  if (baseline) notes.push(`baseline: ${describe(baseline, baseline.samples.length)}`)
  if (rows.some((row) => row.status === "other platform")) {
    notes.push(
      `the baseline comes from another platform, so the ratio is shown but does not warn; commit \`${CANDIDATE_FILE}\` from this run's artifact as \`test/perf/pty-baseline.json\` to compare like with like`,
    )
  }
  if (rows.some((row) => row.status === "no baseline")) {
    notes.push(
      `\`test/perf/pty-baseline.json\` has no baseline for this scenario; \`${CANDIDATE_FILE}\` in this run's artifact can become it`,
    )
  }
  notes.push(`warns above ${warnRatio.toFixed(2)}x the baseline; this run never blocks a PR`)
  // What the process printed reaches the build log: break `##vso[...]` so it cannot act as a logging command.
  const tail = runs.find((run) => run.elapsedMs === null && run.outputTail)?.outputTail?.replaceAll("##", "# #")

  const markdown = [
    "### TUI PTY nightly",
    "",
    "| scenario | baseline (ms) | current (ms) | ratio | status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map((row) => {
      const ratio = row.ratio === undefined ? "n/a" : `${row.ratio.toFixed(2)}x`
      return `| ${row.scenario} | ${ms(row.baselineMs)} | ${ms(row.currentMs)} | ${ratio} | ${row.status} |`
    }),
    "",
    ...notes.map((note) => `- ${note}`),
    ...(tail ? ["", "What the process printed instead:", "", "```", tail.replaceAll("`", "'").trim(), "```"] : []),
    "",
  ].join("\n")
  return { rows, warnings: rows.flatMap(warningsFor), markdown }
}

/** The baseline the finished runs would make, or nothing when none finished. */
export function toBaseline(runs: PtyRun[], now = new Date()): PtyBaseline | undefined {
  const samples = runs.flatMap((run) => (run.elapsedMs === null ? [] : [run.elapsedMs]))
  const first = runs.find((run) => run.elapsedMs !== null)
  if (!first || samples.length === 0) return undefined
  return {
    schemaVersion: 1,
    scenario: first.scenario ?? DEFAULT_SCENARIO,
    elapsedMs: Number(median(samples).toFixed(2)),
    samples,
    expected: first.expected,
    commit: first.commit,
    generatedAt: now.toISOString(),
    bun: first.bun,
    machine: first.machine,
  }
}

function arg(name: string) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** Exit codes: 0 clean, 2 unusable input, 3 the table was produced and carries warnings. */
async function main() {
  const files = process.argv.slice(2).filter((value) => !value.startsWith("--"))
  if (files.length === 0) {
    console.error(
      "usage: bun test/perf/pty-report.ts <run.json>... [--baseline=<file>] [--summary=<file>] [--write-baseline=<file>] [--warn-ratio=<n>]",
    )
    process.exit(2)
  }
  const warnRatio = Number(arg("--warn-ratio") ?? WARN_RATIO)
  if (!(warnRatio > 1)) {
    console.error(`--warn-ratio must be a number above 1, got ${arg("--warn-ratio")}`)
    process.exit(2)
  }
  const runs = await Promise.all(
    files.map(async (file): Promise<PtyRun> => {
      if (!(await Bun.file(file).exists()))
        return { elapsedMs: null, outputTail: `${path.basename(file)} was not written` }
      return parseRun(await Bun.file(file).text())
    }),
  )
  const baselineFile = path.resolve(arg("--baseline") ?? BASELINE_FILE)
  let baseline: PtyBaseline | undefined
  if (await Bun.file(baselineFile).exists()) {
    try {
      baseline = parseBaseline(await Bun.file(baselineFile).text())
    } catch (error) {
      console.error(`unusable baseline ${baselineFile}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }

  const { markdown, warnings } = summarize(runs, baseline, { warnRatio })
  console.log(markdown)
  const summary = arg("--summary")
  if (summary) await Bun.write(path.resolve(summary), markdown)
  const written = arg("--write-baseline")
  if (written) {
    const next = toBaseline(runs)
    if (next) await Bun.write(path.resolve(written), JSON.stringify(next, null, 2) + "\n")
    else console.log("no baseline written: none of the runs reached the input box")
  }
  for (const warning of warnings) console.error(`warning: ${warning}`)
  if (warnings.length > 0) process.exit(3)
}

if (import.meta.main) await main()
