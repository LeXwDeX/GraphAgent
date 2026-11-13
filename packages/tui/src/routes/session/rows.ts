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

/**
 * Transcripts shorter than this stay fully mounted. On OpenTUI 0.8.3 the native
 * scroll box already culls what is off screen, so windowing buys little until the
 * mounted tree itself is large: a fully mounted 1900-row transcript types at a
 * 2.1 ms p95 (0.3 windowed), mounts in 300 ms (100) and holds 146 MB (44), while
 * the windowed scroll costs 5 to 47 times more per step (P9 p99 10.4 ms against
 * 0.87) and moves the content by several lines when row heights are corrected.
 * The two costs meet near 2000 rows (#1025).
 */
export const WINDOW_MIN_ROWS = 2000
export const PART_OVERSCAN = 6
export const TAIL_ALWAYS = 4

/** Whether a transcript of `rowCount` rows is windowed; shorter ones mount every row. */
export const isWindowed = (rowCount: number) => rowCount >= WINDOW_MIN_ROWS

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

/** Length of the longest line of `text`, at least 1: the width a row of this text has to wrap. */
export function longestLine(text: string): number {
  let longest = 1
  let start = 0
  while (true) {
    const end = text.indexOf("\n", start)
    const stop = end === -1 ? text.length : end
    if (stop - start > longest) longest = stop - start
    if (end === -1) return longest
    start = end + 1
  }
}

/**
 * The text of a part whose final snapshot has arrived. That snapshot settled the part's stream buffer, so
 * what the part shows is what the store holds: this is `StreamBuffer.read` of a part with nothing buffered,
 * read without the stream version. A reader that follows the version re-runs once per frame, and a settled
 * part has no reason to.
 */
export function settledPartText(part: { type: string; text?: string; displayText?: string }): string {
  return part.type === "text" && typeof part.displayText === "string" ? part.displayText : (part.text ?? "")
}

/** What a text row needs from the body of its part. */
export interface TextFacts {
  /** The body after `normalize`: what the row shows. Empty means the part has no row. */
  readonly text: string
  /** Longest line of `text`: the height estimate wraps it. */
  readonly chars: number
  /** Content hash of `text`, computed on first use: only a finished row folds its body into its revision. */
  hash(): number
}

export interface TextFactsCache {
  /**
   * The facts of part `id` for the text `raw`. Derived once per distinct text: a call with the text it saw
   * last time returns the facts it kept, whatever the length of the text.
   */
  read(id: string, raw: string, normalize: (raw: string) => string): TextFacts
  /** Forgets every part that is not in `live`. */
  retain(live: ReadonlySet<string>): void
  readonly size: number
}

export function createTextFacts(): TextFactsCache {
  const entries = new Map<string, TextFacts & { raw: string }>()

  function read(id: string, raw: string, normalize: (raw: string) => string) {
    const entry = entries.get(id)
    if (entry && entry.raw === raw) return entry
    const text = normalize(raw)
    let hash: number | undefined
    const next = { raw, text, chars: longestLine(text), hash: () => (hash ??= rowRevision(text)) }
    entries.set(id, next)
    return next
  }

  function retain(live: ReadonlySet<string>) {
    for (const id of entries.keys()) if (!live.has(id)) entries.delete(id)
  }

  return {
    read,
    retain,
    get size() {
      return entries.size
    },
  }
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
