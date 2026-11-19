// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The project-trust row of the status band (#1618): project commands that were added or changed since the last
 * decision are paused until a new one is made, and the row says how many. Pure layout like `pr-line.tsx`: it draws
 * the count it is handed and keeps no state, reads no clock and makes no request.
 *
 * It is a warning row and the first the band draws, so it never carries the background mark. Colors are theme tokens
 * and never the brand color. Every width goes through `cellWidth` / `truncateCells`, so the row never claims more
 * cells than it has at either `ambiguous_width`.
 */

import type { ProjectTrustEntry } from "@graphagent/sdk"
import { t } from "../i18n"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
// Types only: `status-band` imports this module for its values.
import type { BandRow, BandSpan } from "./status-band"

const EMPTY_ROW: BandRow = { spans: [], cells: 0 }

/** The warning mark; it is the one piece of the row that is never given up. */
const MARK = "⚠"
/** The command a click runs, written out at the right edge; a command name is not translated. */
const HINT = "/trust"
/** Spaces kept between what the row says and the hint at the right edge. */
const MIN_GAP = 2

/** A whole, positive cell count from a width the caller measured; anything else is none. */
function cellsFrom(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0
}

function blank(cells: number): BandSpan {
  return { text: " ".repeat(Math.max(0, cells)), token: "textMuted" }
}

function rowOf(spans: readonly BandSpan[], ambiguousWidth: AmbiguousWidth): BandRow {
  return { spans, cells: spans.reduce((sum, span) => sum + cellWidth(span.text, ambiguousWidth), 0) }
}

/**
 * How many project commands wait for a new decision: the pending ones that are new or were changed since the last
 * one. A pending entry that has no change, as on the first visit to a project, is not counted: the footer reminder
 * and the panel that opens before the first session cover it, and the row is for what changed under a decision.
 */
export function trustChangeCount(entries: readonly Pick<ProjectTrustEntry, "state" | "change">[]): number {
  // The store types the list, but an answer of another shape leaves something else in its place (a body that is an
  // array has a function at `.entries`). That has to cost the band its trust row and nothing else: an error thrown
  // while a row is laid out stalls the updates of every row after it, as for a body that is not a goal (`isGoalShown`).
  if (!Array.isArray(entries)) return 0
  return entries.reduce((sum, entry) => (entry.state === "pending" && entry.change !== undefined ? sum + 1 : sum), 0)
}

/**
 * The trust row for `count` commands as a row of `width` cells at most: `⚠ 项目命令有 2 处变化，未确认前暂停执行` on
 * the left and the hint `/trust` at the right edge. It is empty for no count. A narrow row gives up the hint first and
 * then the end of the sentence; the mark stays, and a row too narrow even for the mark is empty.
 */
export function layoutTrustRow(count: number, width: number, ambiguousWidth: AmbiguousWidth = 1): BandRow {
  const room = cellsFrom(width)
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (room === 0 || n === 0) return EMPTY_ROW
  const aw = ambiguousWidth
  const mark: BandSpan = { text: MARK, token: "warning" }
  if (cellWidth(MARK, aw) > room) return EMPTY_ROW

  // The sentence splits on the count in English; the Chinese one is the same for both.
  const text = t(n === 1 ? "trust.band.changed.one" : "trust.band.changed.many", { n })
  const lead: BandSpan = { text: `${MARK} `, token: "warning" }
  const leadCells = cellWidth(lead.text, aw)
  const textCells = cellWidth(text, aw)
  const hint: BandSpan = { text: HINT, token: "textDim" }
  const hintCells = cellWidth(HINT, aw)

  if (leadCells + textCells + MIN_GAP + hintCells <= room) {
    return rowOf([lead, { text, token: "warning" }, blank(room - leadCells - textCells - hintCells), hint], aw)
  }
  // No room for the hint: the sentence as it is, or cut at the end of what the mark leaves.
  const cut = truncateCells(text, room - leadCells, aw)
  return rowOf(cut === "" ? [mark] : [lead, { text: cut, token: "warning" }], aw)
}
