// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** What the sibling functions read of a session; the SDK `Session` satisfies it. */
export interface SiblingSession {
  readonly id: string
  readonly parentID?: string
  readonly time: { readonly created: number }
}

/**
 * `(time.created, id)` ascending: the order sessions were made in, which is stable whatever their state. The sub-agent
 * keys and the `/agents` list do not walk it but the grouped order of `subagentChildren` (`session/subagents.ts`),
 * which starts from this one.
 */
function creationOrder(a: SiblingSession, b: SiblingSession): number {
  if (a.time.created !== b.time.created) return a.time.created < b.time.created ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * The sessions whose parent is `parentID`, oldest first: by `time.created`, and by `id` when two were created at the
 * same instant, so the order never depends on how the list happens to be stored. Returns a new array.
 */
export function childSessions<T extends SiblingSession>(sessions: readonly T[], parentID: string): T[] {
  return sessions.filter((session) => session.parentID === parentID).toSorted(creationOrder)
}

/**
 * The sessions that share a parent with `sessionID`, itself included, in `childSessions` order. A session that is
 * unknown or has no parent has no siblings: a root session is not a sub-agent.
 */
export function siblingSessions<T extends SiblingSession>(sessions: readonly T[], sessionID: string): T[] {
  const parentID = sessions.find((session) => session.id === sessionID)?.parentID
  return parentID ? childSessions(sessions, parentID) : []
}

/**
 * The sibling `direction` steps after (1) or before (-1) `sessionID`, wrapping around at both ends. Undefined when
 * `sessionID` is not in the list or is the only one in it.
 */
export function nextSibling<T extends { readonly id: string }>(
  siblings: readonly T[],
  sessionID: string,
  direction: 1 | -1,
): T | undefined {
  const index = siblings.findIndex((session) => session.id === sessionID)
  if (index < 0 || siblings.length < 2) return undefined
  return siblings[(index + direction + siblings.length) % siblings.length]
}

/** Where `sessionID` stands among `siblings`; `index` counts from 1. Undefined when it is not one of them. */
export function siblingPosition(
  siblings: readonly { readonly id: string }[],
  sessionID: string,
): { index: number; total: number } | undefined {
  const index = siblings.findIndex((session) => session.id === sessionID)
  return index < 0 ? undefined : { index: index + 1, total: siblings.length }
}
