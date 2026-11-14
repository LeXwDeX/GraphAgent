// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { and, asc, eq, exists, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { isDeliverableOutcome, terminalPhaseFor, type Notice, type Outcome, type Request } from "./forge"

/**
 * Durable reads and the delivery CAS of the `pr_watch` inbox source (#1071
 * PR3). The `pr_watch` row is the ledger: the poller writes `phase=delivering`
 * with the observed `outcome`, and the source clears `delivery` (stores the
 * idempotency key) inside the admission transaction once the notice commits.
 * A row whose `delivery` is still null is owed to the session and survives a
 * restart, so the startup scan and the 30s tick redeliver it exactly once.
 */

type Db = Database.Interface["db"]

export type Row = typeof PrWatchTable.$inferSelect

/** The durable delivery key: one notice per watch, outcome and followed head. */
export const idempotencyKey = (row: Row): string => `${row.id}:${row.outcome ?? "unknown"}:${row.head ?? ""}`

export const outcomeOf = (row: Row): Outcome | undefined =>
  isDeliverableOutcome(row.outcome) ? row.outcome : undefined

/** The terminal phase a delivered notice settles to; the vocabulary lives in `forge.ts`. */
export const settledPhase = terminalPhaseFor

export const noticeOf = (row: Row): Notice | undefined => {
  const outcome = outcomeOf(row)
  if (!outcome) return undefined
  return { outcome, request: requestOf(row), ...(row.head ? { head: row.head } : {}) }
}

/** A persisted row rendered as the forge request the notice names. */
export const requestOf = (row: Row): Request => {
  // `host` has no port; a self-hosted forge keeps its port in the URL.
  let authority = row.host
  try {
    authority = new URL(row.url).host.toLowerCase()
  } catch {
    // A malformed persisted URL still names no live forge; keep the host.
  }
  return {
    provider: row.forge === "gitlab" ? "gitlab" : "github",
    host: row.host,
    authority,
    url: row.url,
    number: row.number,
    path: row.repo,
  }
}

/** A row is owed while its phase is delivering and its delivery marker is unset. */
const owed = and(eq(PrWatchTable.phase, "delivering"), isNull(PrWatchTable.delivery))

/**
 * The sessions of one directory that have a notice still owed: the tick's and
 * the startup scan's single read. The owed rows drive the query (the phase
 * index holds them) and each is checked against its session by primary key, so
 * the cost follows the number of undelivered outcomes, not the sessions in the
 * directory.
 */
export const deliveringSessions = (db: Db, directory: string): Effect.Effect<SessionID[]> =>
  db
    .selectDistinct({ id: PrWatchTable.session_id })
    .from(PrWatchTable)
    .where(
      and(
        owed,
        exists(
          db
            .select({ one: sql`1` })
            .from(SessionTable)
            .where(and(eq(SessionTable.id, PrWatchTable.session_id), eq(SessionTable.directory, directory))),
        ),
      ),
    )
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => SessionID.make(row.id))),
    )

/** The notices one session is still owed, oldest observation first. */
export const undeliveredOf = (db: Db, sessionID: SessionID): Effect.Effect<Row[]> =>
  db
    .select()
    .from(PrWatchTable)
    .where(and(owed, eq(PrWatchTable.session_id, sessionID)))
    .orderBy(asc(PrWatchTable.updated_at), asc(PrWatchTable.id))
    .all()
    .pipe(Effect.orDie)

/** What a delivery needs to know about the session it writes into. */
export interface SessionInfo {
  readonly directory: string
  readonly agent: string | null
}

export const sessionOf = (db: Db, sessionID: SessionID): Effect.Effect<SessionInfo | undefined> =>
  db
    .select({ directory: SessionTable.directory, agent: SessionTable.agent })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)

/** One row by primary key, for the post-failure classification. */
export const rowOf = (db: Db, watchID: string): Effect.Effect<Row | undefined> =>
  db
    .select()
    .from(PrWatchTable)
    .where(eq(PrWatchTable.id, watchID))
    .get()
    .pipe(Effect.orDie)

/**
 * The delivery's compare-and-swap: marks one watch delivered and moves it to
 * its terminal phase. One write; false when another delivery already marked it
 * (or the row left `delivering`, for example by a cancellation). It runs inside
 * the transaction that commits the notice message, so exactly one of two racing
 * deliveries keeps its message, and a cancellation either wins before the
 * notice or loses to it — never both.
 */
export const markDelivered = (
  db: Db,
  watchID: string,
  key: string,
  now: number,
  phase: "succeeded" | "failed" | "expired",
): Effect.Effect<boolean> =>
  db
    .update(PrWatchTable)
    .set({ delivery: key, phase, updated_at: now })
    .where(and(eq(PrWatchTable.id, watchID), eq(PrWatchTable.phase, "delivering"), isNull(PrWatchTable.delivery)))
    .returning({ id: PrWatchTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

export * as PrWatchStore from "./store"