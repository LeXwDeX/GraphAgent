// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionStatus } from "@graphagent/sdk"

/** #886 5.4: base number of hydrated sessions, excluding the protected parent chain. */
export const HYDRATED_MAX = 4

export type SessionSummaryStatus = "idle" | "busy" | "retry" | "unknown"

export interface SessionSummary {
  id: string
  parentID?: string
  status: SessionSummaryStatus
  /** `undefined` means unknown (cold start); render `—`, not 0. */
  toolCalls?: number
  current?: { tool: string; title?: string }
  startedAt?: number
  lastActivityAt: number
  error?: string
}

/**
 * How a background Task run ended, as the server reports it in the message it adds to the parent session. The Task
 * part itself never learns it: a background part completes as soon as the run starts and is not updated again.
 */
export interface BackgroundResult {
  status: "completed" | "error" | "interrupted"
  /** The Task description the run was started with. */
  title: string
  initiator?: "user" | "agent"
  /** The command the user typed; only a run the user started has one. */
  command?: string
  /** Epoch milliseconds. */
  startedAt: number
  endedAt: number
  /** The message and the text part that carry the notice. */
  messageID: string
  partID: string
}

export interface TaskIndexEntry {
  parentSessionID: string
  parentMessageID: string
  partID: string
  kind?: string
  description?: string
  background?: boolean
  /** Who asked for the run; unset for parts written before the Task tool recorded it. */
  initiator?: "user" | "agent"
  /** The command the user typed; only a run the user started has one. */
  command?: string
  /** A foreground run that was turned into a background one. */
  promoted?: boolean
  /** When the Task tool started (epoch milliseconds, the part's `state.time.start`). */
  startedAt?: number
  /** Written from the result message, never from the Task part; a part write keeps the one held. */
  result?: BackgroundResult
}

export type SessionLike = Pick<Session, "id" | "parentID" | "time">

export interface ToolPartLike {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  tool: string
  state: {
    status: string
    title?: string
    input?: Record<string, any>
    metadata?: Record<string, any>
    time?: { start?: number; end?: number }
  }
}

/** The part of a text part the background result reader looks at. */
export interface TextPartLike {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  synthetic?: boolean
  metadata?: Record<string, unknown>
}

export function summaryStatus(status: SessionStatus | undefined): SessionSummaryStatus {
  if (!status) return "unknown"
  if (status.type === "idle") return "idle"
  if (status.type === "retry") return "retry"
  return "busy"
}

export function createSummary(session: SessionLike, status?: SessionStatus, previous?: SessionSummary): SessionSummary {
  return {
    id: session.id,
    parentID: session.parentID,
    status: status ? summaryStatus(status) : (previous?.status ?? "unknown"),
    toolCalls: previous?.toolCalls,
    current: previous?.current,
    startedAt: session.time.created,
    lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, session.time.updated),
    error: previous?.error,
  }
}

export function mergeSession(previous: SessionSummary | undefined, session: SessionLike): SessionSummary {
  if (!previous) return createSummary(session)
  return {
    ...previous,
    id: session.id,
    parentID: session.parentID,
    startedAt: previous.startedAt ?? session.time.created,
    lastActivityAt: Math.max(previous.lastActivityAt, session.time.updated),
  }
}

const running = (status: SessionSummaryStatus) => status === "busy" || status === "retry"

/**
 * Applies a status change observed at `at`. A session that starts running again from a stop begins a new run, so the
 * error of an earlier run no longer describes it: a sub-agent that failed and then succeeds must not keep its failure
 * mark. A run that stops ends at `at`: the time it spent writing its last answer, with no tool call or session update
 * to mark it, is part of the run.
 */
export function mergeStatus(
  previous: SessionSummary | undefined,
  id: string,
  status: SessionStatus,
  at?: number,
): SessionSummary {
  const base: SessionSummary = previous ?? { id, status: "unknown", lastActivityAt: 0 }
  const next = summaryStatus(status)
  // The store merges a written summary into the stored one, so the error is cleared by an explicit `undefined`
  // rather than by leaving the key out.
  if (running(next) && !running(base.status)) return { ...base, status: next, error: undefined }
  if (!running(next) && running(base.status) && at !== undefined) {
    return { ...base, status: next, lastActivityAt: Math.max(base.lastActivityAt, at) }
  }
  return { ...base, status: next }
}

export function mergeToolPart(
  previous: SessionSummary | undefined,
  part: ToolPartLike,
  seen: Set<string>,
  at?: number,
): SessionSummary {
  const base: SessionSummary = previous ?? { id: part.sessionID, status: "unknown", lastActivityAt: 0 }
  let toolCalls = base.toolCalls
  if (!seen.has(part.id)) {
    seen.add(part.id)
    toolCalls = (toolCalls ?? 0) + 1
  }
  const title = part.state.title
  const current =
    title !== undefined && (part.state.status === "running" || part.state.status === "completed")
      ? { tool: part.tool, title }
      : base.current
  return {
    ...base,
    toolCalls,
    current,
    lastActivityAt: at !== undefined ? Math.max(base.lastActivityAt, at) : base.lastActivityAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== ""
const initiatorOf = (value: unknown): "user" | "agent" | undefined =>
  value === "user" || value === "agent" ? value : undefined

/**
 * Extract the child-session link from a parent's Task tool part. A call that cancels a task
 * (`input.action === "cancel"`) names the child it stops, but it did not start it: it makes no link, so it cannot
 * overwrite the one the starting call made.
 */
export function taskIndexEntry(part: ToolPartLike): { childSessionID: string; entry: TaskIndexEntry } | undefined {
  if (part.tool !== "task") return undefined
  if (part.state.input?.action === "cancel") return undefined
  // `sessionID` is the current key; `sessionId` keeps links for messages
  // persisted before the rename (#1069 P9).
  const metadata = part.state.metadata
  const childSessionID = metadata?.sessionID ?? metadata?.sessionId
  if (typeof childSessionID !== "string" || !childSessionID) return undefined
  const start = part.state.time?.start
  return {
    childSessionID,
    entry: {
      parentSessionID: part.sessionID,
      parentMessageID: part.messageID,
      partID: part.id,
      kind: typeof part.state.input?.subagent_type === "string" ? part.state.input.subagent_type : undefined,
      description: typeof part.state.input?.description === "string" ? part.state.input.description : undefined,
      background: metadata?.background === true,
      initiator: initiatorOf(metadata?.initiator),
      command: nonEmpty(metadata?.command) ? metadata.command : undefined,
      promoted: metadata?.promoted === true ? true : undefined,
      startedAt: finiteTime(start) ? start : undefined,
    },
  }
}

/**
 * Read the result a finished background run left in the message the server added to the parent session
 * (`metadata.backgroundResult` of a synthetic text part). The child, the status, the title and both times must be
 * well formed or the part is not a result; a malformed `initiator` or `command` is left out and the result stays.
 */
export function backgroundResultOf(
  part: TextPartLike,
): { childSessionID: string; result: BackgroundResult } | undefined {
  if (part.type !== "text" || part.synthetic !== true) return undefined
  const raw = part.metadata?.backgroundResult
  if (!isRecord(raw)) return undefined
  const { childSessionID, status, title, initiator, command, startedAt, endedAt } = raw
  if (!nonEmpty(childSessionID) || !nonEmpty(title)) return undefined
  if (status !== "completed" && status !== "error" && status !== "interrupted") return undefined
  if (!finiteTime(startedAt) || !finiteTime(endedAt)) return undefined
  return {
    childSessionID,
    result: {
      status,
      title,
      initiator: initiatorOf(initiator),
      command: nonEmpty(command) ? command : undefined,
      startedAt,
      endedAt,
      messageID: part.messageID,
      partID: part.id,
    },
  }
}

/** A loaded message as the summary rebuild sees it: only its parts matter. */
export interface SnapshotMessage {
  readonly parts: ReadonlyArray<{ readonly id: string; readonly type: string }>
}

export interface SnapshotSummary {
  /** Distinct tool parts in the loaded messages. */
  toolCalls: number
  /** The latest running or completed tool that carries a title. */
  current?: { tool: string; title?: string }
  /** Ids of the counted tool parts; the live reducer de-duplicates against them. */
  toolPartIDs: Set<string>
  /** Links from the session's Task tool parts to the child sessions they started. */
  tasks: Array<{ childSessionID: string; entry: TaskIndexEntry }>
  /** The results of finished background runs, from the messages the server added, oldest first. */
  results: Array<{ childSessionID: string; result: BackgroundResult }>
}

function isToolPart(part: { id: string; type: string }): part is ToolPartLike {
  return part.type === "tool"
}

function isTextPart(part: { id: string; type: string }): part is TextPartLike {
  return part.type === "text"
}

/**
 * Recount a session from its loaded messages (#886 5.4). The event reducer only
 * sees tool parts that arrive live, so a session that was cold or reconnected
 * starts from this scan instead of from a count that missed history. The same
 * scan finds the Task links and the results of finished background runs.
 * Messages are read oldest first, like the store keeps them.
 */
export function summarizeMessages(messages: ReadonlyArray<SnapshotMessage>): SnapshotSummary {
  const toolPartIDs = new Set<string>()
  const tasks: SnapshotSummary["tasks"] = []
  const results: SnapshotSummary["results"] = []
  let current: SnapshotSummary["current"]
  for (const message of messages) {
    for (const part of message.parts) {
      if (isTextPart(part)) {
        const result = backgroundResultOf(part)
        if (result) results.push(result)
        continue
      }
      if (!isToolPart(part)) continue
      toolPartIDs.add(part.id)
      // Same rule as `mergeToolPart`: pending and failed tools never become "current".
      const title = part.state.title
      if (title !== undefined && (part.state.status === "running" || part.state.status === "completed")) {
        current = { tool: part.tool, title }
      }
      const task = taskIndexEntry(part)
      if (task) tasks.push(task)
    }
  }
  return { toolCalls: toolPartIDs.size, current, toolPartIDs, tasks, results }
}

/**
 * Apply a recount to the stored summary; status and times stay with the event
 * reducer. `complete` says the loaded messages are the whole history, so their
 * count replaces whatever events accumulated (a missed event, a reverted tool).
 * A window cut at the message limit omits older tool parts and can only raise
 * the count; without any evidence the count stays unknown rather than 0.
 */
export function mergeSnapshot(
  previous: SessionSummary | undefined,
  id: string,
  snapshot: SnapshotSummary,
  complete: boolean,
): SessionSummary {
  const base: SessionSummary = previous ?? { id, status: "unknown", lastActivityAt: 0 }
  const floor = Math.max(base.toolCalls ?? 0, snapshot.toolCalls)
  return {
    ...base,
    toolCalls: complete ? snapshot.toolCalls : floor === 0 ? base.toolCalls : floor,
    current: snapshot.current ?? (complete ? undefined : base.current),
  }
}
