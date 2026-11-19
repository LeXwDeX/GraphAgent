// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { t } from "../../i18n"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../../ui/width"
import { remoteLine } from "../../util/remote-text"

/** The least cells a title may keep before the line gives it up for the one without a title. */
const MIN_TITLE_CELLS = 3

/** `ms` as whole seconds the reader can read: `12 秒` under a minute, `1 分 5 秒` from there on (`reasoning.duration.*`). */
export function reasoningDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t("reasoning.duration.seconds", { n: seconds })
  return t("reasoning.duration.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 })
}

export interface ReasoningLineInput {
  /** Whether the thought is finished; one that is still being written says it is thinking, and has no duration yet. */
  done: boolean
  /** Whether the thought is open (opened by the reader, or the mode shows it): the line then does not say it is folded. */
  open: boolean
  /** The bold title the summary of the thought starts with, if it has one. */
  title: string | null
  /** `reasoningDuration` of a finished thought. */
  duration?: string
  /** Cells the line has after its glyph column. */
  room: number
  ambiguousWidth: AmbiguousWidth
}

/**
 * The words of the one line a thought is drawn as (`reasoning.*`), cut to `room` cells at the reader's
 * `ambiguous_width` so that the line never runs past the row, whichever way the terminal draws `…` and `·`.
 *
 * A thought with a title says the title first and keeps it when there is room; when the title would leave less than a
 * few cells of itself, the line is the one without a title, so the rest of the words are never what gives way to it.
 */
export function reasoningLine(input: ReasoningLineInput) {
  const aw = input.ambiguousWidth
  const title = input.title ? remoteLine(input.title) : ""
  const plain = !input.done ? "reasoning.thinking" : input.open ? "reasoning.open" : "reasoning.folded"
  const titled = !input.done ? "reasoning.thinkingTitle" : input.open ? "reasoning.openTitle" : "reasoning.foldedTitle"
  const params = { title: "", duration: input.duration ?? "" }

  if (title) {
    // What the sentence says around the title, so the title is cut to what is left.
    const room = input.room - cellWidth(t(titled, params), aw)
    if (room >= MIN_TITLE_CELLS) return t(titled, { ...params, title: truncateCells(title, room, aw) })
  }
  return truncateCells(t(plain, params), input.room, aw)
}
