// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

/**
 * Durable user reminders (#1072). One row per reminder created by `/remind`;
 * the process-level clock keeps nothing but the next wake-up time, so this row
 * is the record a restart resumes from. `status` carries the lifecycle value
 * (`scheduled`, `due`, `delivered`, `cancelled`), and `status`/`fire_at` drive
 * the clock's due query.
 *
 * `fire_at` is the occurrence the reminder waits for (`scheduled`) or owes
 * (`due`). Delivery commits inside the admission transaction that writes the
 * notice: a one-shot reminder becomes `delivered`, a repeating one (`every_ms`
 * set) returns to `scheduled` with `fire_at` advanced past now, so missed
 * occurrences fold into one delivery. `delivery` and `delivered_at` record the
 * last committed delivery; the key is `<id>:<fire_at>` of the delivered
 * occurrence, the inbox idempotency key of the `reminder` source.
 *
 * Only the user creates reminders: `creator` is fixed to `user` and the model
 * has no tool that writes this table. A reminder follows its session: deleting
 * the session deletes the row.
 */
export const ReminderTable = sqliteTable(
  "reminder",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    /** The user's own text, relayed verbatim when the reminder is delivered. */
    text: text().notNull(),
    fire_at: integer().notNull(),
    /** Repeat interval in milliseconds; null for a one-shot reminder. */
    every_ms: integer(),
    status: text().notNull(),
    creator: text().notNull().default("user"),
    delivery: text(),
    delivered_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    check("reminder_creator_check", sql`${t.creator} = 'user'`),
    // The clock's due scan and its next-wake-up query.
    index("reminder_status_fire_at_idx").on(t.status, t.fire_at),
    index("reminder_session_idx").on(t.session_id),
  ],
)
