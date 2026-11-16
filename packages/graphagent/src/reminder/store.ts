// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { ReminderTable } from "@graphagent/core/lifecycle/reminder.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { and, asc, eq, exists, inArray, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { ReminderSchedule } from "./schedule"

/**
 * Durable reads and compare-and-swap writes of the `reminder` table (#1072).
 * The row is the only record of a reminder: the clock keeps nothing but the
 * next wake-up time, and the inbox source delivers whatever the row says is
 * owed. Every transition is one guarded UPDATE, so the clock, the source and a
 * cancelling user can race without a lock and exactly one of them wins.
 */

type Db = Database.Interface["db"]

export type Row = typeof ReminderTable.$inferSelect

/** The values a reminder can still change from: it is neither delivered nor cancelled. */
export const LIVE = ["scheduled", "due"] as const

/** The durable delivery key: one notice per reminder and occurrence. */
export const idempotencyKey = (row: Pick<Row, "id" | "fire_at">): string => `${row.id}:${row.fire_at}`

export const insert = (db: Db, values: typeof ReminderTable.$inferInsert): Effect.Effect<Row | undefined> =>
  db.insert(ReminderTable).values(values).onConflictDoNothing().returning().get().pipe(Effect.orDie)

export const rowOf = (db: Db, id: string): Effect.Effect<Row | undefined> =>
  db.select().from(ReminderTable).where(eq(ReminderTable.id, id)).get().pipe(Effect.orDie)

/** The reminders a session still has coming, soonest first. */
export const liveOf = (db: Db, sessionID: string): Effect.Effect<Row[]> =>
  db
    .select()
    .from(ReminderTable)
    .where(and(eq(ReminderTable.session_id, sessionID), inArray(ReminderTable.status, LIVE)))
    .orderBy(asc(ReminderTable.fire_at), asc(ReminderTable.id))
    .all()
    .pipe(Effect.orDie)

/** Scheduled reminders whose time has come, oldest first. */
export const dueRows = (db: Db, now: number, limit: number): Effect.Effect<Row[]> =>
  db
    .select()
    .from(ReminderTable)
    .where(and(eq(ReminderTable.status, "scheduled"), lte(ReminderTable.fire_at, now)))
    .orderBy(asc(ReminderTable.fire_at), asc(ReminderTable.id))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)

/** The clock's one question: when is the earliest scheduled reminder? Undefined when none is. */
export const nextFireAt = (db: Db): Effect.Effect<number | undefined> =>
  db
    .select({ at: sql<number | null>`min(${ReminderTable.fire_at})` })
    .from(ReminderTable)
    .where(eq(ReminderTable.status, "scheduled"))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.at ?? undefined),
    )

/**
 * The clock's compare-and-swap: a scheduled reminder whose time has come
 * becomes `due`. A repeating reminder that missed several occurrences is moved
 * to the latest one, so the restart delivers it once, not once per missed
 * occurrence. Undefined when another clock (or the user) got there first.
 */
export const promote = (db: Db, row: Row, now: number): Effect.Effect<Row | undefined> =>
  db
    .update(ReminderTable)
    .set({
      status: "due",
      fire_at: row.every_ms === null ? row.fire_at : ReminderSchedule.latestOccurrence(row.fire_at, row.every_ms, now),
      updated_at: now,
    })
    .where(
      and(eq(ReminderTable.id, row.id), eq(ReminderTable.status, "scheduled"), eq(ReminderTable.fire_at, row.fire_at)),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)

/**
 * The sessions of one directory that have a reminder still owed: the tick's and
 * the startup scan's single read. The owed rows drive the query (the status
 * index holds them) and each is checked against its session by primary key.
 */
export const owedSessions = (db: Db, directory: string): Effect.Effect<SessionID[]> =>
  db
    .selectDistinct({ id: ReminderTable.session_id })
    .from(ReminderTable)
    .where(
      and(
        eq(ReminderTable.status, "due"),
        exists(
          db
            .select({ one: sql`1` })
            .from(SessionTable)
            .where(and(eq(SessionTable.id, ReminderTable.session_id), eq(SessionTable.directory, directory))),
        ),
      ),
    )
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => SessionID.make(row.id))),
    )

/** The reminders one session is owed, in the order they came due. */
export const owedOf = (db: Db, sessionID: SessionID): Effect.Effect<Row[]> =>
  db
    .select()
    .from(ReminderTable)
    .where(and(eq(ReminderTable.status, "due"), eq(ReminderTable.session_id, sessionID)))
    .orderBy(asc(ReminderTable.fire_at), asc(ReminderTable.id))
    .all()
    .pipe(Effect.orDie)

/** What a delivery needs to know about the session it writes into. */
export interface SessionInfo {
  readonly directory: string
  readonly agent: string | null
}

export const sessionOf = (db: Db, sessionID: string): Effect.Effect<SessionInfo | undefined> =>
  db
    .select({ directory: SessionTable.directory, agent: SessionTable.agent })
    .from(SessionTable)
    // A bound comparison: the row is not guaranteed to hold a valid SessionID,
    // and building the brand would throw instead of missing.
    .where(sql`${SessionTable.id} = ${sessionID}`)
    .get()
    .pipe(Effect.orDie)

/**
 * The delivery's compare-and-swap, run inside the admission transaction that
 * commits the notice. Guarded by the status and the occurrence the caller read,
 * so exactly one of two racing deliveries keeps its message, and a cancellation
 * either wins before the notice or loses to it, never both. A one-shot reminder
 * becomes `delivered`; a repeating one returns to `scheduled` with `fire_at`
 * moved past `now`. False when another delivery or a cancellation already
 * moved the row.
 */
export const markDelivered = (db: Db, row: Row, key: string, now: number): Effect.Effect<boolean> =>
  db
    .update(ReminderTable)
    .set({
      status: row.every_ms === null ? "delivered" : "scheduled",
      fire_at: row.every_ms === null ? row.fire_at : ReminderSchedule.nextOccurrence(row.fire_at, row.every_ms, now),
      delivery: key,
      delivered_at: now,
      updated_at: now,
    })
    .where(and(eq(ReminderTable.id, row.id), eq(ReminderTable.status, "due"), eq(ReminderTable.fire_at, row.fire_at)))
    .returning({ id: ReminderTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((won) => won !== undefined),
    )

/**
 * The user's cancellation: a live reminder of this session becomes `cancelled`.
 * Returns the row as it was (so the caller can publish the right edge) and as
 * it is now, or undefined when the reminder is unknown, belongs to another
 * session, or already finished.
 */
export const cancelLive = (
  db: Db,
  sessionID: string,
  id: string,
  now: number,
): Effect.Effect<{ readonly before: Row; readonly after: Row } | undefined> =>
  Effect.gen(function* () {
    const before = yield* db
      .select()
      .from(ReminderTable)
      .where(and(eq(ReminderTable.id, id), eq(ReminderTable.session_id, sessionID)))
      .get()
      .pipe(Effect.orDie)
    if (!before || !LIVE.some((status) => status === before.status)) return undefined
    // The status guard is the compare-and-swap: a delivery that committed
    // first leaves a one-shot reminder `delivered`, which this no longer finds.
    const after = yield* db
      .update(ReminderTable)
      .set({ status: "cancelled", updated_at: now })
      .where(and(eq(ReminderTable.id, id), inArray(ReminderTable.status, LIVE)))
      .returning()
      .get()
      .pipe(Effect.orDie)
    return after ? { before, after } : undefined
  })

export * as ReminderStore from "./store"
