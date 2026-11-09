// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { SessionTable } from "./sql"

export type ChildOwnerKind = "task" | "dag_node"
export type ChildRunState = "queued" | "starting" | "running" | "continuing" | "ended"

/**
 * #1010 (E0): the durable owner of a child session. Written once when the
 * child session is created (H3); E0 only owns the baseline shape.
 */
export const ChildBindingTable = sqliteTable("child_binding", {
  child_session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  parent_session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  owner_kind: text().notNull().$type<ChildOwnerKind>(),
  owner_ref: text(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})

/**
 * #1010 (E0): one row per child-run state episode. A child session has at
 * most one active run; after it ends another run may start. `detached` runs
 * that have not reported back stay visible through `child_run_unreported`.
 */
export const ChildRunTable = sqliteTable(
  "child_run",
  {
    id: text().primaryKey(),
    child_session_id: text()
      .notNull()
      .references(() => ChildBindingTable.child_session_id, { onDelete: "cascade" }),
    parent_session_id: text().notNull(),
    owner_kind: text().notNull().$type<ChildOwnerKind>(),
    owner_id: text(),
    attempt: integer(),
    state: text().notNull().$type<ChildRunState>(),
    policy: text({ mode: "json" }).$type<Record<string, unknown>>(),
    detached: integer({ mode: "boolean" }),
    deadline_at: integer(),
    outcome: text({ mode: "json" }).$type<Record<string, unknown>>(),
    reported_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_ended: integer(),
  },
  (table) => [
    index("child_run_session_time_idx").on(table.child_session_id, table.time_created),
    uniqueIndex("child_run_active")
      .on(table.child_session_id)
      .where(sql`${table.state} in ('queued', 'starting', 'running', 'continuing')`),
    index("child_run_unreported")
      .on(table.parent_session_id)
      .where(sql`${table.reported_at} is null and ${table.detached} = 1`),
  ],
)
