// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { Schema } from "effect"
import type { SessionID } from "../schema"

/**
 * Process-wide write-through cache for the model-visible transcript tail
 * (Issue #1022, PR3).
 *
 * This module is deliberately free of session-service imports so the event
 * bridge can call [`applyCommitted`] from the post-commit hook without pulling
 * in the session dependency graph. It owns the in-memory shape; `cache.ts` owns
 * the database reads.
 *
 * Each entry keeps the raw retained rows returned by
 * `MessageV2.collectCompactedTail` in replay-walk order (newest first). The
 * frozen model-visible view is derived lazily, because every incremental write
 * replaces at least one row and invalidates a materialized view.
 *
 * Versions are process-level per-session event counters. They survive entry
 * eviction and session deletion so a snapshot taken before an event can never
 * be mistaken for one taken after it; entries only live while they match the
 * counter and the per-connection `PRAGMA data_version` baseline.
 */

export interface HistoryEntry {
  /** Raw retained rows in replay-walk order (newest first). */
  rows: SessionV1.WithParts[]
  /** Lazily derived frozen view of `rows`; dropped on every incremental write. */
  view?: SessionV1.WithParts[]
  /** Write version the view was derived at. */
  viewVersion: number
  /** Process write version at the last full read or applied event. */
  version: number
  /** Entry no longer matches the stored transcript; the next get reloads it. */
  dirty: boolean
  /** Last applied durable event sequence for the incremental-write fence. */
  lastSeq?: number
  /** Approximate retained bytes for LRU accounting. */
  bytes: number
  /** `PRAGMA data_version` observed at the last stable full read. */
  baseline?: number
}

export interface HistoryState {
  readonly entries: Map<SessionID, HistoryEntry>
  /** Process-level per-session event counter; never removed by eviction. */
  readonly versions: Map<SessionID, number>
  /** Approximate retained bytes across entries. */
  bytes: number
}

export function makeHistoryState(): HistoryState {
  return { entries: new Map(), versions: new Map(), bytes: 0 }
}

export function versionOf(state: HistoryState, sessionID: SessionID): number {
  return state.versions.get(sessionID) ?? 0
}

const bump = (state: HistoryState, sessionID: SessionID): number => {
  const next = versionOf(state, sessionID) + 1
  state.versions.set(sessionID, next)
  return next
}

export function forgetEntry(state: HistoryState, sessionID: SessionID): void {
  const entry = state.entries.get(sessionID)
  if (!entry) return
  state.entries.delete(sessionID)
  state.bytes = Math.max(0, state.bytes - entry.bytes)
}

/** Move an entry to the newest position of the insertion-ordered LRU. */
export function touchEntry(state: HistoryState, sessionID: SessionID, entry: HistoryEntry): void {
  state.entries.delete(sessionID)
  state.entries.set(sessionID, entry)
}

/** Replace an entry and update the byte accounting in one step. */
export function storeEntry(state: HistoryState, sessionID: SessionID, entry: HistoryEntry): void {
  forgetEntry(state, sessionID)
  state.entries.set(sessionID, entry)
  state.bytes += entry.bytes
}

export function markDirty(entry: HistoryEntry): void {
  entry.dirty = true
  entry.view = undefined
  entry.baseline = undefined
}

export function invalidateView(entry: HistoryEntry): void {
  entry.view = undefined
}

/** JSON round-trip that mirrors how transcript rows are persisted and read. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const decodeFormat = Schema.decodeUnknownSync(SessionV1.Format)

/**
 * The database read path rehydrates a user prompt's output format from JSON;
 * the cached copy must do the same before consumers treat it as fresh.
 */
function normalizeInfo(info: SessionV1.Info): SessionV1.Info {
  const value = plain(info)
  if (value.role === "user" && value.format) value.format = decodeFormat(value.format)
  return value
}

function normalizePart(part: SessionV1.Part): SessionV1.Part {
  return plain(part)
}

const newer = (a: SessionV1.Info, b: SessionV1.Info) =>
  a.time.created > b.time.created || (a.time.created === b.time.created && a.id > b.id)

/** Fields `filterCompacted` reads from an assistant message to detect a completed compaction summary. */
const boundaryKey = (info: SessionV1.Info) =>
  info.role === "assistant" ? `${info.summary ? 1 : 0}|${info.finish ?? ""}|${info.error ? 1 : 0}|${info.parentID}` : ""

const isCompaction = (part: SessionV1.Part) => part.type === "compaction"

const findMessage = (rows: SessionV1.WithParts[], id: string) => rows.findIndex((row) => row.info.id === id)

const insertPart = (parts: SessionV1.Part[], part: SessionV1.Part) => {
  const index = parts.findIndex((candidate) => candidate.id > part.id)
  if (index < 0) parts.push(part)
  else parts.splice(index, 0, part)
}

export interface TranscriptEvent {
  readonly type: string
  readonly data: unknown
  readonly durable?: { readonly aggregateID: string; readonly seq: number }
}

/**
 * Apply one committed transcript event to the cache. Pure and synchronous: it
 * runs on the post-commit path of every durable publish, so it must never read
 * the database. Events that cannot be applied incrementally mark the entry
 * dirty; the next read reloads it under the double fence in `cache.ts`.
 *
 * The sequence fence treats any non-consecutive sequence as a gap, including
 * out-of-order delivery: `afterCommit` callbacks from different transactions or
 * fibers are not ordered, so applying a later event then an earlier one would
 * permanently lose the earlier write.
 */
export function applyCommitted(state: HistoryState, event: TranscriptEvent): void {
  const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID
  if (typeof sessionID !== "string") return
  const id = sessionID as SessionID
  const known =
    event.type === SessionV1.Event.MessageUpdated.type ||
    event.type === SessionV1.Event.MessageRemoved.type ||
    event.type === SessionV1.Event.PartUpdated.type ||
    event.type === SessionV1.Event.PartRemoved.type ||
    event.type === SessionV1.Event.Deleted.type
  if (!known) return
  // Every observed transcript event advances the counter before any fence, so
  // a snapshot taken before it can never match afterwards, even when the entry
  // ends up dirty or the event is discarded as a duplicate/gap.
  const version = bump(state, id)
  const entry = state.entries.get(id)
  if (event.type === SessionV1.Event.Deleted.type) {
    forgetEntry(state, id)
    return
  }
  if (!entry) return
  const seq = event.durable?.seq
  if (seq === undefined) return
  if (entry.lastSeq === seq) return
  if (entry.lastSeq !== undefined && seq !== entry.lastSeq + 1) {
    markDirty(entry)
    return
  }
  if (entry.dirty) {
    entry.version = version
    return
  }
  const applied = applyEvent(entry, event)
  if (!applied) {
    markDirty(entry)
    return
  }
  entry.lastSeq = seq
  entry.version = version
  invalidateView(entry)
}

/** Applies one event to a clean entry. Returns false when it cannot be applied incrementally. */
function applyEvent(entry: HistoryEntry, event: TranscriptEvent): boolean {
  switch (event.type) {
    case SessionV1.Event.MessageUpdated.type: {
      const info = normalizeInfo((event.data as { info: SessionV1.Info }).info)
      const index = findMessage(entry.rows, info.id)
      if (index < 0) {
        // `collectCompactedTail` only returns the retained tail, so a message
        // that is not in it is either brand new or older than the tail. An
        // empty entry can only be an empty session, where the first message is
        // by definition new; otherwise only a newer sort key is a new message.
        const head = entry.rows[0]
        if (head && !newer(info, head.info)) return false
        entry.rows.unshift({ info, parts: [] })
        return true
      }
      const previous = entry.rows[index]!
      if (info.role === "assistant" && boundaryKey(previous.info) !== boundaryKey(info)) return false
      if (info.role === "user" && previous.info.role === "user") {
        // Mirror SessionProjector exactly: a missing `consumed` on both sides
        // stays missing (a brand-new prompt is not a consumed receipt).
        const previousTime = previous.info.time
        const nextTime = info.time as SessionV1.User["time"]
        if (nextTime.consumed !== undefined || previousTime.consumed !== undefined) {
          info.time = { ...nextTime, consumed: Math.max(nextTime.consumed ?? 0, previousTime.consumed ?? 0) }
        }
      }
      entry.rows[index] = { info, parts: previous.parts }
      return true
    }
    case SessionV1.Event.MessageRemoved.type: {
      // A removal can erase the compaction boundary message or a completed
      // summary, which reorders the visible tail; always reload.
      return false
    }
    case SessionV1.Event.PartUpdated.type: {
      const part = normalizePart((event.data as { part: SessionV1.Part }).part)
      const index = findMessage(entry.rows, part.messageID)
      if (index < 0) return true
      const message = entry.rows[index]!
      const previous = message.parts.find((candidate) => candidate.id === part.id)
      if (isCompaction(part) || (previous && isCompaction(previous))) return false
      // Copy-on-write: the frozen view may still be held by a caller, and its
      // `parts` array is frozen. Never mutate a message shared with a snapshot.
      const parts = [...message.parts]
      const position = parts.findIndex((candidate) => candidate.id === part.id)
      if (position >= 0) parts[position] = part
      else insertPart(parts, part)
      entry.rows[index] = { info: message.info, parts }
      return true
    }
    case SessionV1.Event.PartRemoved.type: {
      const { messageID, partID } = event.data as { messageID: string; partID: string }
      const index = findMessage(entry.rows, messageID)
      if (index < 0) return true
      const message = entry.rows[index]!
      const position = message.parts.findIndex((candidate) => candidate.id === partID)
      if (position < 0) return false
      if (isCompaction(message.parts[position]!)) return false
      const parts = [...message.parts]
      parts.splice(position, 1)
      entry.rows[index] = { info: message.info, parts }
      return true
    }
    default:
      return true
  }
}

export * as HistoryState from "./state"
