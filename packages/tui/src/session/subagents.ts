// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the top bar, the `/agents` list and the sub-agent reminders say about a sub-agent session (#1033 2, 5, 6; #1058
 * 6): its kind, what it was asked to do, the marker of its state, the group it is listed in, and a row of the list.
 * The one place these are decided: every surface that names a sub-agent reads them from here, and the sibling keys
 * walk the order of the list. Pure: the data comes in through plain arguments, the text is made with `t()`. Nothing
 * here asks the server for anything; it reads the session list, the Task link, the job state and the summary the data
 * layer already keeps.
 */

import type { Session } from "@graphagent/sdk"
import { lifecycleKey } from "../context/lifecycle-mirror"
import type { BackgroundResult, SessionSummary, TaskIndexEntry } from "../context/session-summary"
import { formatDagDuration } from "../dag/model"
import { t, type MessageKey } from "../i18n"
import { remoteLine } from "../util/remote-text"
import { backgroundStatus, type BackgroundJob, type BackgroundStatus } from "./background"
import { childSessions } from "./siblings"

/** The state of a sub-agent, drawn as one static glyph. */
export type SubagentMarker = "running" | "failed" | "done"

/** A row of the list has one more: a background run that waits for its slot. */
export type SubagentRowMarker = SubagentMarker | "queued"

export const SUBAGENT_MARKER_GLYPH: Record<SubagentRowMarker, string> = {
  running: "●",
  queued: "○",
  failed: "✗",
  done: "✓",
}

export type SubagentMarkerToken = "primary" | "statusQueued" | "error" | "success"

const MARKER_TOKENS: Record<SubagentRowMarker, SubagentMarkerToken> = {
  running: "primary",
  queued: "statusQueued",
  failed: "error",
  done: "success",
}

/** Theme token that colors the marker; the glyph tells the states apart as well as the color. */
export function subagentMarkerToken(marker: SubagentRowMarker): SubagentMarkerToken {
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

/** Where a row's facts come from: the data layer's Task links, job states and summaries, by session. */
export interface SubagentRowSource {
  /** The parent's Task link of a child session, as `taskIndex` keeps it. */
  task(
    sessionID: string,
  ): Pick<TaskIndexEntry, "kind" | "description" | "background" | "initiator" | "startedAt" | "result"> | undefined
  summary(
    sessionID: string,
  ): Pick<SessionSummary, "status" | "toolCalls" | "startedAt" | "lastActivityAt" | "error"> | undefined
  /** The state of the job a background run owns; a run without one (or a source that has none) reads as unknown. */
  job?(sessionID: string): BackgroundJob | undefined
}

/** The source the data layer makes: what `sync.data` holds of the Task links, the job mirror and the summaries. */
export function subagentSource(data: {
  readonly taskIndex: Readonly<Record<string, TaskIndexEntry | undefined>>
  readonly summary: Readonly<Record<string, SessionSummary | undefined>>
  readonly lifecycle: Readonly<Record<string, BackgroundJob | undefined>>
}): SubagentRowSource {
  return {
    task: (id) => data.taskIndex[id],
    summary: (id) => data.summary[id],
    job: (id) => data.lifecycle[lifecycleKey({ domain: "job", id })],
  }
}

/**
 * The three groups of the list, in the order they are shown: runs that go on in the background (running, queued, or
 * not known yet), runs the main agent waits for, and everything else (the runs that ended, and the sessions whose
 * state is not known, which are not claimed to run).
 */
export type SubagentGroup = "background" | "foreground" | "finished"

const GROUP_RANK: Record<SubagentGroup, number> = { background: 0, foreground: 1, finished: 2 }

const GROUP_KEYS: Record<SubagentGroup, MessageKey> = {
  background: "background.agents.group.background",
  foreground: "background.agents.group.foreground",
  finished: "background.agents.group.finished",
}

/** The heading of a group. */
export function subagentGroupTitle(group: SubagentGroup): string {
  return t(GROUP_KEYS[group])
}

export interface SubagentRow {
  readonly id: string
  readonly kind: string
  readonly description: string
  /** Undefined while no state is known (a cold start): the row draws no glyph and says `—`. */
  readonly marker: SubagentRowMarker | undefined
  /** Running again after an error: the marker is still running, the text says why it is slow. */
  readonly retrying: boolean
  /** Unknown (undefined) until a tool was seen: a cold start has no count, and must not say 0. */
  readonly toolCalls: number | undefined
  readonly startedAt: number
  /** The end, for a sub-agent that is over; undefined while it runs or waits, when the clock ends it. */
  readonly endedAt: number | undefined
  /** Whether the run goes on in the background: started there, or moved there while it ran. */
  readonly background: boolean
  /** How a background run stands, as `backgroundStatus` decides it; undefined for a run that is not one. */
  readonly status: BackgroundStatus | undefined
  /** Who asked for the run; unknown (undefined) without a Task link. */
  readonly initiator: "user" | "agent" | undefined
  readonly group: SubagentGroup
  /** What the server reported of a finished background run, once it reported. */
  readonly result: BackgroundResult | undefined
  /** The first line of the error the sub-agent's own session ended with. */
  readonly error: string | undefined
}

const BACKGROUND_MARKERS: Record<BackgroundStatus, SubagentRowMarker | undefined> = {
  running: "running",
  queued: "queued",
  completed: "done",
  // A run that did not finish is drawn as a failure; the word beside the glyph says which way.
  error: "failed",
  interrupted: "failed",
  cancelled: "failed",
  unknown: undefined,
}

const MAX_REASON = 160

/** The first line of a text that has any, as one displayable line, cut to a length a sentence can carry. */
function firstLine(text: string | undefined): string | undefined {
  for (const line of (text ?? "").split(/\r?\n/)) {
    const clean = remoteLine(line).replace(/\s+/g, " ")
    if (!clean) continue
    const chars = Array.from(clean)
    return chars.length > MAX_REASON ? `${chars.slice(0, MAX_REASON - 1).join("")}…` : clean
  }
  return undefined
}

/** Where a row stands in its group: a running background run comes before a queued one, and a queued before an unknown. */
function groupOf(
  status: BackgroundStatus | undefined,
  marker: SubagentRowMarker | undefined,
): { group: SubagentGroup; rank: number } {
  if (status === undefined) return { group: marker === "running" ? "foreground" : "finished", rank: 0 }
  switch (status) {
    case "running":
      return { group: "background", rank: 0 }
    case "queued":
      return { group: "background", rank: 1 }
    case "unknown":
      return { group: "background", rank: 2 }
    default:
      return { group: "finished", rank: 0 }
  }
}

function buildRow(session: SubagentSessionInfo, source: SubagentRowSource): { row: SubagentRow; rank: number } {
  const task = source.task(session.id)
  const summary = source.summary(session.id)
  const link = task?.background === true ? task : undefined
  const status = link ? backgroundStatus({ entry: link, job: source.job?.(session.id), summary }) : undefined
  const marker = status === undefined ? subagentMarker(summary) : BACKGROUND_MARKERS[status]
  const result = link?.result
  const { group, rank } = groupOf(status, marker)
  const row: SubagentRow = {
    id: session.id,
    kind: subagentKind(session, task),
    description: subagentDescription(session, task),
    marker,
    retrying: summary?.status === "retry",
    toolCalls: summary?.toolCalls,
    // A background run is timed by the Task call that started it (a resumed task has a session far older than its run),
    // and by the server's own span once it reported one.
    startedAt: result?.startedAt ?? link?.startedAt ?? summary?.startedAt ?? session.time.created,
    // `lastActivityAt` is 0 in a summary made from a bare event; the session's own update time then stands in.
    endedAt:
      marker === "running" || marker === "queued"
        ? undefined
        : (result?.endedAt ?? Math.max(summary?.lastActivityAt ?? 0, session.time.updated)),
    background: link !== undefined,
    status,
    initiator: task === undefined ? undefined : task.initiator === "user" ? "user" : "agent",
    group,
    result,
    error: firstLine(summary?.error),
  }
  return { row, rank }
}

/** Group, then the order inside it, then newest start first; the id settles a tie, so the order never depends on the store's. */
function listOrder(left: { row: SubagentRow; rank: number }, right: { row: SubagentRow; rank: number }): number {
  const group = GROUP_RANK[left.row.group] - GROUP_RANK[right.row.group]
  if (group !== 0) return group
  if (left.rank !== right.rank) return left.rank - right.rank
  if (left.row.startedAt !== right.row.startedAt) return right.row.startedAt - left.row.startedAt
  return left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0
}

function placed<T extends SubagentSessionInfo>(
  sessions: readonly T[],
  parentID: string,
  source: SubagentRowSource,
): { session: T; row: SubagentRow; rank: number }[] {
  return childSessions(sessions, parentID)
    .map((session) => ({ session, ...buildRow(session, source) }))
    .toSorted(listOrder)
}

/**
 * The direct children of `rootID` as rows, in the order of the list: the background runs (running, queued, not known
 * yet), the foreground runs that still run, then everything else; newest start first inside a group. This is the
 * order `←→` walks and `i/N` counts too (`subagentSiblings`). Deeper descendants are not listed; the sessions a root
 * starts (Task sub-agents and DAG node sessions) are all its children.
 */
export function subagentRows(
  sessions: readonly SubagentSessionInfo[],
  rootID: string,
  source: SubagentRowSource,
): SubagentRow[] {
  return placed(sessions, rootID, source).map((entry) => entry.row)
}

/** The sessions whose parent is `parentID`, in the order of the list. Returns a new array. */
export function subagentChildren<T extends SubagentSessionInfo>(
  sessions: readonly T[],
  parentID: string,
  source: SubagentRowSource,
): T[] {
  return placed(sessions, parentID, source).map((entry) => entry.session)
}

/**
 * The sessions that share a parent with `sessionID`, itself included, in the order of the list. A session that is
 * unknown or has no parent has no siblings: a root session is not a sub-agent.
 */
export function subagentSiblings<T extends SubagentSessionInfo>(
  sessions: readonly T[],
  sessionID: string,
  source: SubagentRowSource,
): T[] {
  const parentID = sessions.find((session) => session.id === sessionID)?.parentID
  return parentID ? subagentChildren(sessions, parentID, source) : []
}

/** `kind · description`: how a sub-agent is named in a row and in the text sent to the main agent. */
export function subagentTitle(row: Pick<SubagentRow, "kind" | "description">): string {
  return `${row.kind} · ${row.description}`
}

const MARKER_KEYS: Record<SubagentRowMarker, MessageKey> = {
  running: "subagent.state.running",
  queued: "background.agents.status.queued",
  done: "subagent.state.done",
  failed: "subagent.state.failed",
}

/** What a background run's status says in a row; a status that matches a foreground state uses its word. */
const STATUS_KEYS: Record<Exclude<BackgroundStatus, "unknown">, MessageKey> = {
  running: "subagent.state.running",
  queued: "background.agents.status.queued",
  completed: "subagent.state.done",
  error: "subagent.state.failed",
  interrupted: "background.agents.status.interrupted",
  cancelled: "background.agents.status.cancelled",
}

/** Stands where a state, a tool count, a time or an initiator is not known. */
const UNKNOWN = "—"

/** Time spent: from the start to the end, or to `now` while it runs. */
export function subagentElapsed(row: Pick<SubagentRow, "startedAt" | "endedAt">, now: number): string {
  return formatDagDuration(row.startedAt, row.endedAt ?? now) ?? UNKNOWN
}

/** The word for how a row stands (`—` when unknown). */
function stateWord(row: Pick<SubagentRow, "marker" | "retrying" | "status">): string {
  if (!row.marker) return UNKNOWN
  if (row.marker === "running" && row.retrying) return t("subagent.state.retrying")
  return t(row.status && row.status !== "unknown" ? STATUS_KEYS[row.status] : MARKER_KEYS[row.marker])
}

/**
 * The state word (`—` when unknown), the tool count (`—` when unknown) and the time, as a row ends. A run that waits
 * for its slot has not started: its time is a dash, and no clock follows it.
 */
export function subagentTrail(
  row: Pick<SubagentRow, "marker" | "retrying" | "status" | "toolCalls" | "startedAt" | "endedAt">,
  now: number,
): string {
  const tools = t("subagent.row.tools", { count: row.toolCalls ?? UNKNOWN })
  const elapsed = row.marker === "queued" ? UNKNOWN : subagentElapsed(row, now)
  return [stateWord(row), tools, elapsed].join(" · ")
}

/** Who asked for the run; a dash for a session no Task call started (a DAG node's). */
export function subagentInitiatorText(row: Pick<SubagentRow, "initiator">): string {
  if (row.initiator === undefined) return UNKNOWN
  return t(row.initiator === "user" ? "background.row.byUser" : "background.row.byAgent")
}

/** `n · a background running · q queued`, as the heading of the list says it; a part that is zero is left out. */
export function subagentCountText(rows: readonly Pick<SubagentRow, "background" | "status">[]): string {
  if (rows.length === 0) return ""
  const running = rows.filter((row) => row.background && row.status === "running").length
  const queued = rows.filter((row) => row.background && row.status === "queued").length
  return [
    t("background.agents.count", { n: rows.length }),
    ...(running > 0 ? [t("background.agents.count.running", { n: running })] : []),
    ...(queued > 0 ? [t("background.agents.count.queued", { n: queued })] : []),
  ].join(" · ")
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

/** What the server writes around the report of a background run: `<task_result>…</task_result>`, or `<task_error>`. */
const RESULT_BODY = /<task_(?:result|error)>([\s\S]*?)<\/task_(?:result|error)>/

/**
 * The first line of what a finished background run reported, out of the text of the message the server added to the
 * parent session: the body between the result tags, so the notice around it is not taken for the report. Undefined
 * while the text is not loaded or the report has none.
 */
export function backgroundResultLine(text: string | undefined): string | undefined {
  return firstLine(text === undefined ? undefined : RESULT_BODY.exec(text)?.[1])
}

/**
 * The lines under the selected row of the list: what the sub-agent was asked (`prompt`, which is the Task description
 * until its session is loaded), and for a background run that is over whether its report reached the main session. A
 * run the server reported on shows the first line of the report when `resultText` (its message) is loaded; a run that
 * was interrupted and left no report says it did not come back.
 */
export function subagentDetail(
  row: Pick<SubagentRow, "description" | "background" | "status" | "result">,
  input: { prompt: string | undefined; resultText: string | undefined },
): string[] {
  const lines = [t("subagent.panel.prompt", { text: input.prompt ?? row.description })]
  if (!row.background) return lines
  if (row.result) {
    const report = backgroundResultLine(input.resultText)
    lines.push(
      [
        report === undefined ? undefined : t("background.agents.result", { text: report }),
        t("background.agents.delivered"),
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
    )
  } else if (row.status === "interrupted") {
    lines.push(t("background.agents.notDelivered"))
  }
  return lines
}

/**
 * The request that asks the main agent to deal with a sub-agent. It stops at a colon, where the user goes on writing;
 * it is only put in the main session's input, never sent (`session/prefill.ts`). The text depends on how the run
 * stands: a background run that goes on is asked to be cancelled (with the task tool, by its `task_id`), one that
 * finished to be continued from, one that did not finish to be judged for a new run; any other is the plain request.
 */
export function subagentRelayText(
  row: Pick<SubagentRow, "id" | "kind" | "description" | "background" | "status" | "error">,
): string {
  const { description } = row
  if (row.background) {
    switch (row.status) {
      case "running":
      case "queued":
        return t("background.prefill.cancel", { description, id: row.id })
      case "completed":
        return t("background.prefill.continue", { description })
      case "error":
      case "interrupted":
      case "cancelled":
        return t("background.prefill.retry", { description, reason: row.error ?? t(STATUS_KEYS[row.status]) })
    }
  }
  return t("subagent.relay.prefill", { source: subagentTitle(row) })
}
