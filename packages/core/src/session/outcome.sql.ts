// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import type { PartID } from "../v1/session"
import type { SessionSchema } from "./schema"
import type { ToolOutcomeKind } from "./outcome"
import { PartTable } from "./sql"

/**
 * #1473: one row per terminal tool part (`completed` or `error`), written by the
 * session projector from the part itself. `outcome` and `corrections` are the
 * harness's own account of the call, so the statistics can group failures and
 * repairs by model and tool without reading part JSON. The row follows its part:
 * deleting the part (or its message) removes it.
 */
export const ToolOutcomeTable = sqliteTable(
  "tool_outcome",
  {
    part_id: text()
      .$type<PartID>()
      .primaryKey()
      .references(() => PartTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    tool: text().notNull(),
    outcome: text().$type<ToolOutcomeKind>().notNull(),
    corrections: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    truncated: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [
    index("tool_outcome_session_idx").on(table.session_id),
    index("tool_outcome_model_idx").on(table.provider_id, table.model_id, table.tool),
  ],
)
