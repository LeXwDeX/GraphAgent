// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

/** Authoritative records, not disposable event projections. Do not clear during DAG replay. */
export const AgentMailboxTable = sqliteTable(
  "agent_mailbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    workflow_id: text(),
    node_id: text(),
    attempt_id: text(),
    revision: integer().notNull().default(0),
    // D7 change stream: bumped by every mailbox-mutating transaction so readers
    // can compare versions across send/associate/close without a row scan.
    change_seq: integer().notNull().default(0),
    result_nudge_revision: integer().notNull().default(-1),
    closed_reason: text(),
    time_created: integer().notNull(),
  },
  (table) => [index("agent_mailbox_session_idx").on(table.session_id)],
)

export const AgentMessageTable = sqliteTable(
  "agent_message",
  {
    id: text().primaryKey(),
    workflow_id: text().notNull(),
    sender_id: text().notNull(),
    recipient_id: text().notNull(),
    recipient_session_id: text().notNull(),
    sender: text({ mode: "json" }).notNull(),
    recipient: text({ mode: "json" }).notNull(),
    idempotency_key: text().notNull(),
    request: text().notNull(),
    content: text().notNull(),
    reply_to: text(),
    recipient_sequence: integer().notNull(),
    accepted_revision: integer().notNull(),
    state: text().notNull(),
    reason: text(),
    snapshot_id: text(),
    transcript_id: text().notNull(),
    part_id: text().notNull(),
    time_created: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [
    uniqueIndex("agent_message_sender_key_idx").on(table.sender_id, table.idempotency_key),
    uniqueIndex("agent_message_recipient_sequence_idx").on(table.recipient_id, table.recipient_sequence),
    index("agent_message_recipient_state_idx").on(table.recipient_id, table.state, table.recipient_sequence),
    index("agent_message_session_idx").on(table.recipient_session_id, table.state),
  ],
)

export const AgentInputSnapshotTable = sqliteTable(
  "agent_input_snapshot",
  {
    id: text().primaryKey(),
    mailbox_id: text().notNull(),
    logical_turn_id: text().notNull(),
    revision: integer().notNull(),
    message_ids: text({ mode: "json" }).notNull().$type<string[]>(),
    associated: integer({ mode: "boolean" }).notNull().default(false),
    stop_reason: text(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("agent_input_snapshot_turn_idx").on(table.mailbox_id, table.logical_turn_id)],
)
