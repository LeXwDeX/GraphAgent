// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the `/agents` list and the sub-agent reminders say about a sub-agent session (#1033 5, 6). Pure: the data comes
 * in through plain arguments, the text is made with `t()`. Nothing here asks the server for anything; a row is read
 * from the session list, the Task link and the summary the data layer already keeps.
 */

import type { Session } from "@graphagent/sdk"
import type { SessionSummary, TaskIndexEntry } from "../context/session-summary"
import { formatDagDuration } from "../dag/model"
import { t, type MessageKey } from "../i18n"
import { remoteLine } from "../util/remote-text"
import { childSessions } from "./siblings"

/** What a sub-agent is doing, as the list draws it: one static glyph and one state token each. */
export type SubagentState = "running" | "failed" | "done"

export const SUBAGENT_GLYPH: Readonly<Record<SubagentState, string>> = {
  running: "●",
  failed: "✗",
  done: "✓",
}

export type SubagentSessionInfo = Pick<Session, "id" | "parentID" | "title" | "agent" | "time">

export interface SubagentLookup {
  /** The parent's Task link of a child session, as `taskIndex` keeps it. */
  task(sessionID: string): Pick<TaskIndexEntry, "kind" | "description"> | undefined
  summary(
    sessionID: string,
  ): Pick<SessionSummary, "status" | "toolCalls" | "startedAt" | "lastActivityAt" | "error"> | undefined
}

/** The task tool titles a child session `<description> (@<agent> subagent)`. */
const TITLE_SUFFIX = /\s*\(@([^\s)]+) subagent\)\s*$/

/** The kind of agent: the session's own agent, the parent's Task input, the title, then a plain `agent`. */
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

/**
 * Running while the session works or retries; failed when the last turn ended in an error; done otherwise. A session
 * no status has been reported for is idle (the server lists only busy ones after a restart), so it reads as done.
 */
export function subagentState(summary: Pick<SessionSummary, "status" | "error"> | undefined): SubagentState {
  if (summary?.status === "busy" || summary?.status === "retry") return "running"
  return summary?.error ? "failed" : "done"
}

export interface SubagentRow {
  readonly id: string
  readonly kind: string
  readonly description: string
  readonly state: SubagentState
  /** Running again after an error: the state is still running, the text says why it is slow. */
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
  lookup: SubagentLookup,
): SubagentRow[] {
  return childSessions(sessions, rootID).map((session) => {
    const task = lookup.task(session.id)
    const summary = lookup.summary(session.id)
    const state = subagentState(summary)
    return {
      id: session.id,
      kind: subagentKind(session, task),
      description: subagentDescription(session, task),
      state,
      retrying: summary?.status === "retry",
      toolCalls: summary?.toolCalls,
      startedAt: summary?.startedAt ?? session.time.created,
      // `lastActivityAt` is 0 in a summary made from a bare event; the session's own update time then stands in.
      endedAt: state === "running" ? undefined : Math.max(summary?.lastActivityAt ?? 0, session.time.updated),
    }
  })
}

/** `kind · description`: how a sub-agent is named in a row, a reminder and the text sent to the main agent. */
export function subagentTitle(row: Pick<SubagentRow, "kind" | "description">): string {
  return `${row.kind} · ${row.description}`
}

const STATE_KEYS: Record<SubagentState, MessageKey> = {
  running: "subagent.state.running",
  failed: "subagent.state.failed",
  done: "subagent.state.done",
}

/** Time spent: from the start to the last activity, or to `now` while it runs. */
export function subagentElapsed(row: Pick<SubagentRow, "startedAt" | "endedAt">, now: number): string {
  return formatDagDuration(row.startedAt, row.endedAt ?? now) ?? "—"
}

/** The state word, the tool count (`—` when unknown) and the time, as a row ends. */
export function subagentTrail(row: SubagentRow, now: number): string {
  const state = t(row.retrying ? "subagent.state.retrying" : STATE_KEYS[row.state])
  const tools = t("subagent.row.tools", { count: row.toolCalls ?? "—" })
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
