// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Progress-bar layout for one workflow: one segment per node, grouped by wave,
 * colored by state. Pure; the status band and the `/dag` panel draw the
 * segments with theme colors.
 *
 * Width is counted in cells under the user's `ambiguous_width`. The layout is
 * built from slots, each `ambiguousWidth` cells wide, so every state takes the
 * same room whatever its glyph: `━` and `─` are East Asian Ambiguous, and one
 * of them fills a slot at either setting. `╌` (U+254C) is Neutral and stays one
 * cell wide at either setting, so it takes `ambiguousWidth` of them per slot.
 * `ui/width.ts` is the one place that measures text and `dag/` may not import
 * it, which is why the glyph widths are written down here; the bar tests
 * compare every layout against `cellWidth`, so a change on either side fails.
 */

import { dagStateStyle, type DagBarGlyph, type DagStateStyle, type DagStatusToken } from "./model"

/** The node fields the bar reads; the SDK node and the stored row both fit. */
export interface DagBarNode {
  readonly status: string
  readonly error_class?: string
}

export interface DagBarInput {
  /** Waves in display order, as `computeWaves` returns them. Empty waves are skipped. */
  readonly waves: readonly (readonly DagBarNode[])[]
  /** Nodes outside every wave. They form a last group, marked with `!`, and count like any other node. */
  readonly unplaced?: readonly DagBarNode[]
  /** Cells the bar may use. */
  readonly width: number
  /** Cells an East Asian Ambiguous glyph takes (the `ambiguous_width` setting); default 1. */
  readonly ambiguousWidth?: 1 | 2
  /** Slots per node before the layout narrows it: 3 in the status band, 5 in the panel. Default 3. */
  readonly per?: number
}

export interface DagBarSegment {
  /** Theme token the run is drawn in; the spaces between waves have none. */
  readonly token?: DagStatusToken
  readonly text: string
  /** Cells `text` takes under the layout's `ambiguousWidth`. */
  readonly cells: number
}

export type DagBarLayout = {
  readonly segments: readonly DagBarSegment[]
  /** The segments' text, for output without colors. */
  readonly text: string
  /** Cells the whole bar takes; never more than `width`. */
  readonly cells: number
} & (
  | {
      /** One segment per node, `per` slots each, a space between waves. */
      readonly mode: "nodes"
      readonly per: number
    }
  | {
      /**
       * One segment per wave (neighbouring waves merge when even that does not
       * fit), colored by the worst state in it. `widths` are the segments' slot
       * counts, in order.
       */
      readonly mode: "waves"
      readonly widths: readonly number[]
    }
)

interface Group {
  readonly styles: readonly DagStateStyle[]
  /** The group of nodes outside every wave. */
  readonly anomaly: boolean
}

type Piece =
  | { readonly kind: "run"; readonly style: DagStateStyle; readonly slots: number }
  | { readonly kind: "gap" }
  | { readonly kind: "mark" }

const DEFAULT_PER = 3
/** Cells of the `!` in front of the group of nodes outside every wave. */
const MARK_CELLS = 1

const EMPTY: DagBarLayout = { mode: "waves", widths: [], segments: [], text: "", cells: 0 }

function whole(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function groupsOf(input: DagBarInput): Group[] {
  const styleOf = (node: DagBarNode) => dagStateStyle(node.status, node.error_class)
  const groups: Group[] = []
  for (const wave of input.waves) {
    if (wave.length > 0) groups.push({ styles: wave.map(styleOf), anomaly: false })
  }
  const unplaced = input.unplaced ?? []
  if (unplaced.length > 0) groups.push({ styles: unplaced.map(styleOf), anomaly: true })
  return groups
}

/** The state that stands for a group of nodes: the highest rank, the first one on a tie. */
function worstOf(styles: readonly DagStateStyle[]): DagStateStyle {
  let worst = styles[0]
  for (const style of styles) if (style.rank > worst.rank) worst = style
  return worst
}

/** Characters that fill `slots` slots with `glyph`; see the note at the top of the file. */
function fill(glyph: DagBarGlyph, slots: number, slotCells: number) {
  return glyph.repeat(glyph === "╌" ? slots * slotCells : slots)
}

function render(
  pieces: readonly Piece[],
  slotCells: number,
): { segments: DagBarSegment[]; text: string; cells: number } {
  const segments: DagBarSegment[] = []
  let last: { token: DagStatusToken; glyph: DagBarGlyph; slots: number } | undefined
  const flush = () => {
    if (!last) return
    segments.push({ token: last.token, text: fill(last.glyph, last.slots, slotCells), cells: last.slots * slotCells })
    last = undefined
  }
  for (const piece of pieces) {
    if (piece.kind === "run") {
      // Neighbouring nodes in one state read as one run; a separator ends it.
      if (last && last.token === piece.style.token && last.glyph === piece.style.bar) last.slots += piece.slots
      else {
        flush()
        last = { token: piece.style.token, glyph: piece.style.bar, slots: piece.slots }
      }
      continue
    }
    flush()
    if (piece.kind === "gap") segments.push({ text: " ", cells: 1 })
    else segments.push({ token: "error", text: "!", cells: MARK_CELLS })
  }
  flush()
  const text = segments.map((segment) => segment.text).join("")
  return { segments, text, cells: segments.reduce((sum, segment) => sum + segment.cells, 0) }
}

/** `total` slots shared out in proportion to `weights`, none below one; `total` is at least the number of weights. */
function allocate(total: number, weights: readonly number[]): number[] {
  const slots = weights.map(() => 1)
  const spare = total - weights.length
  if (spare <= 0) return slots
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  const ideal = weights.map((weight) => (spare * weight) / sum)
  let given = 0
  for (const [index, share] of ideal.entries()) {
    slots[index] += Math.floor(share)
    given += Math.floor(share)
  }
  // The slots the rounding left over go to the largest remainders, earlier waves first.
  const order = ideal
    .map((share, index) => ({ index, rest: share - Math.floor(share) }))
    .toSorted((a, b) => b.rest - a.rest || a.index - b.index)
  for (let next = 0; next < spare - given; next++) slots[order[next].index] += 1
  return slots
}

function nodesLayout(groups: readonly Group[], per: number, slotCells: number): DagBarLayout {
  const pieces: Piece[] = []
  for (const [index, group] of groups.entries()) {
    if (index > 0) pieces.push({ kind: "gap" })
    if (group.anomaly) pieces.push({ kind: "mark" })
    for (const style of group.styles) pieces.push({ kind: "run", style, slots: per })
  }
  return { mode: "nodes", per, ...render(pieces, slotCells) }
}

function wavesLayout(
  groups: readonly Group[],
  widths: readonly number[],
  slotCells: number,
  gaps: boolean,
): DagBarLayout {
  const pieces: Piece[] = []
  for (const [index, group] of groups.entries()) {
    if (index > 0 && gaps) pieces.push({ kind: "gap" })
    if (group.anomaly) pieces.push({ kind: "mark" })
    pieces.push({ kind: "run", style: worstOf(group.styles), slots: widths[index] })
  }
  return { mode: "waves", widths, ...render(pieces, slotCells) }
}

/**
 * Even when every wave gets a slot of its own the bar is too wide: neighbouring
 * waves share a segment, and the group outside every wave keeps its own, since
 * that is the one that points at a defect. Nothing fits below a single slot.
 */
function squeezedLayout(groups: readonly Group[], width: number, slotCells: number): DagBarLayout {
  const last = groups.at(-1)
  const anomaly = last?.anomaly === true ? last : undefined
  const waves = anomaly ? groups.slice(0, -1) : groups
  // Slots that fit with no spaces, the one of the anomaly group included. Fewer
  // than there are groups: that is why the bar is squeezed.
  const slots = Math.floor((width - (anomaly ? MARK_CELLS : 0)) / slotCells)
  const forWaves = slots - (anomaly ? 1 : 0)
  if (forWaves >= 1) {
    // Contiguous buckets of near-equal wave counts, one slot each.
    const buckets: Group[] = []
    let from = 0
    for (let bucket = 0; bucket < forWaves; bucket++) {
      const size = Math.floor(waves.length / forWaves) + (bucket < waves.length % forWaves ? 1 : 0)
      buckets.push({ styles: waves.slice(from, from + size).flatMap((wave) => wave.styles), anomaly: false })
      from += size
    }
    if (anomaly) buckets.push(anomaly)
    return wavesLayout(
      buckets,
      buckets.map(() => 1),
      slotCells,
      false,
    )
  }
  // No room for a wave: the anomaly group alone, or just its marker.
  if (anomaly && slots >= 1) return wavesLayout([anomaly], [1], slotCells, false)
  if (anomaly && width >= MARK_CELLS) return { mode: "waves", widths: [], ...render([{ kind: "mark" }], slotCells) }
  return EMPTY
}

/**
 * Lay out a workflow's progress bar in at most `width` cells.
 *
 * 1. Node by node: from `per` slots per node down to one, as long as every
 *    node fits, a space between waves.
 * 2. Otherwise wave by wave: each wave a segment of at least one slot, sized
 *    by its share of the nodes, colored by the worst state in it (failed,
 *    running, paused, waiting, skipped, completed, in that order). The slots
 *    that fit are all used.
 * 3. Past that the spaces go, and then neighbouring waves share a segment.
 *
 * `cells` never exceeds `width`, whatever the input.
 */
export function layoutDagBar(input: DagBarInput): DagBarLayout {
  const width = whole(input.width)
  const slotCells = input.ambiguousWidth === 2 ? 2 : 1
  const perMax =
    input.per === undefined || !Number.isFinite(input.per) ? DEFAULT_PER : Math.max(1, Math.floor(input.per))
  const groups = groupsOf(input)
  if (groups.length === 0) return EMPTY

  const nodes = groups.reduce((sum, group) => sum + group.styles.length, 0)
  const spaces = groups.length - 1
  const mark = groups.some((group) => group.anomaly) ? MARK_CELLS : 0

  // The most slots per node, up to `perMax`, with every node and every space in `width`.
  const per = Math.min(perMax, Math.floor((width - spaces - mark) / (nodes * slotCells)))
  if (per >= 1) return nodesLayout(groups, per, slotCells)

  const slots = Math.floor((width - spaces - mark) / slotCells)
  const weights = groups.map((group) => group.styles.length)
  if (slots >= groups.length) return wavesLayout(groups, allocate(slots, weights), slotCells, true)

  const compact = Math.floor((width - mark) / slotCells)
  if (compact >= groups.length) return wavesLayout(groups, allocate(compact, weights), slotCells, false)

  return squeezedLayout(groups, width, slotCells)
}
