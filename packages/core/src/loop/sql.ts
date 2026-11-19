// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable loop state (#1329). `loop_state` and `loop_outcome` have the column
 * shape of `goal_state` and `goal_outcome` (the goal tables stay until the
 * switch-over): one live row per session holding the JSON payload, and one
 * terminal snapshot per finished loop. Neither has a foreign key to `session`,
 * so session removal purges them explicitly.
 *
 * `loop_analysis` is the append-only audit trail of committed background
 * analyses, one row per commit, numbered per loop by `seq`. A discarded or
 * failed analysis leaves no row.
 */
export const LoopStateTable = sqliteTable(
  "loop_state",
  {
    session_id: text().primaryKey(),
    payload: text().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index("loop_state_updated_at_idx").on(t.updated_at)],
)

export const LoopOutcomeTable = sqliteTable(
  "loop_outcome",
  {
    loop_id: text().primaryKey(),
    session_id: text().notNull(),
    payload: text().notNull(),
    completed_at: integer().notNull(),
  },
  (t) => [index("loop_outcome_session_completed_idx").on(t.session_id, t.completed_at)],
)

export const LoopAnalysisTable = sqliteTable(
  "loop_analysis",
  {
    loop_id: text().notNull(),
    /** 1-based, dense per loop; assigned inside the write transaction. */
    seq: integer().notNull(),
    session_id: text().notNull(),
    /** The round the analyzed boundary belongs to. */
    round: integer().notNull(),
    /** The assistant message the analysis ran at. */
    boundary: text().notNull(),
    verdict: text().notNull(),
    reason: text().notNull(),
    /** `intent_revision` after this commit. */
    intent_revision: integer().notNull(),
    change_summary: text(),
    /** The human message the intent change or the verdict rests on. */
    change_basis_message_id: text(),
    /** The `next_prompt` the analysis produced; absent unless the verdict was `continue`. */
    prompt: text(),
    input_tokens: integer().notNull(),
    output_tokens: integer().notNull(),
    reasoning_tokens: integer().notNull(),
    elapsed_ms: integer().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.loop_id, t.seq] }), index("loop_analysis_session_idx").on(t.session_id)],
)
