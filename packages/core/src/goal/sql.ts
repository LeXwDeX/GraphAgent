// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const GoalStateTable = sqliteTable(
  "goal_state",
  {
    session_id: text().primaryKey(),
    payload: text().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index("goal_state_updated_at_idx").on(t.updated_at)],
)

export const GoalOutcomeTable = sqliteTable(
  "goal_outcome",
  {
    goal_id: text().primaryKey(),
    session_id: text().notNull(),
    payload: text().notNull(),
    completed_at: integer().notNull(),
  },
  (t) => [index("goal_outcome_session_completed_idx").on(t.session_id, t.completed_at)],
)
