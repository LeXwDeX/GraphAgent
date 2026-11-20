// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Layout tokens (#1670, spec #1669): the horizontal cells the screen's regions keep clear, the indents inside the
 * transcript, the narrow breakpoint and the drawer width. The top bar, the status band, the transcript, the input and
 * the footer read them from here instead of each carrying a number of its own, so one change moves them all.
 *
 * A pure module: it imports nothing from the TUI, so any layer may use it. Nothing here is clamped; a caller that needs
 * a floor (`Math.max(1, …)`) takes its own.
 */

/** Cells every region keeps clear at each side of the screen. */
export const GUTTER = 2

/** The width between the two gutters, for a region that spans `width` cells. */
export function contentWidth(width: number) {
  return width - 2 * GUTTER
}

/** Cells a framed box takes at one side before its content: the border (1) and the box's own padding (1). */
export const FRAME_INSET = 2

/** The width inside a framed box that spans `width` cells, after the inset at both sides. */
export function framedInnerWidth(width: number) {
  return width - 2 * FRAME_INSET
}

/** Cells the text of the assistant and a thought are indented by, which the marks in front of them start at. */
export const ROW_INDENT = 3

/**
 * Cells the mark in front of a line of the transcript takes: the `›` of a user message, the `⏺` of the assistant's
 * text and the `∴` of a thought, and the gap to the words. What wraps under a mark is indented by the same cells.
 */
export const MARK_CELLS = 2

/**
 * Terminal width, in columns, below which the narrow layout applies: the top bar drops the model and the context, the
 * status band merges into one row, and a panel drops its command and secondary tab text. The diff route splits a patch
 * only when its pane is at least this wide.
 */
export const NARROW_WIDTH = 100

/** Fixed width of the drawer overlay in terminal cells. */
export const DRAWER_WIDTH = 40
