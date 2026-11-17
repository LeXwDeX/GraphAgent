// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "@graphagent/sdk"
import type { SessionSummary, TaskIndexEntry } from "../context/session-summary"
import { t } from "../i18n"
import {
  SUBAGENT_MARKER_GLYPH,
  subagentDescription,
  subagentKind,
  subagentMarker,
  type SubagentMarker,
} from "../session/subagents"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { remoteLine } from "../util/remote-text"

/**
 * The path a sub-agent view shows in the top bar (#1033 2): the sessions above the viewed one, root first, then the
 * sub-agent itself as `<marker><kind> · <description>`. Everything here is pure: the data comes in through
 * `SubagentLookup`, the widths through `cellWidth`. The kind, the description and the marker come from
 * `session/subagents.ts`, the one place that decides them, so the list of sub-agents names them the same way. A
 * background run adds a tag to the current segment (#1058 8), the first thing to give way when the path is too long.
 */

export type SubagentAncestor = {
  id: string
  title: string
}

export type SubagentView = {
  /** Sessions above the viewed one, the root first; empty while the parent is not loaded. */
  ancestors: readonly SubagentAncestor[]
  kind: string
  description: string
  marker?: SubagentMarker
  /** How a run that is not a foreground one goes on: a background run, or a foreground one moved there. */
  execution?: "background" | "promoted"
}

export type SubagentLookup = {
  session(id: string): Pick<Session, "id" | "parentID" | "title" | "agent"> | undefined
  task(id: string): Pick<TaskIndexEntry, "kind" | "description" | "background" | "promoted"> | undefined
  summary(id: string): Pick<SessionSummary, "status" | "error"> | undefined
}

/** Most sessions walked up from the viewed one; a parent loop or a runaway chain stops here. */
export const MAX_CHAIN_DEPTH = 16

/** The view of `sessionID` as a sub-agent; nothing for a session without a parent or one that is not loaded. */
export function subagentView(lookup: SubagentLookup, sessionID: string): SubagentView | undefined {
  const session = lookup.session(sessionID)
  if (!session?.parentID) return undefined

  const ancestors: SubagentAncestor[] = []
  const seen = new Set([sessionID])
  let parentID: string | undefined = session.parentID
  while (parentID && !seen.has(parentID) && ancestors.length < MAX_CHAIN_DEPTH) {
    seen.add(parentID)
    const parent = lookup.session(parentID)
    if (!parent) break
    ancestors.unshift({ id: parent.id, title: remoteLine(parent.title) || parent.id })
    parentID = parent.parentID
  }

  const task = lookup.task(sessionID)
  return {
    ancestors,
    kind: subagentKind(session, task),
    description: subagentDescription(session, task),
    marker: subagentMarker(lookup.summary(sessionID)),
    execution: task?.promoted ? "promoted" : task?.background ? "background" : undefined,
  }
}

/** Whether two views draw the same path; lets a memo keep its value while only unrelated fields change. */
export function sameSubagentView(left: SubagentView | undefined, right: SubagentView | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.kind === right.kind &&
    left.description === right.description &&
    left.marker === right.marker &&
    left.execution === right.execution &&
    left.ancestors.length === right.ancestors.length &&
    left.ancestors.every(
      (item, index) => item.id === right.ancestors[index]?.id && item.title === right.ancestors[index]?.title,
    )
  )
}

/**
 * The keys of a sub-agent view as its top bar and footer name them. The session route binds them itself (left and
 * right to switch between siblings, escape to go back to the parent); they have no entry in the configurable keys.
 */
export const SUBAGENT_SWITCH_KEYS = "←→"
export const SUBAGENT_BACK_KEY = "esc"

/** Between two segments of the path. */
export const PATH_SEPARATOR = " › "
/** Between the kind and the description of the current segment. */
export const DESCRIPTION_SEPARATOR = " · "
/** Stands for every middle segment once they fold. */
export const FOLD = "…"

/** Cells the description keeps while it gives way, before the middle segments fold. */
export const MIN_DESCRIPTION = 8
/** Cells the root title keeps while it gives way, before the description goes. */
export const MIN_ROOT = 8

export type SubagentPathPart =
  /** The root or a middle session; a click opens it. */
  | { type: "ancestor"; id: string; text: string }
  /** The middle sessions, folded. */
  | { type: "fold"; text: string }
  /**
   * The viewed sub-agent; `glyph` carries the marker and its trailing space, `description` may be cut or empty, `tag`
   * is the words for a background run, after its own separator.
   */
  | { type: "current"; marker?: SubagentMarker; glyph: string; kind: string; description: string; tag?: string }

export type SubagentPathLayout = {
  parts: readonly SubagentPathPart[]
  /** Cells the parts and the separators between them take; the separator before the first part is not counted. */
  width: number
}

export type SubagentPathInput = SubagentView & {
  /** Cells the path may take, not counting the separator that leads it. */
  budget: number
  ambiguousWidth: AmbiguousWidth
}

function partWidth(part: SubagentPathPart, ambiguousWidth: AmbiguousWidth) {
  const text =
    part.type === "current"
      ? part.glyph +
        part.kind +
        (part.description ? DESCRIPTION_SEPARATOR + part.description : "") +
        (part.tag ? DESCRIPTION_SEPARATOR + part.tag : "")
      : part.text
  return cellWidth(text, ambiguousWidth)
}

/**
 * Fits the path into `budget` cells (#1033 2). Whole: `root › [middle › …] <marker><kind> · <description>`. When it
 * does not fit, one thing gives way at a time and the root and the current segment stay: the description is cut down
 * to `MIN_DESCRIPTION` cells; the middle segments fold into one `…`; the root title is cut down to `MIN_ROOT` cells
 * with the description at its minimum; the description goes. A terminal too narrow even for that keeps what still
 * fits of the root and then of the kind alone, and the path disappears when nothing does. The tag of a background run
 * comes before all of that: it is drawn only while the whole path fits with it, and is the first thing to go.
 */
export function layoutSubagentPath(input: SubagentPathInput): SubagentPathLayout | undefined {
  const { budget, ambiguousWidth, description } = input
  if (budget <= 0) return undefined

  const width = (text: string) => cellWidth(text, ambiguousWidth)
  const separatorWidth = width(PATH_SEPARATOR)
  const [root, ...middle] = input.ancestors
  const glyph = input.marker ? `${SUBAGENT_MARKER_GLYPH[input.marker]} ` : ""
  const tag = input.execution
    ? t(input.execution === "promoted" ? "background.row.promoted" : "background.row.background")
    : ""
  const current = (text: string, kind = input.kind, tagged = false): SubagentPathPart => ({
    type: "current",
    marker: input.marker,
    glyph,
    kind,
    description: text,
    ...(tagged && tag ? { tag } : {}),
  })
  const ancestor = (item: SubagentAncestor, text = item.title): SubagentPathPart => ({
    type: "ancestor",
    id: item.id,
    text,
  })
  const fold: SubagentPathPart = { type: "fold", text: FOLD }
  const folded = middle.length > 0 ? [fold] : []

  const measure = (parts: readonly SubagentPathPart[]) =>
    parts.reduce((sum, part, index) => sum + partWidth(part, ambiguousWidth) + (index > 0 ? separatorWidth : 0), 0)
  const fitted = (parts: readonly SubagentPathPart[]): SubagentPathLayout | undefined => {
    const total = measure(parts)
    return total <= budget ? { parts, width: total } : undefined
  }

  const descriptionFloor = Math.min(MIN_DESCRIPTION, width(description))
  const descriptionSeparatorWidth = description ? width(DESCRIPTION_SEPARATOR) : 0

  // The description in full, or cut to what is left once `before` and the bare current segment are placed.
  const withDescription = (before: readonly SubagentPathPart[]) => {
    const cells = budget - measure([...before, current("")]) - descriptionSeparatorWidth
    if (cells < descriptionFloor) return undefined
    return fitted([...before, current(truncateCells(description, cells, ambiguousWidth))])
  }

  // The root takes what is left once the description sits at its floor (or is gone).
  const rootGivesWay = (keepDescription: boolean, floor: number) => {
    const tail = [
      ...folded,
      current(keepDescription ? truncateCells(description, descriptionFloor, ambiguousWidth) : ""),
    ]
    if (!root) return fitted(tail)
    const cells = budget - measure(tail) - separatorWidth
    if (cells < floor) return undefined
    const text = truncateCells(root.title, cells, ambiguousWidth)
    return text ? fitted([ancestor(root, text), ...tail]) : undefined
  }

  const kindOnly = () => {
    const cells = budget - width(glyph)
    const kind = cells > 0 ? truncateCells(input.kind, cells, ambiguousWidth) : ""
    return kind ? fitted([current("", kind)]) : undefined
  }

  const rootFloor = root ? Math.min(MIN_ROOT, width(root.title)) : 0
  const rootParts = root ? [ancestor(root)] : []
  const tagged = tag
    ? fitted([...rootParts, ...middle.map((item) => ancestor(item)), current(description, input.kind, true)])
    : undefined
  return (
    tagged ??
    withDescription([...rootParts, ...middle.map((item) => ancestor(item))]) ??
    (middle.length > 0 ? withDescription([...rootParts, fold]) : undefined) ??
    rootGivesWay(true, rootFloor) ??
    rootGivesWay(false, rootFloor) ??
    rootGivesWay(false, 1) ??
    kindOnly()
  )
}
