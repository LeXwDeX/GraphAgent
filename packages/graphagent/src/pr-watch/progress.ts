// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as PrWatchProgress from "./progress"

import type { Database } from "@graphagent/core/database/database"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { isTerminalValue } from "@graphagent/core/lifecycle/vocabulary"
import { PrWatchEvent } from "@graphagent/schema/pr-watch-event"
import { and, desc, eq, gte, inArray, or } from "drizzle-orm"
import { Cause, Clock, Effect } from "effect"
import { GlobalBus } from "@/bus/global"
import { EngineProcess, type PrWatchProgressSlot } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { isDeliverableOutcome, safeReview, type CheckCounts } from "./forge"
import { PrWatchStore as Store } from "./store"

/**
 * Live progress of PR/MR watches for status lines (#1036).
 *
 * The durable `pr_watch` row (#1071) stays the authority for a watch's phase,
 * outcome and head; this module adds what a status line needs between
 * lifecycle edges — check counts, the sanitized review state and the delivery
 * record — and publishes it as the transient `pr.watch.updated` on GlobalBus,
 * the path `dag.workflow.summary.updated` takes. The poller and the inbox
 * source call `observe` after each durable write; neither depends on the bus,
 * and publishing never fails or slows a poll.
 *
 * Deduplication: an entry's signature covers every displayed field (phase,
 * outcome, counts, head, review, delivery) and excludes `updatedAt`, so a
 * watch polled ten times with the same snapshot publishes once. Nothing here
 * reads the forge; the poller's `gh`/`glab` cadence is unchanged.
 *
 * The cache is process-level and lazily pruned on every write and read: a
 * terminal entry is kept `RETAIN_MS` after its last update, and any entry is
 * dropped once its watch is `RETAIN_MS` past its deadline. No timer runs. A
 * restart loses the cache; `list` then answers from the rows alone.
 */

/** How long a finished watch stays readable (and cached) after its last update. */
export const RETAIN_MS = 10 * 60_000

type Db = Database.Interface["db"]
type Entry = PrWatchEvent.Entry
type Delivery = PrWatchEvent.Delivery

/** The row columns an entry is built from; a just-built insert value qualifies too. */
export interface RowLike {
  readonly id: string
  readonly session_id: string
  readonly forge: string
  readonly url: string
  readonly number: number
  readonly phase: string
  readonly outcome?: string | null
  readonly head?: string | null
  readonly baseline_review?: string | null
  readonly delivery?: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly deadline_at: number
}

/** What a caller observed beyond the row: the snapshot's counts and review, or the committed notice. */
export interface Observation {
  readonly checks?: CheckCounts
  readonly review?: string
  readonly delivery?: Delivery
}

const PHASES: ReadonlySet<string> = new Set(PrWatchEvent.Phase.literals)

const isPhase = (value: string): value is PrWatchEvent.Phase => PHASES.has(value)

const slots = (): Map<string, PrWatchProgressSlot> => EngineProcess.prWatch.progress

/** The delivery a row implies: owed while `delivering`, delivered once a settled phase carries the mark. */
const deliveryOf = (row: RowLike): Delivery | undefined => {
  if (row.phase === "delivering") return { state: "pending" }
  if (row.phase === "cancelled" || !isTerminalValue("pr_watch", row.phase) || !row.delivery) return undefined
  // The mark commits inside the admission transaction; without the cached
  // notice (another process delivered it, or this one restarted) the row's
  // write time is the closest record of the delivery.
  return { state: "delivered", deliveredAt: row.updated_at }
}

/** One row as an entry, or undefined for a phase outside the `pr_watch` vocabulary. */
export const entryOf = (row: RowLike, observed: Observation = {}): Entry | undefined => {
  if (!isPhase(row.phase)) return undefined
  const outcome = row.outcome ?? null
  const review = observed.review ?? row.baseline_review ?? undefined
  const implied = deliveryOf(row)
  const delivery =
    implied && observed.delivery?.state === implied.state ? { ...implied, ...observed.delivery } : implied
  return {
    sessionID: SessionID.make(row.session_id),
    watchID: row.id,
    url: row.url,
    provider: row.forge === "gitlab" ? "gitlab" : "github",
    number: row.number,
    phase: row.phase,
    ...(isDeliverableOutcome(outcome) ? { outcome } : {}),
    ...(observed.checks ? { checks: { ...observed.checks } } : {}),
    ...(row.head ? { head: row.head } : {}),
    ...(review !== undefined ? { review: safeReview(review) } : {}),
    startedAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    ...(delivery ? { delivery } : {}),
  }
}

/**
 * Fills what the newer entry does not know from the last cached one: the
 * counts and review of the latest read, and the notice details of a delivery
 * in the same state. Phase, outcome and head always come from the newer entry.
 * Within one delivery state the cached details win: they were taken from the
 * committed notice, while a row-derived `deliveredAt` is only the row's write
 * time.
 */
const withKnown = (next: Entry, prev: Entry | undefined): Entry => {
  if (!prev) return next
  const delivery =
    next.delivery && prev.delivery?.state === next.delivery.state
      ? { ...next.delivery, ...prev.delivery }
      : next.delivery
  return {
    ...next,
    ...(next.checks === undefined && prev.checks ? { checks: prev.checks } : {}),
    ...(next.review === undefined && prev.review !== undefined ? { review: prev.review } : {}),
    ...(delivery ? { delivery } : {}),
  }
}

/** Every displayed field, in a fixed order; `updatedAt` is excluded so an unchanged poll is a duplicate. */
export const signatureOf = (entry: Entry): string =>
  JSON.stringify([
    entry.phase,
    entry.outcome ?? null,
    entry.checks ? [entry.checks.total, entry.checks.pending, entry.checks.failed, entry.checks.passed] : null,
    entry.head ?? null,
    entry.review ?? null,
    entry.delivery
      ? [
          entry.delivery.state,
          entry.delivery.deliveredAt ?? null,
          entry.delivery.noticeMessageID ?? null,
          entry.delivery.noReply ?? false,
        ]
      : null,
  ])

const expired = (entry: Entry, now: number) =>
  (isTerminalValue("pr_watch", entry.phase) && entry.updatedAt < now - RETAIN_MS) || entry.deadlineAt < now - RETAIN_MS

/** Lazy cleanup, run on every write and read: no timer owns the cache. */
export const prune = (now: number) => {
  for (const [id, slot] of slots()) if (expired(slot.entry, now)) slots().delete(id)
}

const emit = (entry: Entry, directory: string | undefined) =>
  GlobalBus.emit("event", {
    ...(directory === undefined ? {} : { directory }),
    payload: { type: PrWatchEvent.Updated.type, properties: entry },
  })

/**
 * Records one entry and publishes it when its signature changed. Returns
 * whether an event was emitted. Synchronous and bus-only, so tests can drive
 * it without a database.
 */
export const record = (next: Entry, options: { readonly directory?: string; readonly now: number }): boolean => {
  prune(options.now)
  const slot = slots().get(next.watchID)
  const entry = withKnown(next, slot?.entry)
  const signature = signatureOf(entry)
  const directory = options.directory ?? slot?.directory
  slots().set(entry.watchID, { entry, signature, directory })
  if (slot?.signature === signature) return false
  emit(entry, directory)
  return true
}

/**
 * The poller's and the source's hook: called after a durable write with the
 * row as written plus what the caller observed. Best effort — a failure is
 * logged, never surfaced, so progress cannot break polling or delivery.
 */
export const observe = (db: Db, row: RowLike, observed: Observation = {}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entry = entryOf(row, observed)
    if (!entry) return
    let directory = slots().get(row.id)?.directory
    if (directory === undefined) directory = (yield* Store.sessionOf(db, entry.sessionID))?.directory
    const now = yield* Clock.currentTimeMillis
    record(entry, { ...(directory === undefined ? {} : { directory }), now })
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("pr watch progress publish failed", { watchID: row.id, cause: Cause.pretty(cause) }),
    ),
  )

const LIVE_PHASES = ["watching", "delivering"] as const

/**
 * The session's watches for the read endpoint, newest first: the live ones and
 * those that ended within `RETAIN_MS`. The rows decide phase, outcome and
 * head; this process's cache fills counts, review and notice details.
 */
export const list = (db: Db, sessionID: SessionID): Effect.Effect<Entry[]> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    prune(now)
    const rows = yield* db
      .select()
      .from(PrWatchTable)
      .where(
        and(
          eq(PrWatchTable.session_id, sessionID),
          or(inArray(PrWatchTable.phase, LIVE_PHASES), gte(PrWatchTable.updated_at, now - RETAIN_MS)),
        ),
      )
      .orderBy(desc(PrWatchTable.created_at), desc(PrWatchTable.id))
      .all()
      .pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const entry = entryOf(row)
      return entry ? [withKnown(entry, slots().get(row.id)?.entry)] : []
    })
  })
