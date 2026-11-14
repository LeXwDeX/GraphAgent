// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Durable PR/MR watches (#1071). One row per request watched from one session;
 * the process-level poller owns live polling and this row is the record a
 * restart resumes from. `phase` carries the lifecycle value (`watching`,
 * `delivering`, or a terminal value), and `next_poll_at`/`deadline_at` drive
 * the due query.
 *
 * `process_id` is the CAS owner token, the same `pid:nonce` identity
 * `runtime_job` uses, so another process can tell a live poller from a
 * leftover. `head` and `baseline_review` are the baseline that decides what
 * counts as a change; `outcome` is the forge classification once observed, and
 * `delivery` is the inbox delivery record that makes re-delivery idempotent.
 */
export const PrWatchTable = sqliteTable(
  "pr_watch",
  {
    id: text().primaryKey(),
    forge: text().notNull(),
    host: text().notNull(),
    url: text().notNull(),
    repo: text().notNull(),
    number: integer().notNull(),
    session_id: text().notNull(),
    head: text(),
    baseline_review: text(),
    phase: text().notNull(),
    next_poll_at: integer(),
    deadline_at: integer().notNull(),
    outcome: text(),
    delivery: text(),
    process_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    index("pr_watch_phase_next_poll_idx").on(t.phase, t.next_poll_at),
    index("pr_watch_phase_deadline_idx").on(t.phase, t.deadline_at),
    index("pr_watch_session_idx").on(t.session_id),
    uniqueIndex("pr_watch_session_url_idx").on(t.session_id, t.url),
  ],
)