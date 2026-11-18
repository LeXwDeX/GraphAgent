// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { and, eq, gte, sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@graphagent/core/database/database"
import { SessionStepTable, ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { MessageTable, SessionTable } from "@graphagent/core/session/sql"
import { ID as ProjectID } from "@graphagent/core/project"
import { t } from "@graphagent/tui/i18n"
import type { Project } from "@/project/project"

/** One group of `tool_outcome` rows: the same model, tool, outcome, truncation flag and corrections. */
export interface OutcomeRow {
  providerID: string
  modelID: string
  tool: string
  outcome: string
  truncated: boolean
  corrections: string[]
  count: number
}

export interface OutcomeFilter {
  days?: number
  project?: string
  currentProject?: Project.Info
}

const MS_IN_DAY = 24 * 60 * 60 * 1000
const WIDTH = 56
const NAME_CELLS = 12
const CALLS_CELLS = 6
const PERCENT_CELLS = 5
const MODEL_CELLS = WIDTH - 2

/** The `--days` window start: the same cutoff `aggregateSessionStats` applies to `session.time_updated`. */
function cutoffTime(days: number | undefined): number {
  if (days === undefined) return 0
  if (days === 0) {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now.getTime()
  }
  return Date.now() - days * MS_IN_DAY
}

/** The sessions `--days` and `--project` select, with the rules of `aggregateSessionStats`. */
function sessionConditions(filter: OutcomeFilter) {
  const conditions: SQL[] = []
  const cutoff = cutoffTime(filter.days)
  if (cutoff > 0) conditions.push(gte(SessionTable.time_updated, cutoff))
  if (filter.project !== undefined) {
    if (filter.project === "") {
      if (!filter.currentProject) throw new Error("currentProject required when projectFilter is empty string")
      conditions.push(eq(SessionTable.project_id, filter.currentProject.id))
    } else {
      conditions.push(eq(SessionTable.project_id, ProjectID.make(filter.project)))
    }
  }
  return conditions
}

/** Count the `tool_outcome` rows of the selected sessions by model, tool, outcome, truncation and corrections. */
export const queryOutcomes = Effect.fn("Cli.stats.queryOutcomes")(function* (
  db: Database.Interface["db"],
  filter: OutcomeFilter,
) {
  const rows = yield* db
    .select({
      providerID: ToolOutcomeTable.provider_id,
      modelID: ToolOutcomeTable.model_id,
      tool: ToolOutcomeTable.tool,
      outcome: ToolOutcomeTable.outcome,
      truncated: ToolOutcomeTable.truncated,
      corrections: ToolOutcomeTable.corrections,
      count: sql<number>`count(*)`,
    })
    .from(ToolOutcomeTable)
    .innerJoin(SessionTable, eq(ToolOutcomeTable.session_id, SessionTable.id))
    .where(and(...sessionConditions(filter)))
    .groupBy(
      ToolOutcomeTable.provider_id,
      ToolOutcomeTable.model_id,
      ToolOutcomeTable.tool,
      ToolOutcomeTable.outcome,
      ToolOutcomeTable.truncated,
      ToolOutcomeTable.corrections,
    )
    .all()
    .pipe(Effect.orDie)
  return rows satisfies OutcomeRow[]
})

/** What `session_step` and the failed assistant messages say about one model. */
export interface ModelSteps {
  /** Finished steps that carry metrics. */
  steps: number
  /** Mean request time of those steps, in whole milliseconds. */
  avgRequestMs: number
  retries: number
  /** Tool calls that ended in an error or were aborted. */
  toolErrors: number
  /** Assistant messages that ended in a provider error; an abort is not one. */
  requestFailures: number
}

/**
 * The step statistics of every model with at least one recorded step or failed request, keyed by `provider/model`,
 * over the sessions `--days` and `--project` select. A failed request leaves no step, so the failures come from the
 * assistant messages themselves.
 */
export const queryModelSteps = Effect.fn("Cli.stats.queryModelSteps")(function* (
  db: Database.Interface["db"],
  filter: OutcomeFilter,
) {
  const conditions = sessionConditions(filter)
  const recorded = yield* db
    .select({
      providerID: SessionStepTable.provider_id,
      modelID: SessionStepTable.model_id,
      steps: sql<number>`count(*)`,
      requestMs: sql<number>`sum(${SessionStepTable.request_ms})`,
      retries: sql<number>`sum(${SessionStepTable.retries})`,
      toolErrors: sql<number>`sum(${SessionStepTable.tool_errors})`,
    })
    .from(SessionStepTable)
    .innerJoin(SessionTable, eq(SessionStepTable.session_id, SessionTable.id))
    .where(and(...conditions))
    .groupBy(SessionStepTable.provider_id, SessionStepTable.model_id)
    .all()
    .pipe(Effect.orDie)
  const providerID = sql<string>`json_extract(${MessageTable.data}, '$.providerID')`
  const modelID = sql<string>`json_extract(${MessageTable.data}, '$.modelID')`
  const failed = yield* db
    .select({ providerID, modelID, count: sql<number>`count(*)` })
    .from(MessageTable)
    .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
    .where(
      and(
        ...conditions,
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.error') IS NOT NULL`,
        sql`json_extract(${MessageTable.data}, '$.error.name') IS NOT 'MessageAbortedError'`,
      ),
    )
    .groupBy(providerID, modelID)
    .all()
    .pipe(Effect.orDie)

  const models: Record<string, ModelSteps> = {}
  for (const row of recorded) {
    models[`${row.providerID}/${row.modelID}`] = {
      steps: row.steps,
      avgRequestMs: Math.round(row.requestMs / row.steps),
      retries: row.retries,
      toolErrors: row.toolErrors,
      requestFailures: 0,
    }
  }
  for (const row of failed) {
    const name = `${row.providerID}/${row.modelID}`
    models[name] ??= { steps: 0, avgRequestMs: 0, retries: 0, toolErrors: 0, requestFailures: 0 }
    models[name].requestFailures += row.count
  }
  return models
})

/** The five rows `stats --models` adds to a model's block, after its cost: label and value of each. */
export function modelStepRows(steps: ModelSteps): Array<[label: string, value: string]> {
  return [
    [t("cli.stats.row.steps"), steps.steps.toLocaleString()],
    [t("cli.stats.row.avgRequestMs"), `${steps.avgRequestMs.toLocaleString()} ms`],
    [t("cli.stats.row.retries"), steps.retries.toLocaleString()],
    [t("cli.stats.row.toolFailures"), steps.toolErrors.toLocaleString()],
    [t("cli.stats.row.requestFailures"), steps.requestFailures.toLocaleString()],
  ]
}

interface ToolTally {
  calls: number
  validation: number
  execution: number
  denied: number
  aborted: number
  argsCut: number
  corrected: number
  outputCut: number
}

interface ModelTally {
  name: string
  calls: number
  tools: Map<string, ToolTally>
  corrections: Map<string, number>
}

const emptyTally = (): ToolTally => ({
  calls: 0,
  validation: 0,
  execution: 0,
  denied: 0,
  aborted: 0,
  argsCut: 0,
  corrected: 0,
  outputCut: 0,
})

function tallyRow(tally: ToolTally, row: OutcomeRow) {
  tally.calls += row.count
  if (row.outcome === "validation_error") tally.validation += row.count
  if (row.outcome === "execution_error") tally.execution += row.count
  if (row.outcome === "denied") tally.denied += row.count
  if (row.outcome === "aborted") tally.aborted += row.count
  if (row.outcome === "arguments_truncated") tally.argsCut += row.count
  if (row.corrections.length > 0) tally.corrected += row.count
  if (row.truncated) tally.outputCut += row.count
}

/** Group the rows by `provider/model`, then by tool, and count each correction kind once per call. */
function tallyModels(rows: readonly OutcomeRow[]): ModelTally[] {
  const models = new Map<string, ModelTally>()
  for (const row of rows) {
    const name = `${row.providerID}/${row.modelID}`
    const model = models.get(name) ?? { name, calls: 0, tools: new Map(), corrections: new Map() }
    models.set(name, model)
    model.calls += row.count
    const tool = model.tools.get(row.tool) ?? emptyTally()
    model.tools.set(row.tool, tool)
    tallyRow(tool, row)
    for (const kind of new Set(row.corrections)) {
      model.corrections.set(kind, (model.corrections.get(kind) ?? 0) + row.count)
    }
  }
  return [...models.values()]
}

/** Count descending, then name ascending. */
const byCountThenName = (a: readonly [string, number], b: readonly [string, number]) =>
  b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

/** `-` for none, `<1%` below one percent, otherwise the rounded percentage. */
function percent(count: number, total: number): string {
  if (count <= 0 || total <= 0) return "-"
  const share = (count / total) * 100
  return share < 1 ? "<1%" : `${Math.round(share)}%`
}

/** Cut `text` to at most `cells` display cells, marking the cut with `..`. */
function fit(text: string, cells: number): string {
  if (Bun.stringWidth(text) <= cells) return text
  let kept = ""
  for (const char of text) {
    if (Bun.stringWidth(kept + char) > cells - 2) break
    kept += char
  }
  return `${kept}..`
}

const padEnd = (text: string, cells: number) => text + " ".repeat(Math.max(0, cells - Bun.stringWidth(text)))
const padStart = (text: string, cells: number) => " ".repeat(Math.max(0, cells - Bun.stringWidth(text))) + text

/** One boxed line; `content` is padded to the inner width with display-width aware spaces. */
const boxed = (content: string) => `│${padEnd(content, WIDTH)}│`

function toolHeader(): string {
  const columns = [
    t("cli.stats.col.validation"),
    t("cli.stats.col.execution"),
    t("cli.stats.col.denied"),
    t("cli.stats.col.aborted"),
    t("cli.stats.col.argsCut"),
    t("cli.stats.col.corrected"),
    t("cli.stats.col.outputCut"),
  ]
  return (
    ` ${padEnd(t("cli.stats.col.tool"), NAME_CELLS)}${padStart(t("cli.stats.col.calls"), CALLS_CELLS)}` +
    columns.map((column) => padStart(column, PERCENT_CELLS)).join("")
  )
}

function toolLine(name: string, tally: ToolTally): string {
  const shares = [
    tally.validation,
    tally.execution,
    tally.denied,
    tally.aborted,
    tally.argsCut,
    tally.corrected,
    tally.outputCut,
  ].map((count) => padStart(percent(count, tally.calls), PERCENT_CELLS))
  return ` ${padEnd(fit(name, NAME_CELLS), NAME_CELLS)}${padStart(String(tally.calls), CALLS_CELLS)}${shares.join("")}`
}

function modelBlock(model: ModelTally): string[] {
  const lines = [boxed(` ${padEnd(fit(model.name, MODEL_CELLS), MODEL_CELLS)}`), boxed(toolHeader())]
  const tools = [...model.tools.entries()].sort(([a, x], [b, y]) => byCountThenName([a, x.calls], [b, y.calls]))
  for (const [name, tally] of tools) lines.push(boxed(toolLine(name, tally)))
  if (model.corrections.size > 0) {
    lines.push(boxed(` ${t("cli.stats.row.corrections")}`))
    for (const [kind, count] of [...model.corrections.entries()].sort(byCountThenName)) {
      const value = `${count} ${padStart(percent(count, model.calls), PERCENT_CELLS)}`
      const labelCells = WIDTH - 5 - Bun.stringWidth(value)
      lines.push(boxed(`   ${padEnd(fit(kind, labelCells), labelCells)} ${value} `))
    }
  }
  return lines
}

/**
 * The lines `stats --outcomes` prints: one block per model, the most called
 * first, at most `limit` blocks. No rows, no lines.
 */
export function renderOutcomes(rows: readonly OutcomeRow[], limit: number): string[] {
  const models = tallyModels(rows)
    .sort((a, b) => byCountThenName([a.name, a.calls], [b.name, b.calls]))
    .slice(0, limit)
  if (models.length === 0) return []
  const border = "─".repeat(WIDTH)
  const title = t("cli.stats.title.outcomes")
  const free = Math.max(0, WIDTH - Bun.stringWidth(title))
  const left = Math.floor(free / 2)
  const lines = [`┌${border}┐`, `│${" ".repeat(left)}${title}${" ".repeat(free - left)}│`]
  for (const model of models) lines.push(`├${border}┤`, ...modelBlock(model))
  lines.push(`└${border}┘`)
  return lines
}

/** `--outcomes` shows every model, `--outcomes N` the first N, no flag nothing. */
export function outcomeLimit(value: unknown): number | undefined {
  if (value === true) return Infinity
  return typeof value === "number" ? value : undefined
}

export const printOutcomes = Effect.fn("Cli.stats.printOutcomes")(function* (limit: number, filter: OutcomeFilter) {
  const { db } = yield* Database.Service
  const lines = renderOutcomes(yield* queryOutcomes(db, filter), limit)
  if (lines.length === 0) return
  for (const line of lines) console.log(line)
  console.log()
})
