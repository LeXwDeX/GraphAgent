// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The result of a live matrix run (Issue #1474): the cell verdicts, the comparison with an earlier run, and the
 * two files written from them. `results.json` is the `Report` itself; `report.md` is made for reading and for a
 * pull request description.
 *
 * A report names models as `provider/model` and carries failure lines, never a credential, an endpoint or a
 * local path: the caller cleans every text before it comes here, and the profile of a model is cut down to the
 * few fields that say what the runtime knows about it.
 */

import { isRecord } from "../delegation-timing/classify"
import { TOOL_OUTCOME_KINDS } from "@graphagent/core/session/outcome"
import type { RunResult } from "./runner"
import { PASS_MIN, RUNS_PER_CELL, STEPS } from "./types"

export type Verdict = "pass" | "fail" | "error"

/** One run, as `results.json` keeps it. */
export interface RunRecord {
  readonly status: Verdict
  readonly failures: readonly string[]
  readonly attempts: number
  readonly durationMs: number
  /** Input, output and reasoning tokens of the run. */
  readonly tokens: number
  readonly calls: number
  /** Calls by their `Call.outcome`. */
  readonly outcomes: Readonly<Record<string, number>>
}

export interface Cell {
  /** `provider/model` */
  readonly model: string
  readonly scenario: string
  readonly runs: readonly RunRecord[]
  readonly verdict: Verdict
}

/** What `GET /provider` says about a model's capabilities. */
export interface Profile {
  readonly context?: number
  readonly output?: number
  readonly missing: readonly string[]
  readonly sources: Readonly<Record<string, string>>
}

export interface Report {
  readonly version: 1
  readonly runsPerCell: number
  readonly passMin: number
  readonly steps: number
  /** By `provider/model`; `null` when the host reported no profile for it. */
  readonly profiles: Readonly<Record<string, Profile | null>>
  readonly cells: readonly Cell[]
  /** Cells that passed in the baseline and did not pass now. */
  readonly regressions: readonly { readonly model: string; readonly scenario: string }[]
}

export function recordOf(result: RunResult): RunRecord {
  const calls = result.view?.calls ?? []
  const outcomes: Record<string, number> = {}
  for (const call of calls) outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1
  return {
    status: result.status,
    failures: result.failures,
    attempts: result.attempts,
    durationMs: result.durationMs,
    tokens: result.tokens,
    calls: calls.length,
    outcomes,
  }
}

/**
 * The verdict of a cell: `pass` when at least `PASS_MIN` runs passed; otherwise `error` when at least `PASS_MIN`
 * runs broke before a verdict; otherwise `fail`.
 */
export function verdictOf(statuses: readonly Verdict[]): Verdict {
  const count = (status: Verdict) => statuses.filter((item) => item === status).length
  if (count("pass") >= PASS_MIN) return "pass"
  if (count("error") >= PASS_MIN) return "error"
  return "fail"
}

export function cellOf(model: string, scenario: string, runs: readonly RunRecord[]): Cell {
  return { model, scenario, runs, verdict: verdictOf(runs.map((run) => run.status)) }
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * The profile of `modelID` of provider `providerID` in a `GET /provider` response, cut to `context`, `output`,
 * `missing` and `sources`. The rest of the response (`options`, `key`, ...) is never read, so it cannot leak into a
 * report. `null` when the response has no such model or the model has no profile.
 */
export function profileFrom(response: unknown, providerID: string, modelID: string): Profile | null {
  if (!isRecord(response) || !Array.isArray(response.all)) return null
  const provider = response.all.find((item) => isRecord(item) && item.id === providerID)
  const model = isRecord(provider) && isRecord(provider.models) ? provider.models[modelID] : undefined
  const profile = isRecord(model) ? model.profile : undefined
  if (!isRecord(profile)) return null
  const sources: Record<string, string> = {}
  if (isRecord(profile.sources)) {
    for (const [field, origin] of Object.entries(profile.sources))
      if (typeof origin === "string") sources[field] = origin
  }
  const context = finite(profile.context)
  const output = finite(profile.output)
  return {
    ...(context === undefined ? {} : { context }),
    ...(output === undefined ? {} : { output }),
    missing: Array.isArray(profile.missing)
      ? profile.missing.filter((item): item is string => typeof item === "string")
      : [],
    sources,
  }
}

const VERDICTS: readonly Verdict[] = ["pass", "fail", "error"]

const cellKey = (model: string, scenario: string) => JSON.stringify([model, scenario])

/** The verdicts of an earlier `results.json`, by cell; `undefined` when the text is not such a file. */
export function parseBaseline(json: unknown): ReadonlyMap<string, Verdict> | undefined {
  if (!isRecord(json) || !Array.isArray(json.cells)) return undefined
  const verdicts = new Map<string, Verdict>()
  for (const cell of json.cells) {
    if (!isRecord(cell) || typeof cell.model !== "string" || typeof cell.scenario !== "string") return undefined
    const verdict = VERDICTS.find((item) => item === cell.verdict)
    if (!verdict) return undefined
    verdicts.set(cellKey(cell.model, cell.scenario), verdict)
  }
  return verdicts
}

/** The cells that passed in the baseline and are `fail` or `error` now: a cell the baseline lacks is no regression. */
export function regressionsOf(
  baseline: ReadonlyMap<string, Verdict> | undefined,
  cells: readonly Cell[],
): Report["regressions"] {
  if (!baseline) return []
  return cells
    .filter((cell) => baseline.get(cellKey(cell.model, cell.scenario)) === "pass" && cell.verdict !== "pass")
    .map((cell) => ({ model: cell.model, scenario: cell.scenario }))
}

export function buildReport(input: {
  readonly profiles: Readonly<Record<string, Profile | null>>
  readonly cells: readonly Cell[]
  readonly baseline?: ReadonlyMap<string, Verdict>
}): Report {
  return {
    version: 1,
    runsPerCell: RUNS_PER_CELL,
    passMin: PASS_MIN,
    steps: STEPS,
    profiles: input.profiles,
    cells: input.cells,
    regressions: regressionsOf(input.baseline, input.cells),
  }
}

export interface ModelStats {
  readonly model: string
  readonly cells: number
  readonly passed: number
  /** Calls by outcome, for every kind `TOOL_OUTCOME_KINDS` lists. */
  readonly outcomes: Readonly<Record<string, number>>
  readonly calls: number
  readonly tokens: number
}

export function statsOf(report: Report, model: string): ModelStats {
  const cells = report.cells.filter((cell) => cell.model === model)
  const outcomes: Record<string, number> = Object.fromEntries(TOOL_OUTCOME_KINDS.map((kind) => [kind, 0]))
  let calls = 0
  let tokens = 0
  for (const cell of cells) {
    for (const run of cell.runs) {
      calls += run.calls
      tokens += run.tokens
      for (const [kind, count] of Object.entries(run.outcomes)) outcomes[kind] = (outcomes[kind] ?? 0) + count
    }
  }
  return {
    model,
    cells: cells.length,
    passed: cells.filter((cell) => cell.verdict === "pass").length,
    outcomes,
    calls,
    tokens,
  }
}

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`)

function profileLine(model: string, profile: Profile | null | undefined): string {
  if (!profile) return `- \`${model}\`: profile unavailable`
  const sources = Object.entries(profile.sources)
    .map(([field, origin]) => `${field}=${origin}`)
    .join(", ")
  return [
    `- \`${model}\`: context ${profile.context ?? "unknown"}`,
    `output ${profile.output ?? "unknown"}`,
    `missing ${profile.missing.length > 0 ? profile.missing.join(", ") : "none"}`,
    `sources ${sources || "none"}`,
  ].join(", ")
}

const unique = (values: readonly string[]) => [...new Set(values)]

/** The Markdown report: profile header, matrix (scenario by model), per-model figures, failures, regressions. */
export function renderMarkdown(report: Report): string {
  const models = unique(report.cells.map((cell) => cell.model))
  const scenarios = unique(report.cells.map((cell) => cell.scenario))
  const cell = (model: string, scenario: string) =>
    report.cells.find((item) => item.model === model && item.scenario === scenario)
  const out: string[] = ["# Model consistency matrix", ""]
  out.push(
    `Runs per cell: ${report.runsPerCell} (a cell passes with at least ${report.passMin} passing runs). Model steps per run: ${report.steps}.`,
    "",
    "## Models",
    "",
    ...models.map((model) => profileLine(model, report.profiles[model])),
    "",
    "## Matrix",
    "",
    `| scenario | ${models.map((model) => `\`${model}\``).join(" | ")} |`,
    `| --- | ${models.map(() => "---").join(" | ")} |`,
  )
  for (const scenario of scenarios) {
    const cols = models.map((model) => {
      const found = cell(model, scenario)
      if (!found) return "-"
      const passed = found.runs.filter((run) => run.status === "pass").length
      return `${found.verdict} ${passed}/${found.runs.length}`
    })
    out.push(`| \`${scenario}\` | ${cols.join(" | ")} |`)
  }
  out.push(
    "",
    "## Per model",
    "",
    `| model | cells passed | ${TOOL_OUTCOME_KINDS.join(" | ")} | invalid-argument rate | tokens |`,
    `| --- | --- | ${TOOL_OUTCOME_KINDS.map(() => "---").join(" | ")} | --- | --- |`,
  )
  for (const model of models) {
    const stats = statsOf(report, model)
    const counts = TOOL_OUTCOME_KINDS.map((kind) => String(stats.outcomes[kind] ?? 0))
    const rate = percent(stats.outcomes.validation_error ?? 0, stats.calls)
    out.push(
      `| \`${model}\` | ${stats.passed}/${stats.cells} (${percent(stats.passed, stats.cells)}) | ${counts.join(" | ")} | ${rate} | ${stats.tokens} |`,
    )
  }
  const failing = report.cells.flatMap((item) =>
    item.runs.flatMap((run, index) => (run.status === "pass" ? [] : [{ item, run, index }])),
  )
  out.push("", "## Failures", "")
  if (failing.length === 0) out.push("None.")
  for (const { item, run, index } of failing) {
    out.push(`- \`${item.model}\` \`${item.scenario}\` run ${index + 1} (${run.status}): ${run.failures.join("; ")}`)
  }
  out.push("", "## Regressions against the baseline", "")
  if (report.regressions.length === 0) out.push("None.")
  for (const item of report.regressions) out.push(`- \`${item.model}\` \`${item.scenario}\``)
  return out.join("\n") + "\n"
}
