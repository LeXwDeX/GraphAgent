// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { MessageV2 } from "../message-v2"
import type { SessionID } from "../schema"
import { freeze, type FrozenHistory } from "./freeze"
import {
  forgetEntry,
  markDirty,
  storeEntry,
  touchEntry,
  versionOf,
  type HistoryEntry,
  type HistoryState,
} from "./state"

/**
 * Database side of the write-through history cache (Issue #1022, PR3).
 *
 * `get` is the read entry point: a clean entry at the current process write
 * version costs no SQL, and any other state reloads the raw retained tail. A
 * reload is fenced twice: the process event counter and the connection-local
 * `PRAGMA data_version` are sampled before and after the paged read, so a write
 * that lands between pages (from this process or another connection) cannot
 * produce a snapshot that is later trusted as stable.
 *
 * `checkExternal` is the cross-connection fence used under the prompt lock. It
 * always costs exactly one `PRAGMA data_version` when the entry has a baseline,
 * and reloads only when the value moved.
 *
 * Residual window: a write through the same connection that bypasses
 * `EventV2` never reaches `applyCommitted`, so neither fence observes it. Such
 * writers must call [`invalidate`] (wired through the session runtime) or write
 * through `Session.updateMessage` / `updatePart` like the rest of the engine.
 */

export const HISTORY_CACHE_BYTES = 32 * 1024 * 1024

export interface CacheDeps {
  readonly database: Database.Interface
  /** Test seam for the paged retained-tail read. */
  readonly collect?: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts[]>
  /** Test seam for the per-connection external-write fence. */
  readonly dataVersion?: (database: Database.Interface) => Effect.Effect<number>
  /** Test seam for the cached-bytes budget. */
  readonly budgetBytes?: number
}

export interface Snapshot {
  readonly history: FrozenHistory
  /** Process write version this snapshot was derived at. */
  readonly version: number
  /** False when the reload observed a concurrent write; the content is not usable. */
  readonly stable: boolean
}

export type ExternalCheck = "same" | "reloaded"

const defaultDataVersion = (database: Database.Interface) =>
  database.db.get<{ data_version: number }>(sql`PRAGMA data_version`).pipe(
    Effect.map((row) => row?.data_version ?? 0),
    Effect.orDie,
  )

const readDataVersion = (deps: CacheDeps) => (deps.dataVersion ?? defaultDataVersion)(deps.database)

const collectTail = (deps: CacheDeps, sessionID: SessionID) =>
  (deps.collect ?? MessageV2.collectCompactedTail)(sessionID).pipe(
    Effect.provideService(Database.Service, deps.database),
  )

const estimateBytes = (rows: readonly SessionV1.WithParts[]) =>
  rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0)

const viewOf = (entry: HistoryEntry): FrozenHistory => {
  if (entry.view && entry.viewVersion === entry.version) return entry.view
  entry.view = freeze(MessageV2.filterCompacted(entry.rows))
  entry.viewVersion = entry.version
  return entry.view
}

/** Evict the least recently used entries until the cache fits its byte budget. */
const enforceBudget = (state: HistoryState, keep: SessionID, limit: number) => {
  if (state.bytes <= limit) return
  for (const sessionID of state.entries.keys()) {
    if (state.bytes <= limit) break
    if (sessionID === keep) continue
    forgetEntry(state, sessionID)
  }
}

/**
 * Read the raw retained tail twice-fenced and replace the entry when stable.
 * `v0`/`v1` sample the process event counter around the read; `dv0`/`dv1` do
 * the same for commits by other connections. A concurrent write anywhere in
 * the window means the rows may mix pre- and post-write state, so the entry is
 * marked dirty and the snapshot is flagged unstable.
 */
const reload = (state: HistoryState, deps: CacheDeps, sessionID: SessionID): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    const v0 = versionOf(state, sessionID)
    const dv0 = yield* readDataVersion(deps)
    const rows = yield* collectTail(deps, sessionID)
    const dv1 = yield* readDataVersion(deps)
    const v1 = versionOf(state, sessionID)
    if (v0 !== v1 || dv0 !== dv1) {
      const existing = state.entries.get(sessionID)
      if (existing) markDirty(existing)
      return { history: freeze(MessageV2.filterCompacted(rows)), version: v1, stable: false }
    }
    const entry: HistoryEntry = {
      rows,
      version: v1,
      viewVersion: v1,
      dirty: false,
      bytes: estimateBytes(rows),
      baseline: dv1,
    }
    entry.view = freeze(MessageV2.filterCompacted(rows))
    storeEntry(state, sessionID, entry)
    enforceBudget(state, sessionID, deps.budgetBytes ?? HISTORY_CACHE_BYTES)
    return { history: entry.view, version: v1, stable: true }
  })

/** Drop one session's entry (session deletion or directory disposal). */
export const invalidate = (state: HistoryState, sessionID: SessionID): void => {
  forgetEntry(state, sessionID)
}

/**
 * Read the model-visible tail. A clean entry at the current process version is
 * returned without any SQL; every other state reloads under the double fence.
 */
export const get = (state: HistoryState, deps: CacheDeps, sessionID: SessionID): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    const entry = state.entries.get(sessionID)
    if (entry && !entry.dirty && entry.version === versionOf(state, sessionID)) {
      touchEntry(state, sessionID, entry)
      return { history: viewOf(entry), version: entry.version, stable: true }
    }
    return yield* reload(state, deps, sessionID)
  })

/**
 * Cross-connection freshness fence. Costs exactly one `PRAGMA data_version`
 * when the entry holds a baseline; a moved value (or a missing/dirty entry)
 * reloads the tail and reports `reloaded`.
 */
export const checkExternal = (
  state: HistoryState,
  deps: CacheDeps,
  sessionID: SessionID,
): Effect.Effect<ExternalCheck> =>
  Effect.gen(function* () {
    const entry = state.entries.get(sessionID)
    if (!entry || entry.dirty || entry.baseline === undefined) {
      yield* reload(state, deps, sessionID)
      return "reloaded" as const
    }
    const current = yield* readDataVersion(deps)
    if (current === entry.baseline) return "same" as const
    yield* reload(state, deps, sessionID)
    return "reloaded" as const
  })

export const version = versionOf

export * as HistoryCache from "./cache"
