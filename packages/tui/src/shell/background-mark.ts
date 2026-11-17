// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The background runs on the status band (#1058 4): the mark `◇ 后台 3·排1` at the tail of the band's first quiet row,
 * and the row of their own that the band draws when it has nothing else to say. Pure layout like `pr-line.tsx`: it
 * draws what the data layer holds (`session/background.ts` decides what each run is doing) and keeps no state, reads
 * no clock and makes no request. The band shows no elapsed time for that reason: a time that moves needs a clock, and
 * the band subscribes to none. The drawer has the times.
 *
 * Only runs that are still going count: running or queued, started by the root session itself, in the background.
 * Finished, unknown and foreground runs do not, and neither do watched PRs, workflows or hooks: each of those has
 * its own place on the band or the footer.
 *
 * Colors are theme tokens and never the brand color. Every width goes through `cellWidth` / `truncateCells`, so a row
 * never claims more cells than it has at either `ambiguous_width`.
 */

import type { Session } from "@graphagent/sdk"
import { t } from "../i18n"
import type { BackgroundItem, BackgroundItems } from "../session/background"
import { subagentDescription, subagentKind } from "../session/subagents"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { remoteLine } from "../util/remote-text"
// Types only: `status-band` imports this module for its values.
import type { BandRow, BandSpan } from "./status-band"

/** Largest number the band writes: a count above it reads as it. */
export const BACKGROUND_COUNT_MAX = 99

/** Cells the mark may take, and the most it takes when `◇` and `·` (Ambiguous) are two cells each. */
const MARK_CELLS = 12
const MARK_CELLS_WIDE = 14

/** Runs the band's own row names; the rest are counted in `+k`. */
export const BAND_RUNS_LISTED = 2

/** Cells the agent type keeps in the row of their own. */
const KIND_MAX_CELLS = 12
/** Cells a description keeps before the row lets go of a run (shortened descriptions go first). */
const DESCRIPTION_FLOOR_CELLS = 6

const EMPTY_ROW: BandRow = { spans: [], cells: 0 }

const SEPARATOR = " · "
const AGENTS_HINT = "/agents"
/** Spaces kept between what a row says on the left and what it says on the right, as in `status-band`. */
const MIN_GAP = 2

function cellsFrom(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0
}

function cellsOf(spans: readonly BandSpan[], aw: AmbiguousWidth): number {
  return spans.reduce((sum, span) => sum + cellWidth(span.text, aw), 0)
}

function blank(cells: number): BandSpan {
  return { text: " ".repeat(Math.max(0, cells)), token: "textMuted" }
}

function rowOf(spans: readonly BandSpan[], aw: AmbiguousWidth): BandRow {
  return { spans, cells: cellsOf(spans, aw) }
}

function capped(count: number): number {
  return Number.isFinite(count) ? Math.min(BACKGROUND_COUNT_MAX, Math.max(0, Math.floor(count))) : 0
}

// ── What the band knows of the runs ──────────────────────────────────────────

/** Runs that are still going: the running ones first, then those waiting for a slot; each group newest start first. */
export function activeRuns(items: Pick<BackgroundItems, "running" | "queued">): BackgroundItem[] {
  return [...items.running, ...items.queued]
}

/** How a run is named in a list: its agent type and what it was asked to do. */
export interface BackgroundLabel {
  readonly kind: string
  readonly description: string
}

/**
 * The name of a run, as `/agents` names the same child: the child session's own agent and the Task description when
 * the session is known, the Task link's own fields before it is. Cleaned of anything that is not text: the model
 * wrote the description.
 */
export function backgroundLabel(
  item: Pick<BackgroundItem, "entry">,
  session?: Pick<Session, "title" | "agent">,
): BackgroundLabel {
  if (session) {
    return { kind: subagentKind(session, item.entry), description: subagentDescription(session, item.entry) }
  }
  return { kind: remoteLine(item.entry.kind ?? "") || "agent", description: remoteLine(item.entry.description ?? "") }
}

/** What the band needs of the root session's runs. */
export interface BackgroundBand {
  /** Running plus queued. */
  readonly total: number
  /** Of them, the ones waiting for a slot. */
  readonly queued: number
  /** The first runs by name: as many as the band's own row lists. */
  readonly labels: readonly BackgroundLabel[]
}

/** The band's view of the runs; undefined while none is going, which takes the mark and the row away. */
export function backgroundBand(
  items: Pick<BackgroundItems, "running" | "queued">,
  sessionOf: (sessionID: string) => Pick<Session, "title" | "agent"> | undefined,
): BackgroundBand | undefined {
  const active = activeRuns(items)
  if (active.length === 0) return undefined
  return {
    total: active.length,
    queued: items.queued.length,
    labels: active.slice(0, BAND_RUNS_LISTED).map((item) => backgroundLabel(item, sessionOf(item.sessionID))),
  }
}

/** Whether two views say the same; the band keeps its rows still while a run only reports progress. */
export function sameBackgroundBand(a: BackgroundBand | undefined, b: BackgroundBand | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.total === b.total &&
    a.queued === b.queued &&
    a.labels.length === b.labels.length &&
    a.labels.every(
      (label, index) => label.kind === b.labels[index].kind && label.description === b.labels[index].description,
    )
  )
}

// ── The mark ─────────────────────────────────────────────────────────────────

/** Cells the mark may take: 12, or 14 at `ambiguous_width` 2 where `◇` and `·` are two cells each. */
export function backgroundMarkBudget(aw: AmbiguousWidth): number {
  return aw === 2 ? MARK_CELLS_WIDE : MARK_CELLS
}

/**
 * The mark: `◇ 后台 3`, with queued runs `◇ 后台 3·排1`, each number at 99 at most. Empty while no run is going. The
 * queued form is written only while it stays inside the budget (`backgroundMarkBudget`): the plain mark is the
 * fallback, so the mark never grows past what the band has set aside for it, whatever the counts.
 */
export function backgroundMark(
  band: Pick<BackgroundBand, "total" | "queued">,
  ambiguousWidth: AmbiguousWidth = 1,
): string {
  const n = capped(band.total)
  if (n === 0) return ""
  const plain = t("background.band.mark", { n })
  const k = Math.min(n, capped(band.queued))
  if (k === 0) return plain
  const queued = t("background.band.markQueued", { n, k })
  return cellWidth(queued, ambiguousWidth) <= backgroundMarkBudget(ambiguousWidth) ? queued : plain
}

/** The mark as a piece of a row: a click on it opens `/agents`. */
export function backgroundMarkSpan(mark: string): BandSpan {
  return { text: mark, token: "textMuted", action: "agents" }
}

/**
 * `row` with the mark flush right when the row has room for it beside what it says, at least two cells away; the
 * row as it is when it has not: the mark is the first thing a row gives up.
 */
export function withBackgroundMark(
  row: BandRow,
  mark: string | undefined,
  width: number,
  ambiguousWidth: AmbiguousWidth = 1,
): BandRow {
  const room = cellsFrom(width)
  if (!mark || row.spans.length === 0) return row
  const markCells = cellWidth(mark, ambiguousWidth)
  if (row.cells + MIN_GAP + markCells > room) return row
  return { spans: [...row.spans, blank(room - row.cells - markCells), backgroundMarkSpan(mark)], cells: room }
}

// ── The row of their own ─────────────────────────────────────────────────────

interface Named {
  readonly kind: string
  readonly description: string
}

/**
 * The runs written as `kind description`, in `room` cells at most; undefined when even the shortest form does not fit.
 * The descriptions give way first, the longest of them first, down to the floor; the agent types are kept whole.
 */
function fitRuns(runs: readonly Named[], room: number, aw: AmbiguousWidth): string[] | undefined {
  if (room < 0) return undefined
  const slots = runs.map((run) => {
    const lead = run.description === "" ? run.kind : `${run.kind} `
    const natural = cellWidth(run.description, aw)
    const min = Math.min(natural, DESCRIPTION_FLOOR_CELLS)
    return { run, base: cellWidth(lead, aw), natural, cells: min }
  })
  let spare = room - slots.reduce((sum, slot) => sum + slot.base + slot.cells, 0)
  if (spare < 0) return undefined
  // Grow the shortened descriptions toward their full length, an equal share each pass.
  for (;;) {
    const open = slots.filter((slot) => slot.cells < slot.natural)
    if (open.length === 0 || spare <= 0) break
    const share = Math.max(1, Math.floor(spare / open.length))
    for (const slot of open) {
      const add = Math.min(share, slot.natural - slot.cells, spare)
      slot.cells += add
      spare -= add
    }
  }
  return slots.map(({ run, natural, cells }) =>
    run.description === ""
      ? run.kind
      : `${run.kind} ${natural <= cells ? run.description : truncateCells(run.description, cells, aw)}`,
  )
}

/** What the row keeps, richest first: both runs, one run, none; the hint goes last. */
function levelsFor(listed: number): ReadonlyArray<{ readonly count: number; readonly hint: boolean }> {
  const levels: Array<{ count: number; hint: boolean }> = []
  for (let count = listed; count >= 0; count--) levels.push({ count, hint: true })
  levels.push({ count: 0, hint: false })
  return levels
}

/**
 * The row of the runs alone: `◇ 后台 3 · review 未提交改动 · explore 扫描依赖 · +1` with `/agents` at the right
 * edge. It stands for the band only while nothing else has a row (the band decides), so it has the room of a whole
 * line. Fitted to `width`: the descriptions are shortened first, then the second run goes into `+k`, then the first,
 * then the hint. No time is shown, see the head of this file.
 */
export function layoutBackgroundRow(input: {
  readonly band: BackgroundBand
  readonly width: number
  readonly ambiguousWidth?: AmbiguousWidth
}): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = cellsFrom(input.width)
  const { band } = input
  const n = capped(band.total)
  if (width === 0 || n === 0) return EMPTY_ROW

  const lead: BandSpan = { text: "◇ ", token: "textMuted" }
  const label: BandSpan = { text: t("background.band.row", { n }), token: "textMuted" }
  const head = [lead, label]
  // Not even the count fits beside the lead: the head of the row, cut.
  if (cellsOf(head, aw) > width) {
    return rowOf([{ text: truncateCells(`${lead.text}${label.text}`, width, aw), token: "textMuted" }], aw)
  }

  const named = band.labels.map((item) => ({
    kind: truncateCells(item.kind, KIND_MAX_CELLS, aw),
    description: item.description,
  }))
  const hint: BandSpan = { text: AGENTS_HINT, token: "textDim" }
  const separator: BandSpan = { text: SEPARATOR, token: "textDim" }

  for (const level of levelsFor(Math.min(named.length, BAND_RUNS_LISTED))) {
    const picked = named.slice(0, level.count)
    // What the listed runs leave out; only said next to a run, where `n` alone already counts them all.
    const more = picked.length > 0 ? Math.max(0, band.total - picked.length) : 0
    const moreSpan: BandSpan = { text: `+${capped(more)}`, token: "textMuted" }
    const separators = picked.length + (more > 0 ? 1 : 0)
    const fixed =
      cellsOf(head, aw) +
      separators * cellWidth(SEPARATOR, aw) +
      (more > 0 ? cellsOf([moreSpan], aw) : 0) +
      (level.hint ? MIN_GAP + cellsOf([hint], aw) : 0)
    const texts = fitRuns(picked, width - fixed, aw)
    if (texts === undefined) continue

    const left: BandSpan[] = [...head]
    for (const text of texts) left.push(separator, { text, token: "text" })
    if (more > 0) left.push(separator, moreSpan)
    if (!level.hint) return rowOf(left, aw)
    const gap = blank(width - cellsOf(left, aw) - cellsOf([hint], aw))
    return rowOf([...left, gap, hint], aw)
  }
  // The last level is the count alone, which fits.
  return rowOf(head, aw)
}
