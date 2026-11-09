// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionStatus } from "@graphagent/sdk/v2"

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

export function createSummary(
  session: SessionLike,
  status?: SessionStatus,
  previous?: SessionSummary,
): SessionSummary {
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
  const childSessionID = part.state.metadata?.sessionId
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
