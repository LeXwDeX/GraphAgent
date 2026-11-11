// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable observation of background jobs (#1069 P5). The in-process registry
 * stays the live owner; this table records one complete snapshot per
 * transition so a restart can fail leftovers with `process_restart` and
 * readers can answer questions about jobs whose process is gone.
 *
 * `delivered_at` is the delivery point: the job entered `settling` because its
 * result was produced and its side effects are being delivered. `settled_at`
 * is the terminal status write. Both are null while the fact is unknown.
 */
export const RuntimeJobTable = sqliteTable(
  "runtime_job",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    /** Process-local owner token; startup recovery only fails rows from an
     * earlier process, never a live row of the current one. */
    process_id: text(),
    title: text(),
    session_id: text(),
    parent_session_id: text(),
    status: text().notNull(),
    metadata: text(),
    result: text(),
    error: text(),
    started_at: integer().notNull(),
    delivered_at: integer(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (t) => [
    index("runtime_job_status_idx").on(t.status),
    index("runtime_job_session_idx").on(t.session_id),
    index("runtime_job_updated_at_idx").on(t.updated_at),
  ],
)
