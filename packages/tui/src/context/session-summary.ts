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

export interface TaskIndexEntry {
  parentSessionID: string
  parentMessageID: string
  partID: string
  kind?: string
  description?: string
  background?: boolean
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
  }
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

export function mergeStatus(previous: SessionSummary | undefined, id: string, status: SessionStatus): SessionSummary {
  return {
    ...(previous ?? { id, status: "unknown" as const, lastActivityAt: 0 }),
    status: summaryStatus(status),
  }
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

/** Extract the child-session link from a parent's Task tool part. */
export function taskIndexEntry(part: ToolPartLike): { childSessionID: string; entry: TaskIndexEntry } | undefined {
  if (part.tool !== "task") return undefined
  // `sessionID` is the current key; `sessionId` keeps links for messages
  // persisted before the rename (#1069 P9).
  const childSessionID = part.state.metadata?.sessionID ?? part.state.metadata?.sessionId
  if (typeof childSessionID !== "string" || !childSessionID) return undefined
  return {
    childSessionID,
    entry: {
      parentSessionID: part.sessionID,
      parentMessageID: part.messageID,
      partID: part.id,
      kind: typeof part.state.input?.subagent_type === "string" ? part.state.input.subagent_type : undefined,
      description: typeof part.state.input?.description === "string" ? part.state.input.description : undefined,
      background: part.state.metadata?.background === true,
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
}

function isToolPart(part: { id: string; type: string }): part is ToolPartLike {
  return part.type === "tool"
}

/**
 * Recount a session from its loaded messages (#886 5.4). The event reducer only
 * sees tool parts that arrive live, so a session that was cold or reconnected
 * starts from this scan instead of from a count that missed history. Messages
 * are read oldest first, like the store keeps them.
 */
export function summarizeMessages(messages: ReadonlyArray<SnapshotMessage>): SnapshotSummary {
  const toolPartIDs = new Set<string>()
  const tasks: SnapshotSummary["tasks"] = []
  let current: SnapshotSummary["current"]
  for (const message of messages) {
    for (const part of message.parts) {
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
  return { toolCalls: toolPartIDs.size, current, toolPartIDs, tasks }
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
