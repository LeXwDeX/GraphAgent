// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Part } from "@graphagent/sdk"
import type { SessionSummary } from "../context/session-summary"
import { t } from "../i18n"
import { renderUserTextPart } from "../i18n/receipt"
import { SUBAGENT_MARKER_GLYPH, subagentMarker, type SubagentMarker } from "../shell/subagent-path"
import { Locale } from "../util/locale"

/**
 * What the record of a sub-agent shows besides its own messages (#1033 3.4): on top the task its parent delegated
 * to it, and once it is done a closing line that says the result went back to the main session. Everything here is
 * pure: the session route reads the store and draws the pieces.
 */

/** The text of a user message as the transcript draws it: its visible text parts, receipts rendered, joined. */
export function promptText(parts: readonly Part[]): string {
  const texts: string[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic) texts.push(renderUserTextPart(part, { key: "" }))
  }
  return texts.join("\n\n")
}

/** How a sub-agent that is not running ended. It is the marker of the top bar, so the two always agree. */
export type SubagentOutcome = Exclude<SubagentMarker, "running">

/** The Task call of the parent that started the sub-agent, as far as the parent still holds it. */
export interface OutcomeTask {
  /** A background call ends as soon as it has started the agent, so its state says nothing of how the agent ended. */
  background?: boolean
  /** `state.status` of the Task part. */
  status?: string
}

/**
 * How the sub-agent ended; nothing while it still runs. The session's own state decides, the one the top bar marker
 * reads. When that is not known yet (a cold start has no status for a session that is idle) a foreground Task call
 * that has ended in the parent says how it went.
 */
export function subagentOutcome(
  summary: Pick<SessionSummary, "status" | "error"> | undefined,
  task?: OutcomeTask,
): SubagentOutcome | undefined {
  const marker = subagentMarker(summary)
  if (marker === "running") return undefined
  if (marker) return marker
  if (!task || task.background) return undefined
  if (task.status === "completed") return "done"
  if (task.status === "error") return "failed"
  return undefined
}

/** What the closing line of a finished sub-agent says, before it is put into words. */
export interface HandbackLine {
  outcome: SubagentOutcome
  /** Tool calls the agent made. Unknown (`undefined`) until its messages are loaded, never 0 by default. */
  toolCalls: number | undefined
  /** Milliseconds from its start to its last activity; unknown without a start time. */
  duration: number | undefined
}

export function handbackLine(
  outcome: SubagentOutcome,
  summary: Pick<SessionSummary, "toolCalls" | "startedAt" | "lastActivityAt"> | undefined,
): HandbackLine {
  const span = summary?.startedAt === undefined ? undefined : summary.lastActivityAt - summary.startedAt
  return { outcome, toolCalls: summary?.toolCalls, duration: span !== undefined && span > 0 ? span : undefined }
}

/** Whether two lines say the same; lets a memo keep its value while unrelated summary fields change. */
export function sameHandback(left: HandbackLine | undefined, right: HandbackLine | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.outcome === right.outcome && left.toolCalls === right.toolCalls && left.duration === right.duration
}

/** Stands for a count or a time that is not known. */
export const UNKNOWN = "—"
/** Between the parts of the closing line. */
export const HANDBACK_SEPARATOR = " · "

export interface HandbackText {
  /** `✓` or `✗`, the part that takes the outcome's color. */
  glyph: string
  /** The sentence, with the space that follows the glyph. */
  lead: string
  /** The tool count and the time, each behind its separator. */
  meta: string
}

/** The closing line in words: `✓ <lead> · <tool calls> · <time>`. Reads `t`, so a language switch follows. */
export function handbackText(line: HandbackLine): HandbackText {
  const tools =
    line.toolCalls === undefined
      ? UNKNOWN
      : t(line.toolCalls === 1 ? "subagent.end.tools.one" : "subagent.end.tools.other", { count: line.toolCalls })
  const duration = line.duration === undefined ? UNKNOWN : Locale.duration(line.duration)
  return {
    glyph: SUBAGENT_MARKER_GLYPH[line.outcome],
    lead: ` ${t(line.outcome === "done" ? "subagent.end.done" : "subagent.end.failed")}`,
    meta: `${HANDBACK_SEPARATOR}${tools}${HANDBACK_SEPARATOR}${duration}`,
  }
}
