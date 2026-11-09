// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"

/**
 * #1010 (E0): one row per session turn. The session engine (H1) writes the
 * running row when a turn starts and settles it when the turn ends; E0 only
 * owns the baseline shape.
 */
export const SessionTurnTable = sqliteTable(
  "session_turn",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    origin: text(),
    origin_ref: text(),
    state: text().notNull(),
    outcome: text({ mode: "json" }).$type<Record<string, unknown>>(),
    user_message_id: text(),
    last_assistant_id: text(),
    steps: integer(),
    runner_id: text(),
    time_started: integer(),
    time_ended: integer(),
  },
  (table) => [index("session_turn_session_idx").on(table.session_id, table.time_started)],
)
