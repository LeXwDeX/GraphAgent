// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { contentWidth } from "../../ui/layout"

/**
 * Narrowest transcript content width that shows an edit or patch diff side by side (#1032 6). At the threshold each
 * side gets about 60 columns, the same as the old layout gave a 167-column terminal with the sidebar open.
 */
export const SPLIT_DIFF_MIN_CONTENT_WIDTH = 120

export type DiffView = "split" | "unified"

/**
 * Width of the transcript content for a terminal width: the terminal less the gutter at each side. The drawer is an
 * overlay (#1032 5.1), so it takes nothing from this width, open or closed.
 */
export function sessionContentWidth(terminalWidth: number) {
  return contentWidth(terminalWidth)
}

/** `stacked` always shows one column; otherwise a diff is split once the content is wider than the threshold. */
export function diffView(style: string | undefined, width: number): DiffView {
  if (style === "stacked") return "unified"
  return width > SPLIT_DIFF_MIN_CONTENT_WIDTH ? "split" : "unified"
}
