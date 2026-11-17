// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The PR and reminder rows of the status band, and the rule that picks which rows it draws (#1036 F6). Pure layout
 * like `layoutDagRow`: it draws what the PR tracker hands it and keeps no state, reads no clock and makes no
 * request. The band never works out a PR's state or a time itself; the tracker owns both.
 *
 * Colors are theme tokens and never the brand color. Every width goes through `cellWidth` / `truncateCells`, so a
 * row never claims more cells than it has at either `ambiguous_width`.
 */

import { t } from "../i18n"
import { formatReminderIn } from "../pr/reminder"
import { prCompact, prMark, prTailMark, type PrCompactItem } from "../pr/state"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { remoteLine } from "../util/remote-text"
import { withBackgroundMark } from "./background-mark"
import type { PrBandItem, ReminderBandItem } from "./pr-tracker-context"
// Types only: `status-band` imports this module for its values.
import type { BandRow, BandSpan, BandToken } from "./status-band"

/** Most rows the band draws; a narrow terminal draws one. */
export const BAND_ROWS_MAX = 2

const EMPTY_ROW: BandRow = { spans: [], cells: 0 }

const SEPARATOR = " · "
/** Between `PR #1035` and what it says, as between the goal row's title and its text. */
const LEAD_GAP = "  "

/** A whole, positive cell count from a width the caller measured; anything else is none. */
function cellsFrom(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0
}

function cellsOf(spans: readonly BandSpan[], ambiguousWidth: AmbiguousWidth): number {
  return spans.reduce((sum, span) => sum + cellWidth(span.text, ambiguousWidth), 0)
}

function rowOf(spans: readonly BandSpan[], ambiguousWidth: AmbiguousWidth): BandRow {
  return { spans, cells: cellsOf(spans, ambiguousWidth) }
}

/** The PRs that take part: the tracker lists none whose state is hidden, and one that slips through is not drawn. */
function drawn(items: readonly PrBandItem[]): PrBandItem[] {
  return items.filter((item) => !item.state.hidden)
}

// ── The PR row ───────────────────────────────────────────────────────────────

/**
 * Whether one of the PRs holds a sticky warning. It then has a row of its own, ahead of the workflow row, and the
 * quiet mark at the workflow row's tail is left out.
 */
export function prHasWarning(items: readonly PrBandItem[]): boolean {
  return drawn(items).some((item) => item.state.sticky)
}

/** One PR: `PR #1035  ✓ passed · agent working`, the outcome and the sentence each in their own color. */
function singleRow(item: PrBandItem, room: number, aw: AmbiguousWidth): BandRow {
  const { state } = item
  const warning = state.tone === "warning"
  const labelSpan: BandSpan = { text: `${t("pr.label")} `, token: warning ? "warning" : "textMuted" }
  const numberSpan: BandSpan = { text: t("pr.number", { number: item.number }), token: warning ? "warning" : "text" }
  const lead = [labelSpan, numberSpan]
  const leadCells = cellsOf(lead, aw)
  // Not even the number fits: the head of the row, cut.
  if (leadCells > room) {
    return rowOf([{ text: truncateCells(`${labelSpan.text}${numberSpan.text}`, room, aw), token: labelSpan.token }], aw)
  }

  const said: Array<{ readonly text: string; readonly token: BandToken }> = []
  if (state.prefix) said.push(state.prefix)
  if (state.status) said.push(state.status)

  const spans: BandSpan[] = [...lead]
  let left = room - leadCells
  for (const [index, piece] of said.entries()) {
    const glue: BandSpan = index === 0 ? { text: LEAD_GAP, token: "textMuted" } : { text: SEPARATOR, token: "textDim" }
    const glueCells = cellWidth(glue.text, aw)
    const text = truncateCells(piece.text, left - glueCells, aw)
    if (text === "") break
    spans.push(glue, { text, token: piece.token })
    left -= glueCells + cellWidth(text, aw)
    // A cut piece ends the row: whatever came after it would sit behind the ellipsis.
    if (text !== piece.text) break
  }
  return rowOf(spans, aw)
}

/** Several PRs in one run of text: `PR !#1040 ~#1036 ✓#1035 +2`, warning-colored when any of them is a warning. */
function compactRow(items: readonly PrBandItem[], room: number, aw: AmbiguousWidth): BandRow {
  const marked: PrCompactItem[] = items.flatMap((item) => {
    const mark = prMark(item.state)
    return mark === undefined ? [] : [{ mark, number: item.number, sticky: item.state.sticky }]
  })
  // The compact text is ASCII and `✓ ✗`, one cell each, and already fits `room`; the cut is a guard, not a path.
  const text = truncateCells(prCompact(marked, room).text, room, aw)
  if (text === "") return EMPTY_ROW
  return rowOf([{ text, token: marked.some((item) => item.sticky) ? "warning" : "textMuted" }], aw)
}

/**
 * The row for the tracked PRs, `width` cells at most (sticky warnings first, as the tracker lists them). One PR is
 * written out: `PR #1035  ✓ passed · agent working`, while watching `PR #1035  CI 4/6`. Several are compressed to
 * the marks of `prCompact`, and the ones that do not fit are counted in a trailing `+k`. The background mark
 * (`background`, #1058 4) is added flush right when the row has room left for it; it never takes any from the PR.
 */
export function layoutPrRow(
  items: readonly PrBandItem[],
  width: number,
  ambiguousWidth: AmbiguousWidth = 1,
  background?: string,
): BandRow {
  const room = cellsFrom(width)
  const shown = drawn(items)
  if (room === 0 || shown.length === 0) return EMPTY_ROW
  const row = shown.length === 1 ? singleRow(shown[0], room, ambiguousWidth) : compactRow(shown, room, ambiguousWidth)
  return withBackgroundMark(row, background, room, ambiguousWidth)
}

/**
 * The text at the tail of the workflow row, at most 14 cells (`prTailMark`): `PR ~4/6`, `PR ✓`, `PR ~#1036 +1`. The
 * band draws it in `textMuted`. Empty when nothing is tracked, and while a warning has a row of its own.
 */
export function prTailText(items: readonly PrBandItem[]): string {
  return prHasWarning(items) ? "" : prTailMark(items)
}

/**
 * The page a click on the PR row opens: the first PR's (the warning one when there is one), and only when it is a
 * web address. The URL is the server's; a scheme other than http(s) is not handed to the system.
 */
export function prOpenUrl(items: readonly PrBandItem[]): string | undefined {
  const url = drawn(items).at(0)?.url
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}

// ── The reminder row ─────────────────────────────────────────────────────────

/**
 * The nearest reminder as a row of `width` cells at most: `reminder · in 5m · {text}`, or `reminder · due · {text}`
 * in the warning color once it fired. The reminder's own text is at the end, so it is what a narrow row cuts. The
 * background mark (`background`, #1058 4) is added flush right when the row has room left for it.
 */
export function layoutReminderRow(
  item: ReminderBandItem,
  width: number,
  ambiguousWidth: AmbiguousWidth = 1,
  background?: string,
): BandRow {
  const room = cellsFrom(width)
  if (room === 0) return EMPTY_ROW
  // The tracker has cleaned the text; the band does not trust what it draws from a remote source to stay clean.
  const text = remoteLine(item.text)
  const line = (
    item.due
      ? t("reminder.band.due", { text })
      : t("reminder.band.in", { time: item.when ?? formatReminderIn(0), text })
  ).trimEnd()
  const token: BandToken = item.due ? "warning" : "textMuted"
  const row = rowOf([{ text: truncateCells(line, room, ambiguousWidth), token }], ambiguousWidth)
  return withBackgroundMark(row, background, room, ambiguousWidth)
}

// ── Which rows the band draws ────────────────────────────────────────────────

/** What a row of the band is about; the band picks the click by it. `background` is the row of the runs alone. */
export type BandRowKind = "pr" | "dag" | "goal" | "reminder" | "background"

export interface BandChoice {
  readonly kind: BandRowKind
  readonly row: BandRow
}

/** The rows the band could draw; each is absent when there is nothing to say. */
export interface BandCandidates {
  /** The PR row, and whether one of the PRs holds a sticky warning. */
  readonly pr?: { readonly row: BandRow; readonly warning: boolean }
  readonly dag?: BandRow
  /** The workflow row's budget is at its warning or exhausted band: a warning row, which takes no background mark. */
  readonly dagAlert?: boolean
  readonly goal?: BandRow
  readonly reminder?: BandRow
  /**
   * The background runs (#1058 4), when some are going; each part is asked for only when it is drawn. `marked` lays
   * out a row again with the mark at its tail (the row as it was when the mark does not fit it); `own` is the row of
   * the runs alone.
   */
  readonly background?: {
    readonly marked: (kind: Exclude<BandRowKind, "background">) => BandRow | undefined
    readonly own: () => BandRow | undefined
  }
}

/**
 * The rows the band draws, top to bottom (F6 2.2). By priority: a PR warning, the workflow, a quiet PR, the goal,
 * the reminder. A quiet PR has a row of its own only while there is no workflow row: with one, it rides at that
 * row's tail (`DagRowInput.pr`). The band draws two rows at most and one when `narrow`, so the first of that list
 * is what a narrow terminal keeps; the goal that a warning pushes out is left to the drawer, which always shows it.
 * A row with nothing to draw takes no line.
 *
 * The background runs (#1058 4) come after that choice and change none of it: their mark rides at the tail of the
 * first row drawn that is not a warning row (a PR warning, a workflow whose budget is at its warning or exhausted
 * band), and they have a row of their own only when no row is drawn at all. Below the narrow limit they have
 * neither: the drawer lists them.
 */
export function chooseBandRows(candidates: BandCandidates, narrow: boolean): BandChoice[] {
  const chosen: BandChoice[] = []
  const add = (kind: BandRowKind, row: BandRow | undefined) => {
    if (row !== undefined && row.spans.length > 0) chosen.push({ kind, row })
  }
  const { pr, background } = candidates
  if (pr?.warning) add("pr", pr.row)
  add("dag", candidates.dag)
  if (pr && !pr.warning && !chosen.some((choice) => choice.kind === "dag")) add("pr", pr.row)
  add("goal", candidates.goal)
  add("reminder", candidates.reminder)
  const rows = chosen.slice(0, narrow ? 1 : BAND_ROWS_MAX)
  if (narrow || background === undefined) return rows

  const isWarning = (kind: BandRowKind) =>
    (kind === "pr" && pr?.warning === true) || (kind === "dag" && candidates.dagAlert === true)
  const target = rows.findIndex((choice) => !isWarning(choice.kind))
  if (target >= 0) {
    const { kind } = rows[target]
    // The rows chosen above are the four kinds with a layout of their own; the runs' row is added only below.
    const marked = kind === "background" ? undefined : background.marked(kind)
    if (marked !== undefined && marked.spans.length > 0) rows[target] = { kind, row: marked }
  } else if (rows.length === 0) {
    const own = background.own()
    if (own !== undefined && own.spans.length > 0) rows.push({ kind: "background", row: own })
  }
  return rows
}
