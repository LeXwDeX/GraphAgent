// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createSignal } from "solid-js"

/**
 * One virtual line of the session transcript. The row is the unit of
 * windowing: user messages, assistant parts and message-level metadata each
 * become one row. `revision` changes when the row's content changes, which
 * invalidates its cached measured height.
 */
export type RowKind = "user" | "text" | "reasoning" | "tool" | "meta" | "revert" | "notice"

export interface Row {
  key: string
  messageID: string
  partID?: string
  kind: RowKind
  revision: number
}

export const WINDOW_MIN_ROWS = 30
export const PART_OVERSCAN = 6
export const TAIL_ALWAYS = 4

/** Rows that are always mounted regardless of the viewport. */
export interface PinnedRows {
  has(key: string): boolean
}

export interface RowMeasurement {
  height: number
  width: number
  revision: number
}

/**
 * Caches the measured height of a mounted row. A width or revision change
 * makes the entry stale; the caller falls back to the estimate until the row
 * is measured again.
 */
export function createRowMeasurements() {
  const entries = new Map<string, RowMeasurement>()
  const [version, setVersion] = createSignal(0)

  function get(key: string, revision: number, width: number): number | undefined {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.revision !== revision || entry.width !== width) return undefined
    return entry.height
  }

  function report(key: string, revision: number, width: number, height: number) {
    const entry = entries.get(key)
    if (entry && entry.revision === revision && entry.width === width && entry.height === height) return
    entries.set(key, { revision, width, height })
    setVersion((value) => value + 1)
  }

  function clear() {
    entries.clear()
    setVersion((value) => value + 1)
  }

  return { get, report, clear, version }
}

/**
 * Preserves row object identity for unchanged rows so that a content update
 * does not remount every mounted row.
 */
export function stableRows(previous: ReadonlyMap<string, Row>, rows: Row[]) {
  const next = new Map<string, Row>()
  const stable = rows.map((row) => {
    const old = previous.get(row.key)
    const value = old && old.kind === row.kind && old.revision === row.revision ? old : row
    next.set(value.key, value)
    return value
  })
  return { rows: stable, byKey: next }
}

/** Stable, cheap revision value for content that changes in place. */
export function rowRevision(...values: (string | number | boolean | undefined)[]): number {
  let hash = 2166136261
  for (const value of values) {
    const text = String(value ?? "")
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 31
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Prefix sums of row heights. `positions[i]` is the top of row `i`. */
export function prefixPositions(rows: readonly Row[], height: (row: Row, index: number) => number): number[] {
  const positions = new Array<number>(rows.length + 1)
  positions[0] = 0
  for (let index = 0; index < rows.length; index++) {
    positions[index + 1] = positions[index] + Math.max(1, height(rows[index], index))
  }
  return positions
}

/** First row whose bottom is below `top`. */
export function firstVisible(positions: readonly number[], top: number): number {
  let low = 0
  let high = Math.max(0, positions.length - 2)
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (positions[middle + 1] <= top) low = middle + 1
    else high = middle
  }
  return low
}

/** Last row whose top is above `bottom`. */
export function lastVisible(positions: readonly number[], bottom: number): number {
  const first = firstVisible(positions, bottom)
  return Math.max(0, Math.min(positions.length - 2, first - (positions[first] >= bottom ? 1 : 0)))
}

export function visibleRange(positions: readonly number[], top: number, viewport: number) {
  if (positions.length <= 1) return { first: 0, last: -1 }
  const boundedTop = Math.max(0, Math.min(top, positions[positions.length - 1] - 1))
  const first = firstVisible(positions, boundedTop)
  const last = Math.max(first, lastVisible(positions, boundedTop + viewport))
  return { first, last }
}

export function estimateRowHeight(row: Row, width: number, chars: number, expanded = false): number {
  const contentWidth = Math.max(1, width - 3)
  const lines = Math.max(1, Math.ceil(chars / contentWidth))
  switch (row.kind) {
    case "user":
      return lines + 3
    case "text":
      return lines + 1
    case "reasoning":
      return expanded ? lines + 3 : 2
    case "tool":
      return expanded ? lines + 3 : 2
    case "revert":
      return 5
    case "meta":
    case "notice":
      return 2
  }
}

export type ViewFlag = "expanded" | "errorExpanded"

/**
 * Session-scoped view state that outlives row unmounting. Expansion state
 * belongs here; transient hover state intentionally stays in the row.
 */
export function createSessionViewState() {
  const [state, setState] = createSignal<ReadonlyMap<string, { expanded?: boolean; errorExpanded?: boolean }>>(
    new Map(),
  )

  function get(partID: string | undefined, flag: ViewFlag): boolean {
    if (!partID) return false
    return state().get(partID)?.[flag] ?? false
  }

  function set(partID: string | undefined, flag: ViewFlag, value: boolean) {
    if (!partID) return
    setState((current) => {
      const entry = current.get(partID) ?? {}
      if (entry[flag] === value) return current
      const next = new Map(current)
      next.set(partID, { ...entry, [flag]: value })
      return next
    })
  }

  return { get, set, state }
}

export type SessionViewState = ReturnType<typeof createSessionViewState>
