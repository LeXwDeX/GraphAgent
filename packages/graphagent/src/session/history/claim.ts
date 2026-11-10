// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { MessageV2 } from "../message-v2"
import { MessageID, SessionID } from "../schema"
import type { Session } from "../session"
import { HistoryView } from "./view"

export type ClaimedSnapshot = {
  readonly messages: SessionV1.WithParts[]
  readonly budget: ToolBudget.Budget
}

/**
 * Cache port the claim path relies on. The default binds to the process
 * history view; tests inject an isolated state with their own database.
 */
export interface HistoryPort {
  readonly get: (sessionID: SessionID) => Effect.Effect<HistoryView.Snapshot>
  readonly checkExternal: (sessionID: SessionID) => Effect.Effect<"same" | "reloaded">
  readonly version: (sessionID: SessionID) => number
}

export interface ClaimDeps {
  readonly database: Database.Interface
  readonly sessions: Pick<Session.Interface, "updateMessage">
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly budgetState: (sessionID: SessionID) => Effect.Effect<{
    active?: ToolBudget.Budget
    pending: Map<MessageID, ToolBudget.Budget>
  }>
  readonly maxToolCalls: Effect.Effect<number | undefined>
  /** Test seam for the write-through history cache. */
  readonly history?: HistoryPort
}

const ATTEMPTS = 3

/**
 * Marks the snapshot's unconsumed prompts consumed. The persisted info is a
 * copy of the cached snapshot: the frozen view is never mutated, and the
 * prompt lock plus the version check below mean the snapshot cannot be older
 * than a concurrent edit that would be overwritten. The SessionProjector keeps
 * the greatest `consumed` timestamp anyway, so a stale whole-JSON replacement
 * cannot make a claimed prompt editable again.
 */
const markConsumed = (deps: ClaimDeps, visible: readonly SessionV1.WithParts[]) =>
  Effect.gen(function* () {
    const consumed = Date.now()
    for (const message of visible) {
      if (!HistoryView.isOrdinaryUser(message) || message.info.time.consumed !== undefined) continue
      const source = message.info
      if (source.role !== "user") continue
      const info = { ...source, time: { ...source.time, consumed } } as SessionV1.User
      yield* deps.sessions.updateMessage(info)
    }
  })

/**
 * Budget selection and consumed marking for a verified snapshot. Runs under
 * the prompt lock; it performs no transcript reads, so no writer can interleave
 * between verification and the durable writes.
 */
const commit = (deps: ClaimDeps, sessionID: SessionID, messages: HistoryView.FrozenHistory) =>
  Effect.gen(function* () {
    const visible = messages.filter((message) => !MessageV2.isIgnoredUser(message))
    const state = yield* deps.budgetState(sessionID)
    let latestPending: { message: SessionV1.WithParts; budget: ToolBudget.Budget } | undefined
    for (const message of visible) {
      const budget = state.pending.get(message.info.id)
      if (budget && (!latestPending || MessageV2.before(latestPending.message.info, message.info))) {
        latestPending = { message, budget }
      }
    }
    yield* markConsumed(deps, visible)
    // Activate only inputs included in this snapshot. Capture the budget under
    // the same lock so later admissions cannot replace its owner.
    const budget = latestPending?.budget ?? state.active ?? ToolBudget.create(yield* deps.maxToolCalls)
    state.active = budget
    for (const message of visible) state.pending.delete(message.info.id)
    Object.freeze(visible)
    return { messages: visible, budget } satisfies ClaimedSnapshot
  })

/**
 * Claims the model-visible tail plus the budget for the next request. The read
 * happens outside the prompt lock; the lock only fences freshness and commits
 * the consumed markers:
 *
 * 1. Lock-free `get`: a cold/stale entry reloads under the process and
 *    connection fences; an unstable reload retries.
 * 2. Under the prompt lock, `checkExternal` reads `PRAGMA data_version` once
 *    and reloads the entry if another connection committed since the last
 *    full read.
 * 3. The snapshot is read *again* under the lock (a clean hit costs no SQL).
 *    Another claim may have reloaded the shared entry between steps 1 and 2,
 *    so committing the lock-free snapshot could resurrect state older than
 *    that reload.
 * 4. The snapshot must be stable and still at the current process write
 *    version; otherwise the attempt is stale and retried.
 *
 * After a few failed attempts the claim falls back to a full read under the
 * lock (not cached).
 */
export function makeClaim(deps: ClaimDeps) {
  const history =
    deps.history ??
    ({
      get: (sessionID) => HistoryView.get(sessionID).pipe(Effect.provideService(Database.Service, deps.database)),
      checkExternal: (sessionID) =>
        HistoryView.checkExternal(sessionID).pipe(Effect.provideService(Database.Service, deps.database)),
      version: HistoryView.version,
    } satisfies HistoryPort)

  const attempt = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const initial = yield* history.get(sessionID)
      if (!initial.stable) return undefined
      return yield* deps.promptLocks.withLock(sessionID)(
        Effect.gen(function* () {
          yield* history.checkExternal(sessionID)
          const snapshot = yield* history.get(sessionID)
          if (!snapshot.stable) return undefined
          if (snapshot.version !== history.version(sessionID)) return undefined
          return yield* commit(deps, sessionID, snapshot.history)
        }),
      )
    }).pipe(Effect.provideService(Database.Service, deps.database))

  return Effect.fn("SessionHistory.claim")(function* (sessionID: SessionID): Effect.fn.Return<ClaimedSnapshot> {
    for (let index = 0; index < ATTEMPTS; index++) {
      const claimed = yield* attempt(sessionID)
      if (claimed) return claimed
    }
    yield* Effect.logWarning("session history changed while claiming; re-reading under the prompt lock", {
      "session.id": sessionID,
    })
    return yield* deps.promptLocks
      .withLock(sessionID)(
        Effect.gen(function* () {
          const messages = HistoryView.freeze(yield* MessageV2.filterCompactedEffect(sessionID))
          return yield* commit(deps, sessionID, messages)
        }),
      )
      .pipe(Effect.provideService(Database.Service, deps.database))
  })
}

export * as HistoryClaim from "./claim"
