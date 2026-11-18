// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SessionUsage } from "@graphagent/schema/session-usage"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

/**
 * Usage of a whole task tree (#1475). `applyUsage` writes a step's usage onto
 * the session that produced it, so a task child and every DAG attempt session
 * (`parent_id` names the session the workflow belongs to) each hold their own
 * numbers. This reads them back as one: the root's row plus everything below it.
 *
 * Display only. Nothing here limits or blocks a session, and `dag.budget`
 * keeps counting what it always counted.
 */

type Db = Database.Interface["db"]

/** A parent chain longer than this is corrupted data, not a task tree. */
const MAX_DEPTH = 256

const TOKEN_SUM = sql`(${SessionTable.tokens_input} + ${SessionTable.tokens_output} + ${SessionTable.tokens_reasoning} + ${SessionTable.tokens_cache_read} + ${SessionTable.tokens_cache_write})`

/**
 * A `session` row with no price: it recorded tokens but its cost is zero (the
 * model had no price card, or a gateway reported none). Same test as
 * `unpriced` in `util/cost.ts`, applied to the recorded usage only; the
 * model's price is never read. Valid wherever `session` is in the FROM list.
 */
export const UNPRICED_SQL = sql`(${SessionTable.cost} = 0 AND ${TOKEN_SUM} > 0)`

interface UsageRow {
  sessions: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknown: number
}

// UNION (not UNION ALL) drops a row already seen, so a corrupted parent cycle
// ends the walk instead of looping.
const usageStatement = (rootID: string) => sql`
  WITH RECURSIVE tree(id) AS (
    SELECT ${rootID}
    UNION
    SELECT ${SessionTable.id} FROM ${SessionTable} JOIN tree ON ${SessionTable.parent_id} = tree.id
  )
  SELECT
    count(*) AS sessions,
    max(0, coalesce(sum(${SessionTable.cost}), 0)) AS cost,
    coalesce(sum(${SessionTable.tokens_input}), 0) AS input,
    coalesce(sum(${SessionTable.tokens_output}), 0) AS output,
    coalesce(sum(${SessionTable.tokens_reasoning}), 0) AS reasoning,
    coalesce(sum(${SessionTable.tokens_cache_read}), 0) AS cacheRead,
    coalesce(sum(${SessionTable.tokens_cache_write}), 0) AS cacheWrite,
    coalesce(max(CASE WHEN ${UNPRICED_SQL} THEN 1 ELSE 0 END), 0) AS unknown
  FROM ${SessionTable}
  WHERE ${SessionTable.id} IN (SELECT id FROM tree)
`

const rootStatement = (sessionID: string) => sql`
  WITH RECURSIVE up(id, parent_id, depth) AS (
    SELECT ${SessionTable.id}, ${SessionTable.parent_id}, 0 FROM ${SessionTable} WHERE ${SessionTable.id} = ${sessionID}
    UNION ALL
    SELECT ${SessionTable.id}, ${SessionTable.parent_id}, up.depth + 1
    FROM ${SessionTable} JOIN up ON ${SessionTable.id} = up.parent_id
    WHERE up.depth < ${MAX_DEPTH}
  )
  SELECT id FROM up ORDER BY depth DESC LIMIT 1
`

const toInfo = (rootID: SessionSchema.ID, row: UsageRow | undefined): SessionUsage.Info => ({
  rootID,
  sessions: row?.sessions ?? 0,
  cost: row?.cost ?? 0,
  costUnknown: (row?.unknown ?? 0) > 0,
  tokens: {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    reasoning: row?.reasoning ?? 0,
    cache: { read: row?.cacheRead ?? 0, write: row?.cacheWrite ?? 0 },
  },
})

/**
 * The session `sessionID` belongs to the tree of: climbs `parent_id` to the
 * session without a parent. A parent row that no longer exists ends the climb
 * at the highest session still there; an unknown id is its own root.
 */
export const findRoot = Effect.fn("SessionUsage.findRoot")(function* (db: Db, sessionID: SessionSchema.ID) {
  const row = yield* db.get<{ id: string }>(rootStatement(sessionID)).pipe(Effect.orDie)
  return row ? SessionSchema.ID.make(row.id) : sessionID
})

/**
 * Σ usage over `rootID` and every session below it (task children,
 * grandchildren, DAG attempt sessions). `cost` is never negative; `costUnknown`
 * is set when any session in the tree is unpriced (`UNPRICED_SQL`), in which
 * case `cost` leaves that session's usage out. A root that does not exist
 * reads as an empty tree. Sessions deleted since are not in the table and so
 * not in the sum.
 */
export const rootUsage = Effect.fn("SessionUsage.rootUsage")(function* (db: Db, rootID: SessionSchema.ID) {
  const row = yield* db.get<UsageRow>(usageStatement(rootID)).pipe(Effect.orDie)
  return toInfo(rootID, row)
})
