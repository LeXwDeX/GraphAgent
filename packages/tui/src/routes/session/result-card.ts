// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { backgroundCardTitle, type BackgroundCard } from "../../session/background-card"
import { SplitBorder } from "../../ui/border"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../../ui/width"

/**
 * How the card of a finished background run is laid out (#1058): the title line, the preview line under it and the
 * hint at the end of that. Pure: the cells come from `cellWidth`, so the lines fit at either `ambiguous_width`, and the
 * words come from `session/background-card.ts`. The card is drawn in `routes/session/index.tsx`.
 */

/** The mark that starts the title line; its color says how the run ended. */
export const RESULT_CARD_MARK = "◇"
/** Columns of padding the card keeps inside its border: two before the text and one after it. */
const RESULT_CARD_PADDING = 3
/** Columns the preview line is indented from the mark: under the text of the title. */
export const RESULT_CARD_INDENT = 2
/** Cells between the end of the preview and the hint, at the least. */
const GAP = 2
/** Cells of the preview that stay when the hint takes room from it; a hint that would leave less is dropped. */
const PREVIEW_MIN = 8
/** Cells of the task title that stay when the title line is cut; the status and time after it stay with them. */
const TITLE_MIN = 4

/**
 * Cells the card keeps around its text: the left border and the padding. The border is a glyph whose width the
 * `ambiguous_width` setting changes, so the room the text has changes with it.
 */
export function resultCardChrome(ambiguousWidth: AmbiguousWidth): number {
  return cellWidth(SplitBorder.customBorderChars.vertical, ambiguousWidth) + RESULT_CARD_PADDING
}

/** Cells the preview line has at the content width `width`, after the indent. */
export function resultPreviewRoom(width: number, ambiguousWidth: AmbiguousWidth): number {
  return Math.max(0, width - resultCardChrome(ambiguousWidth) - RESULT_CARD_INDENT)
}

/**
 * The title line after its mark, fitted to the content width `width`. A line that is too long loses the end of the task
 * title, which is free text, so that the status and the time stay; one that is still too long is cut at its end.
 */
export function resultCardTitle(
  card: Pick<BackgroundCard, "kind" | "title" | "status" | "elapsedMs">,
  width: number,
  ambiguousWidth: AmbiguousWidth,
): string {
  const room = Math.max(0, width - resultCardChrome(ambiguousWidth) - cellWidth(`${RESULT_CARD_MARK} `, ambiguousWidth))
  const whole = backgroundCardTitle(card)
  if (cellWidth(whole, ambiguousWidth) <= room) return whole
  const left = room - cellWidth(backgroundCardTitle(card, ""), ambiguousWidth)
  // With less than `TITLE_MIN` cells left for the title the words around it do not fit either: cut the line itself.
  if (left < TITLE_MIN) return truncateCells(whole, room, ambiguousWidth)
  return backgroundCardTitle(card, truncateCells(card.title, left, ambiguousWidth))
}

/** The preview line: its text, the spaces before the hint, and the hint (empty when it was dropped). */
export interface ResultPreview {
  text: string
  pad: number
  hint: string
}

/**
 * The line under the title: the first line of the result, and on its right the hint of what a key or a click does.
 * A card that folds has more to show than the line, so its line gives way to the hint, down to `PREVIEW_MIN` cells;
 * one that does not fold shows its line whole and keeps the hint only if it fits after it. A hint that finds no room is
 * dropped; the card stays clickable either way.
 */
export function resultCardPreview(input: {
  firstLine: string
  hint: string
  folds: boolean
  width: number
  ambiguousWidth: AmbiguousWidth
}): ResultPreview {
  const { firstLine, hint, folds, ambiguousWidth } = input
  const room = resultPreviewRoom(input.width, ambiguousWidth)
  const alone: ResultPreview = { text: truncateCells(firstLine, room, ambiguousWidth), pad: 0, hint: "" }
  if (!hint) return alone
  const hintCells = cellWidth(hint, ambiguousWidth)
  const lineCells = cellWidth(firstLine, ambiguousWidth)
  const kept = folds ? Math.min(lineCells, PREVIEW_MIN) : lineCells
  if (kept + GAP + hintCells > room) return alone
  const text = folds ? truncateCells(firstLine, room - GAP - hintCells, ambiguousWidth) : firstLine
  return { text, pad: room - cellWidth(text, ambiguousWidth) - hintCells, hint }
}
