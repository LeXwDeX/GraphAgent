// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the top bar, the `/agents` list and the sub-agent reminders say about a sub-agent session (#1033 2, 5, 6): its
 * kind, what it was asked to do, the marker of its state, and a row of the list. The one place these are decided:
 * every surface that names a sub-agent reads them from here. Pure: the data comes in through plain arguments, the
 * text is made with `t()`. Nothing here asks the server for anything; it reads the session list, the Task link and
 * the summary the data layer already keeps.
 */

import type { Session } from "@graphagent/sdk"
import type { SessionSummary, TaskIndexEntry } from "../context/session-summary"
import { formatDagDuration } from "../dag/model"
import { t, type MessageKey } from "../i18n"
import { remoteLine } from "../util/remote-text"
import { childSessions } from "./siblings"

/** The state of a sub-agent, drawn as one static glyph. */
export type SubagentMarker = "running" | "failed" | "done"

export const SUBAGENT_MARKER_GLYPH: Record<SubagentMarker, string> = {
  running: "●",
  failed: "✗",
  done: "✓",
}

export type SubagentMarkerToken = "primary" | "error" | "success"

const MARKER_TOKENS: Record<SubagentMarker, SubagentMarkerToken> = {
  running: "primary",
  failed: "error",
  done: "success",
}

/** Theme token that colors the marker; the glyph tells the states apart as well as the color. */
export function subagentMarkerToken(marker: SubagentMarker): SubagentMarkerToken {
  return MARKER_TOKENS[marker]
}

/**
 * Marker of a session summary: running while busy or retrying (an error left from an earlier turn does not hide that
 * the session runs again), failed with an error, done once idle. None while no status was ever reported, which is how
 * every session reads after a restart: the server lists only the busy ones.
 */
export function subagentMarker(
  summary: Pick<SessionSummary, "status" | "error"> | undefined,
): SubagentMarker | undefined {
  if (!summary) return undefined
  if (summary.status === "busy" || summary.status === "retry") return "running"
  if (summary.error) return "failed"
  if (summary.status === "idle") return "done"
  return undefined
}

/** The task tool titles a child session `<description> (@<agent> subagent)`. */
const TITLE_SUFFIX = /\s*\(@([^\s)]+) subagent\)\s*$/

/** Kind of agent: the session's own agent, the parent's Task input, the title, then a plain `agent`. */
export function subagentKind(session: Pick<Session, "title" | "agent">, task?: Pick<TaskIndexEntry, "kind">): string {
  const fromTitle = TITLE_SUFFIX.exec(session.title)?.[1]
  return remoteLine(session.agent ?? "") || remoteLine(task?.kind ?? "") || remoteLine(fromTitle ?? "") || "agent"
}

/** What the sub-agent was asked to do: the Task input, else the title without its `(@x subagent)` tail. */
export function subagentDescription(
  session: Pick<Session, "title">,
  task?: Pick<TaskIndexEntry, "description">,
): string {
  return remoteLine(task?.description ?? "") || remoteLine(session.title.replace(TITLE_SUFFIX, ""))
}

export type SubagentSessionInfo = Pick<Session, "id" | "parentID" | "title" | "agent" | "time">

/** Where a row's facts come from: the data layer's Task links and summaries, by session. */
export interface SubagentRowSource {
  /** The parent's Task link of a child session, as `taskIndex` keeps it. */
  task(sessionID: string): Pick<TaskIndexEntry, "kind" | "description"> | undefined
  summary(
    sessionID: string,
  ): Pick<SessionSummary, "status" | "toolCalls" | "startedAt" | "lastActivityAt" | "error"> | undefined
}

export interface SubagentRow {
  readonly id: string
  readonly kind: string
  readonly description: string
  /** Undefined while no status was ever reported (a cold start): the row draws no glyph and says `—`. */
  readonly marker: SubagentMarker | undefined
  /** Running again after an error: the marker is still running, the text says why it is slow. */
  readonly retrying: boolean
  /** Unknown (undefined) until a tool was seen: a cold start has no count, and must not say 0. */
  readonly toolCalls: number | undefined
  readonly startedAt: number
  /** The last activity, for a sub-agent that is over; undefined while it runs, when the clock ends it. */
  readonly endedAt: number | undefined
}

/**
 * The direct children of `rootID` as rows, in `childSessions` order: the order `←→` walks and `i/N` counts. Deeper
 * descendants are not listed; the sessions a root starts (Task sub-agents and DAG node sessions) are all its children.
 */
export function subagentRows(
  sessions: readonly SubagentSessionInfo[],
  rootID: string,
  source: SubagentRowSource,
): SubagentRow[] {
  return childSessions(sessions, rootID).map((session) => {
    const task = source.task(session.id)
    const summary = source.summary(session.id)
    const marker = subagentMarker(summary)
    return {
      id: session.id,
      kind: subagentKind(session, task),
      description: subagentDescription(session, task),
      marker,
      retrying: summary?.status === "retry",
      toolCalls: summary?.toolCalls,
      startedAt: summary?.startedAt ?? session.time.created,
      // `lastActivityAt` is 0 in a summary made from a bare event; the session's own update time then stands in.
      endedAt: marker === "running" ? undefined : Math.max(summary?.lastActivityAt ?? 0, session.time.updated),
    }
  })
}

/** `kind · description`: how a sub-agent is named in a row and in the text sent to the main agent. */
export function subagentTitle(row: Pick<SubagentRow, "kind" | "description">): string {
  return `${row.kind} · ${row.description}`
}

const MARKER_KEYS: Record<SubagentMarker, MessageKey> = {
  running: "subagent.state.running",
  failed: "subagent.state.failed",
  done: "subagent.state.done",
}

/** Stands where a state, a tool count or a time is not known. */
const UNKNOWN = "—"

/** Time spent: from the start to the last activity, or to `now` while it runs. */
export function subagentElapsed(row: Pick<SubagentRow, "startedAt" | "endedAt">, now: number): string {
  return formatDagDuration(row.startedAt, row.endedAt ?? now) ?? UNKNOWN
}

/** The state word (`—` when unknown), the tool count (`—` when unknown) and the time, as a row ends. */
export function subagentTrail(row: SubagentRow, now: number): string {
  const state = row.marker ? t(row.retrying ? "subagent.state.retrying" : MARKER_KEYS[row.marker]) : UNKNOWN
  const tools = t("subagent.row.tools", { count: row.toolCalls ?? UNKNOWN })
  return [state, tools, subagentElapsed(row, now)].join(" · ")
}

interface PromptMessage {
  readonly id: string
  readonly role: string
}

interface PromptPart {
  readonly type: string
  readonly text?: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
}

/**
 * What the main agent asked of a sub-agent, on one line: the text of the session's first user message. Undefined
 * while the session is not loaded or has no such text; the caller falls back to the Task description then.
 */
export function delegatedPrompt(
  messages: readonly PromptMessage[] | undefined,
  partsOf: (messageID: string) => readonly PromptPart[] | undefined,
): string | undefined {
  const first = messages?.find((message) => message.role === "user")
  if (!first) return undefined
  const text = (partsOf(first.id) ?? [])
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? "")
    .join(" ")
  // Indentation and lists in a long prompt would eat the one row it has.
  return remoteLine(text).replace(/\s+/g, " ") || undefined
}

/**
 * The request that asks the main agent to deal with a sub-agent. It stops at a colon, where the user goes on writing;
 * it is only put in the main session's input, never sent (`session/prefill.ts`).
 */
export function subagentRelayText(row: Pick<SubagentRow, "kind" | "description">): string {
  return t("subagent.relay.prefill", { source: subagentTitle(row) })
}
