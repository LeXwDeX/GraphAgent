// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Row, SessionViewState, ViewFlag } from "./rows"

/**
 * `view.expand.toggle`. It opens the most recent block that is folded; each press goes one block further back in
 * the transcript. When every block that can fold is open, it closes the most recent one instead, so the key never
 * does nothing while a block could change. Returns what it did, or `undefined` when no block can fold.
 *
 * `foldOf` says under which view flag the part of a row folds right now, and nothing for a row that cannot
 * fold. It reads the parts in the store (see `fold.ts`), not the blocks on screen: a windowed transcript
 * unmounts every block outside the viewport and the rows around it, and those are the ones an earlier press has to
 * reach. The rows are visited from the end and only as far as the first folded block, so the usual press reads a few
 * parts; only a press with every block open reads them all.
 *
 * It flips the flag a click flips, in the same view state, so a block opened by key closes by click and the other
 * way round, and a block opened by click counts as open here. A row the key opens is pinned by that flag
 * (`pinnedKeys`) and mounts open, wherever the viewport is.
 */
export function toggleExpand(rows: readonly Row[], foldOf: (row: Row) => ViewFlag | undefined, view: SessionViewState) {
  let latest: { partID: string; flag: ViewFlag } | undefined
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    const partID = row.partID
    if (!partID) continue
    const flag = foldOf(row)
    if (!flag) continue
    if (!view.get(partID, flag)) {
      view.set(partID, flag, true)
      return "opened" as const
    }
    latest ??= { partID, flag }
  }
  if (!latest) return undefined
  view.set(latest.partID, latest.flag, false)
  return "closed" as const
}
