// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Schema } from "effect"
import { NotFoundError } from "@/storage/storage"
import { MessageV2 } from "../message-v2"
import { MessageID, SessionID } from "../schema"
import type { Session } from "../session"
import { HistoryView } from "./view"

export type ClaimedSnapshot = {
  readonly messages: SessionV1.WithParts[]
  readonly budget: ToolBudget.Budget
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
  /** Test seam for the bounded tail read. */
  readonly readHistoryView?: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts[]>
}

const ATTEMPTS = 3
const VERIFY_PAGE = 50

/** Order-independent JSON with sorted keys, for comparing two reads of the same row. */
function stable(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`
}

/**
 * Confirms that a snapshot read outside the prompt lock still matches the
 * stored transcript, and returns the fresh copies of the unconsumed prompts
 * that the caller must mark consumed.
 *
 * The check is bounded: it compares the newest stored page (including the
 * snapshot's newest message, which detects appends, reverts, and compaction
 * writes) plus a point re-read of every unconsumed ordinary prompt (which
 * detects queued edits and deletes). Changes older than the page that do not
 * touch an unconsumed prompt are not detected; those require a write-version
 * fence rather than a transcript diff.
 */
const verifyFresh = (sessionID: SessionID, messages: readonly SessionV1.WithParts[]) =>
  Effect.gen(function* () {
    const latest = yield* MessageV2.page({ sessionID, limit: VERIFY_PAGE }).pipe(
      Effect.catchIf(NotFoundError.isInstance, () =>
        Effect.succeed({ items: [] as SessionV1.WithParts[], more: false, cursor: undefined }),
      ),
    )
    const newest = messages.at(-1)
    if (!newest) return latest.items.length === 0 ? new Map<string, SessionV1.WithParts>() : undefined
    const storedNewest = latest.items.at(-1)
    if (!storedNewest || storedNewest.info.id !== newest.info.id) return undefined
    const snapshot = new Map(messages.map((message) => [String(message.info.id), message]))
    for (const item of latest.items) {
      const known = snapshot.get(String(item.info.id))
      if (known && stable(known) !== stable(item)) return undefined
    }
    const fresh = new Map<string, SessionV1.WithParts>()
    for (const message of messages) {
      if (!HistoryView.isOrdinaryUser(message) || message.info.time.consumed !== undefined) continue
      const id = String(message.info.id)
      if (fresh.has(id)) continue
      const stored = yield* MessageV2.get({ sessionID, messageID: message.info.id }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      if (!stored || stable(stored) !== stable(message)) return undefined
      fresh.set(id, stored)
    }
    return fresh
  })

/**
 * Marks the snapshot's unconsumed prompts consumed. The persisted info is a
 * copy of the freshest read: the frozen snapshot is never mutated, and a stale
 * copy cannot overwrite a concurrent edit or delete of the same prompt.
 */
const markConsumed = (
  deps: ClaimDeps,
  sessionID: SessionID,
  visible: readonly SessionV1.WithParts[],
  fresh: ReadonlyMap<string, SessionV1.WithParts> | undefined,
) =>
  Effect.gen(function* () {
    const consumed = Date.now()
    for (const message of visible) {
      if (!HistoryView.isOrdinaryUser(message) || message.info.time.consumed !== undefined) continue
      const source = (fresh?.get(String(message.info.id)) ?? message).info
      if (source.role !== "user") continue
      const info = { ...source, time: { ...source.time, consumed } } as SessionV1.User
      // Persisted JSON loses Schema.Class prototypes. Rehydrate the output
      // format before encoding the consumed user-message event.
      if (info.format) info.format = Schema.decodeUnknownSync(SessionV1.Format)(info.format)
      yield* deps.sessions.updateMessage(info)
    }
  })

/**
 * Budget selection and consumed marking for a verified snapshot. Runs under
 * the prompt lock; it performs no transcript reads, so no writer can interleave
 * between verification and the durable writes.
 */
const commit = (
  deps: ClaimDeps,
  sessionID: SessionID,
  messages: HistoryView.FrozenHistory,
  fresh: ReadonlyMap<string, SessionV1.WithParts> | undefined,
) =>
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
    yield* markConsumed(deps, sessionID, visible, fresh)
    // Activate only inputs included in this snapshot. Capture the budget under
    // the same lock so later admissions cannot replace its owner.
    const budget = latestPending?.budget ?? state.active ?? ToolBudget.create(yield* deps.maxToolCalls)
    state.active = budget
    for (const message of visible) state.pending.delete(message.info.id)
    Object.freeze(visible)
    return { messages: visible, budget } satisfies ClaimedSnapshot
  })

/**
 * Claims the model-visible tail plus the budget for the next request. The tail
 * read happens outside the prompt lock; the lock only verifies freshness and
 * commits the consumed markers. A snapshot that went stale between the read and
 * the lock is re-read, and after a few failed attempts the claim falls back to
 * a full read under the lock.
 */
export function makeClaim(deps: ClaimDeps) {
  const read = (sessionID: SessionID) =>
    (deps.readHistoryView ?? HistoryView.tail)(sessionID).pipe(
      Effect.provideService(Database.Service, deps.database),
    )

  const attempt = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const messages = HistoryView.freeze(yield* read(sessionID))
      return yield* deps.promptLocks.withLock(sessionID)(
        Effect.gen(function* () {
          const fresh = yield* verifyFresh(sessionID, messages)
          if (!fresh) return undefined
          return yield* commit(deps, sessionID, messages, fresh)
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
    return yield* deps.promptLocks.withLock(sessionID)(
      Effect.gen(function* () {
        const messages = HistoryView.freeze(yield* MessageV2.filterCompactedEffect(sessionID))
        return yield* commit(deps, sessionID, messages, undefined)
      }),
    ).pipe(Effect.provideService(Database.Service, deps.database))
  })
}

export * as HistoryClaim from "./claim"