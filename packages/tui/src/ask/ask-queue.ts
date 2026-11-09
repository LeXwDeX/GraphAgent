// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PermissionRequest, QuestionRequest } from "@graphagent/sdk"
import { createMemo, type Accessor } from "solid-js"
import { useSync } from "../context/sync"

/**
 * One pending user decision. Permission and question entries mirror the server
 * stores; confirm and choice entries are local surfaces resolved by their
 * owning feature. The queue never inspects DAG state: server-side auto
 * adjudication decides what reaches the user.
 */
export type AskRequest =
  | { kind: "permission"; sessionID: string; request: PermissionRequest }
  | { kind: "question"; sessionID: string; request: QuestionRequest }
  | {
      kind: "confirm"
      id: string
      title: string
      body?: string
      confirmLabel: string
      cancelLabel: string
      danger?: boolean
      resolve(ok: boolean): void
    }
  | {
      kind: "choice"
      id: string
      title: string
      body?: string
      options: { id: string; label: string }[]
      resolve(id: string | undefined): void
    }

export interface AskSession {
  id: string
  parentID?: string
  title?: string
}

export interface AskQueueData {
  session: readonly AskSession[]
  permission: Record<string, readonly PermissionRequest[] | undefined>
  question: Record<string, readonly QuestionRequest[] | undefined>
}

export interface AskSourceData {
  session: readonly Pick<AskSession, "id" | "title">[]
  taskIndex: Record<string, { kind?: string; description?: string } | undefined>
}

/** Request id used for ordering, keys, and deduplication. */
export function askRequestID(ask: AskRequest): string {
  return ask.kind === "permission" || ask.kind === "question" ? ask.request.id : ask.id
}

/** Session that owns a permission or question request; local variants have none. */
export function askSessionID(ask: AskRequest): string | undefined {
  return ask.kind === "permission" || ask.kind === "question" ? ask.sessionID : undefined
}

/** Walk the `parentID` chain to the root session. Unknown ids resolve to themselves. */
export function resolveRootSessionID(sessions: readonly Pick<AskSession, "id" | "parentID">[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parentID = byID.get(current)?.parentID
    if (!parentID) break
    current = parentID
  }
  return current
}

/** Root followed by every descendant, including grandchildren, in tree order. */
export function sessionTree(sessions: readonly Pick<AskSession, "id" | "parentID">[], rootSessionID: string) {
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = children.get(session.parentID)
    if (list) list.push(session.id)
    else children.set(session.parentID, [session.id])
  }
  const result: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionID]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

// Ascending ids encode their creation time in the first 12 hex digits after
// the prefix. Pending requests are always fresh, so comparing that stamp gives
// creation order across permission and question ids; synthetic ids fall back
// to lexicographic order.
const ASK_ID_TIME = /^(?:per|que)_([0-9a-f]{12})/

function askOrderKey(id: string) {
  const match = ASK_ID_TIME.exec(id)
  return match ? `1${match[1]}${id}` : `0${id}`
}

/**
 * Pending requests for a root session and all of its descendants. The viewed
 * session may be the root or any descendant; both resolve to the same queue.
 */
export function collectAskQueue(data: AskQueueData, sessionID: string): AskRequest[] {
  if (!sessionID) return []
  const rootSessionID = resolveRootSessionID(data.session, sessionID)
  const requests: AskRequest[] = []
  for (const id of sessionTree(data.session, rootSessionID)) {
    for (const request of data.permission[id] ?? []) requests.push({ kind: "permission", sessionID: id, request })
    for (const request of data.question[id] ?? []) requests.push({ kind: "question", sessionID: id, request })
  }
  return requests.sort((left, right) => {
    const a = askOrderKey(askRequestID(left))
    const b = askOrderKey(askRequestID(right))
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Reactive queue for the session tree that contains `sessionID` (a root id or
 * any descendant). An accessor argument keeps the queue live across session
 * switches.
 */
export function askQueue(sessionID: string | Accessor<string>): Accessor<readonly AskRequest[]> {
  const sync = useSync()
  return createMemo(() => {
    const id = typeof sessionID === "function" ? sessionID() : sessionID
    return collectAskQueue(
      { session: sync.data.session, permission: sync.data.permission, question: sync.data.question },
      id,
    )
  })
}

/**
 * Source label shown before permission and question titles when the request
 * comes from a session other than the one being viewed. Task-index entries
 * describe the subagent (`explore · scan for destructive changes`); otherwise
 * the session title is used.
 */
export function askSourceLabel(
  data: AskSourceData,
  requestSessionID: string,
  viewedSessionID: string,
): string | undefined {
  if (requestSessionID === viewedSessionID) return undefined
  const entry = data.taskIndex[requestSessionID]
  const parts = [entry?.kind, entry?.description].filter((value): value is string => Boolean(value))
  if (parts.length > 0) return parts.join(" · ")
  return data.session.find((session) => session.id === requestSessionID)?.title
}
