// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { onCleanup } from "solid-js"
import type { Row, SessionViewState, ViewFlag } from "./rows"

/**
 * A block that can fold part of its content: reasoning shown as one header line, a tool output cut at its line cap,
 * the error text of a failed tool. The component that owns the click handler registers it, so the keyboard and the
 * click agree on what can fold and on the view flag a toggle flips.
 */
export interface ExpandTarget {
  /** The view flag a click on the block flips. */
  flag: ViewFlag
  /**
   * Whether the block has anything to fold or unfold right now, folded or not. Output that fits under its cap,
   * reasoning shown in full and a tool that did not fail have nothing to toggle, so the keyboard skips them.
   */
  available: () => boolean
}

/**
 * The blocks of a session transcript that can fold, by part. A part can hold more than one target over its life (a
 * bash call that failed before it had output is one line with an error, and a block once the output arrives); the
 * components do not overlap, so at most one of them is available at a time.
 */
export function createExpandables() {
  const entries = new Map<string, Set<ExpandTarget>>()

  /** Registers `target` for `partID` until the calling component is disposed. */
  function register(partID: string, target: ExpandTarget) {
    const targets = entries.get(partID) ?? new Set<ExpandTarget>()
    targets.add(target)
    entries.set(partID, targets)
    onCleanup(() => {
      targets.delete(target)
      if (targets.size === 0 && entries.get(partID) === targets) entries.delete(partID)
    })
  }

  function availableFor(partID: string | undefined) {
    if (!partID) return undefined
    for (const target of entries.get(partID) ?? []) if (target.available()) return target
    return undefined
  }

  return { register, availableFor }
}

export type Expandables = ReturnType<typeof createExpandables>

/**
 * `view.expand.toggle`. It opens the most recent block that is folded; each press goes one block further back in
 * the transcript. When every block that can fold is open, it closes the most recent one instead, so the key never
 * does nothing while a block could change. Returns what it did, or `undefined` when no block can fold.
 *
 * It flips the flag a click flips, in the same view state, so a block opened by key closes by click and the other
 * way round, and a block opened by click counts as open here.
 *
 * Only mounted blocks are registered. A windowed transcript keeps its tail and the rows around the viewport
 * mounted, which is where the most recent blocks are.
 */
export function toggleExpand(rows: readonly Row[], expandables: Expandables, view: SessionViewState) {
  let latest: { partID: string; target: ExpandTarget } | undefined
  for (let index = rows.length - 1; index >= 0; index--) {
    const partID = rows[index].partID
    const target = expandables.availableFor(partID)
    if (!partID || !target) continue
    if (!view.get(partID, target.flag)) {
      view.set(partID, target.flag, true)
      return "opened" as const
    }
    latest ??= { partID, target }
  }
  if (!latest) return undefined
  view.set(latest.partID, latest.target.flag, false)
  return "closed" as const
}
