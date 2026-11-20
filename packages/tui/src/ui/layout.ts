// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Layout tokens (#1670, spec #1669): the horizontal cells the screen's regions keep clear, the indents inside the
 * transcript, the narrow breakpoint, the width of a panel's text and the drawer's width with its insets. The top bar,
 * the status band, the transcript, the input, the panels and the footer read them from here instead of each carrying a
 * number of its own, so one change moves them all.
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

/** Cells of padding a framed box keeps between its border and its text, at each side. */
export const FRAME_PADDING = 1

/** Cells a framed box takes at one side before its content: the border (1) and the box's own padding. */
export const FRAME_INSET = 1 + FRAME_PADDING

/** The width inside a framed box that spans `width` cells, after the inset at both sides. */
export function framedInnerWidth(width: number) {
  return width - 2 * FRAME_INSET
}

/**
 * The width of the text inside a panel on a terminal `width` cells wide (13.3, 13.7): the panel's frame spans the
 * content area between the gutters, or the whole terminal for a fullscreen panel, and the border and the padding come
 * off both its sides. `PanelShell` lays its own rows out in this width, and every panel that lays out more takes the
 * width from here (`usePanelInnerWidth` in `panel/shell.tsx`), not from the terminal width less a number of its own.
 */
export function panelInnerWidth(width: number, fullscreen = false) {
  return framedInnerWidth(fullscreen ? width : contentWidth(width))
}

/** Cells the text of the assistant and a thought are indented by, which the marks in front of them start at. */
export const ROW_INDENT = 3

/**
 * Cells the mark in front of a line of the transcript takes: the `›` of a user message, the `⏺` of the assistant's
 * text and the `∴` of a thought, and the gap to the words. What wraps under a mark is indented by the same cells. A row
 * of a panel has the same mark column (the `›` of the selected row and the gap), and the note under the rows starts
 * past it.
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

/**
 * Cells the drawer keeps clear at each side of its text. The drawer is an overlay with no border, and its text sits in
 * from the edge by as many cells as the text of a framed panel does.
 */
export const DRAWER_INSET = FRAME_INSET

/** The column a vertical scrollbar may take at the right of a scrolling area. */
export const SCROLLBAR_CELLS = 1

/** Cells the content of the drawer's scrolling area keeps clear at its right, so that a line never touches the scrollbar. */
export const DRAWER_SCROLL_GAP = 1
