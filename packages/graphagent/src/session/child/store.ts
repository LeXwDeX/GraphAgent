// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import {
  ChildBindingTable,
  ChildRunTable,
  type ChildOwnerKind,
  type ChildRunState,
} from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { and, asc, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { isRecord } from "@/util/record"
import { SessionID } from "../schema"
import type { ChildCancelBy, ChildOwner, ChildRunOutcome, ChildRunReport, ChildRunView } from "./types"

/**
 * Durable side of the child runs (Issue #1026): the `child_binding` and
 * `child_run` rows. Every state change of a run is exactly one statement: the
 * insert at `queued`, the update to `running`, the update to `ended`. The
 * binding is written once, with the first run of a child session.
 *
 * PR3a makes the rows the result ledger of detached runs: a detached run's
 * ending leaves `reported_at` empty and carries the result (`report`) in
 * `outcome`; the delivery to the parent writes `reported_at` in the same
 * transaction as the transcript message. `child_run_unreported` indexes
 * exactly the rows that still wait.
 */

type Db = Database.Interface["db"]

export type RunRow = typeof ChildRunTable.$inferSelect
export type BindingRow = typeof ChildBindingTable.$inferSelect

/** The states the partial unique index `child_run_active` treats as active. */
export const ACTIVE_STATES = [
  "queued",
  "starting",
  "running",
  "continuing",
] as const satisfies ReadonlyArray<ChildRunState>

const MAX_ERROR_CHARS = 1_000
/**
 * Bound of a stored result. A subagent's final answer is far below it; the
 * bound only keeps a runaway output from becoming a row of its own size, and a
 * result that hits it says so instead of ending mid-sentence.
 */
export const MAX_REPORT_CHARS = 200_000

const ownerRef = (owner: ChildOwner): string | null =>
  owner.kind === "task" ? (owner.toolCallID ?? null) : `${owner.workflowID}/${owner.nodeID}`

const truncate = (text: string) => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text)

const boundedReport = (report: ChildRunReport): ChildRunReport =>
  report.text.length > MAX_REPORT_CHARS
    ? {
        title: report.title,
        text: `${report.text.slice(0, MAX_REPORT_CHARS)}\n[truncated ${report.text.length - MAX_REPORT_CHARS} characters]`,
      }
    : report

/**
 * The JSON stored in `child_run.outcome`; an error keeps a bounded message, not
 * the whole transcript tail. The report a detached run leaves for its parent
 * rides along under `report`.
 */
export const outcomeJson = (outcome: ChildRunOutcome, report?: ChildRunReport): Record<string, unknown> => ({
  ...(outcome.type === "error" ? { type: "error", message: truncate(outcome.message) } : outcome),
  ...(report ? { report: boundedReport(report) } : {}),
})

/** The result a detached run left in its outcome, when it left one. */
export function parseReport(value: Record<string, unknown> | null | undefined): ChildRunReport | undefined {
  const report = value?.report
  if (!isRecord(report)) return undefined
  return typeof report.title === "string" && typeof report.text === "string"
    ? { title: report.title, text: report.text }
    : undefined
}

function cancelBy(value: unknown): ChildCancelBy | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === "main_agent_tool" && typeof value.toolCallID === "string")
    return { kind: "main_agent_tool", toolCallID: value.toolCallID }
  if (value.kind === "engine" && typeof value.reason === "string") return { kind: "engine", reason: value.reason }
  return undefined
}

export function parseOutcome(value: Record<string, unknown> | null | undefined): ChildRunOutcome | undefined {
  if (!value || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "completed":
      return { type: "completed" }
    case "error":
      return { type: "error", message: typeof value.message === "string" ? value.message : "" }
    case "cancelled": {
      const by = cancelBy(value.by)
      return by ? { type: "cancelled", by } : undefined
    }
    case "interrupted":
      return typeof value.reason === "string" ? { type: "interrupted", reason: value.reason } : { type: "interrupted" }
    default:
      return undefined
  }
}

export function viewOf(row: RunRow): ChildRunView {
  const outcome = parseOutcome(row.outcome)
  return {
    id: row.id,
    childSessionID: SessionID.make(row.child_session_id),
    parentSessionID: SessionID.make(row.parent_session_id),
    ownerKind: row.owner_kind,
    state: row.state,
    attempt: row.attempt ?? 1,
    detached: row.detached === true,
    ...(outcome ? { outcome } : {}),
    ...(row.reported_at === null ? {} : { reportedAt: row.reported_at }),
    timeCreated: row.time_created,
    ...(row.time_ended === null ? {} : { timeEnded: row.time_ended }),
  }
}

export interface NewRun {
  readonly id: string
  readonly childSessionID: SessionID
  readonly parentSessionID: SessionID
  readonly owner: ChildOwner
  readonly attempt: number
  readonly detached: boolean
  readonly runnerID: string
  readonly now: number
}

const runValues = (run: NewRun) => ({
  id: run.id,
  child_session_id: run.childSessionID,
  parent_session_id: run.parentSessionID,
  owner_kind: run.owner.kind,
  owner_id: ownerRef(run.owner),
  attempt: run.attempt,
  state: "queued" as const,
  detached: run.detached,
  runner_id: run.runnerID,
  time_created: run.now,
})

/** First run of a child session: its binding and the queued run, atomically. Two writes. */
export const insertFirst = (db: Db, run: NewRun) =>
  db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(ChildBindingTable)
            .values({
              child_session_id: run.childSessionID,
              parent_session_id: run.parentSessionID,
              owner_kind: run.owner.kind,
              owner_ref: ownerRef(run.owner),
              time_created: run.now,
            })
            .run()
          yield* tx.insert(ChildRunTable).values(runValues(run)).run()
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

/** The driver wraps the SQL failure in a query error; this looks through it for a unique constraint violation. */
function isUniqueViolation(error: { readonly cause: unknown }): boolean {
  const failure = Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause
  if (typeof failure !== "object" || failure === null || !("reason" in failure)) return false
  const reason = failure.reason
  return typeof reason === "object" && reason !== null && "_tag" in reason && reason._tag === "UniqueViolation"
}

/**
 * A later run of a known child session. False when the partial unique index
 * refused it because another run of the session is active (a concurrent
 * process won the race).
 */
export const insertNext = (db: Db, run: NewRun): Effect.Effect<boolean> =>
  db
    .insert(ChildRunTable)
    .values(runValues(run))
    .run()
    .pipe(
      Effect.as(true),
      Effect.catchTag("EffectDrizzleQueryError", (error) =>
        isUniqueViolation(error) ? Effect.succeed(false) : Effect.die(error),
      ),
    )

export const bindingOf = (db: Db, childSessionID: SessionID): Effect.Effect<BindingRow | undefined> =>
  db
    .select()
    .from(ChildBindingTable)
    .where(eq(ChildBindingTable.child_session_id, childSessionID))
    .get()
    .pipe(Effect.orDie)

export const latestOf = (db: Db, childSessionID: SessionID): Effect.Effect<RunRow | undefined> =>
  db
    .select()
    .from(ChildRunTable)
    .where(eq(ChildRunTable.child_session_id, childSessionID))
    .orderBy(desc(ChildRunTable.attempt), desc(ChildRunTable.time_created))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

export const runOf = (db: Db, runID: string): Effect.Effect<Option.Option<RunRow>> =>
  db
    .select()
    .from(ChildRunTable)
    .where(eq(ChildRunTable.id, runID))
    .get()
    .pipe(Effect.orDie, Effect.map(Option.fromNullishOr))

export const runsOfParent = (db: Db, parentSessionID: SessionID): Effect.Effect<RunRow[]> =>
  db
    .select()
    .from(ChildRunTable)
    .where(eq(ChildRunTable.parent_session_id, parentSessionID))
    .orderBy(desc(ChildRunTable.time_created))
    .all()
    .pipe(Effect.orDie)

/** queued -> running. One write; false when the row was not queued any more. */
export const markRunning = (db: Db, runID: string): Effect.Effect<boolean> =>
  db
    .update(ChildRunTable)
    .set({ state: "running" })
    .where(and(eq(ChildRunTable.id, runID), eq(ChildRunTable.state, "queued")))
    .returning({ id: ChildRunTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

/**
 * Whether an ending leaves something to tell the parent, as the value of
 * `reported_at` (a timestamp: nothing left; null: still owed). A cancelled run
 * delivers nothing, and a foreground run returns its result to its tool call,
 * so both count as reported at once. A detached run that finished (or failed)
 * stays owed to the ledger; the row's own `detached` column decides, in the
 * statement itself, so a promotion that races the ending cannot lose its
 * result. An interrupted run was never reported either way: a detached one is
 * owed to the ledger and the parent hears of it, a foreground one is simply gone.
 */
const reportedAtFor = (outcome: ChildRunOutcome, now: number): number | null | SQL => {
  switch (outcome.type) {
    case "interrupted":
      return null
    case "cancelled":
      return now
    default:
      return sql`CASE WHEN ${ChildRunTable.detached} = 1 THEN NULL ELSE ${now} END`
  }
}

/** What an ending write found on the row it ended. */
export interface EndedRun {
  /** The run is detached: its result is the ledger's. */
  readonly detached: boolean
  /** The ending marked the run reported: nothing is left to deliver. */
  readonly reported: boolean
  readonly ownerKind: ChildOwnerKind
}

/**
 * Active -> ended. One write; undefined when the row had already ended (or was
 * deleted with its session). `report` is the result a detached run leaves for
 * its parent; whether it is still owed is `reportedAtFor`.
 */
export const endRun = (
  db: Db,
  runID: string,
  outcome: ChildRunOutcome,
  now: number,
  report?: ChildRunReport,
): Effect.Effect<EndedRun | undefined> =>
  db
    .update(ChildRunTable)
    .set({
      state: "ended",
      outcome: outcomeJson(outcome, report),
      time_ended: now,
      reported_at: reportedAtFor(outcome, now),
    })
    .where(and(eq(ChildRunTable.id, runID), inArray(ChildRunTable.state, ACTIVE_STATES)))
    .returning({
      detached: ChildRunTable.detached,
      reported_at: ChildRunTable.reported_at,
      owner_kind: ChildRunTable.owner_kind,
    })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) =>
        row
          ? { detached: row.detached === true, reported: row.reported_at !== null, ownerKind: row.owner_kind }
          : undefined,
      ),
    )

/**
 * Makes a run detached. One write; true only when it changed the row, so the
 * promotion of a run that is already detached (or gone) writes nothing new.
 */
export const detachRun = (db: Db, runID: string): Effect.Effect<boolean> =>
  db
    .update(ChildRunTable)
    .set({ detached: true })
    .where(and(eq(ChildRunTable.id, runID), or(isNull(ChildRunTable.detached), eq(ChildRunTable.detached, false))))
    .returning({ id: ChildRunTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

// The partial index `child_run_unreported` holds `reported_at is null and detached = 1`; the literal
// keeps the planner able to prove that, which a bound parameter would not. The notice this ledger writes is a
// task's: the result of a DAG node (PR4) is the DAG's to deliver, so its rows are never owed here.
const owed = and(
  isNull(ChildRunTable.reported_at),
  sql`${ChildRunTable.detached} = 1`,
  eq(ChildRunTable.state, "ended"),
  eq(ChildRunTable.owner_kind, "task"),
)

/**
 * The parents of every finished detached run still owed to the ledger, among
 * the sessions of one directory: the tick's single scan of the result source.
 * The owed rows drive the query (the partial index holds only them) and each
 * is checked against its parent by primary key, so the cost follows the number
 * of owed results, not the number of sessions in the directory.
 */
export const unreportedParents = (db: Db, directory: string): Effect.Effect<SessionID[]> =>
  db
    .selectDistinct({ id: ChildRunTable.parent_session_id })
    .from(ChildRunTable)
    .where(
      and(
        owed,
        exists(
          db
            .select({ one: sql`1` })
            .from(SessionTable)
            .where(and(eq(SessionTable.id, ChildRunTable.parent_session_id), eq(SessionTable.directory, directory))),
        ),
      ),
    )
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => SessionID.make(row.id))),
    )

/** The finished detached runs of one parent that are still owed to the ledger, oldest ending first. */
export const unreportedOf = (db: Db, parentSessionID: SessionID): Effect.Effect<RunRow[]> =>
  db
    .select()
    .from(ChildRunTable)
    .where(and(eq(ChildRunTable.parent_session_id, parentSessionID), owed))
    .orderBy(asc(ChildRunTable.time_ended), asc(ChildRunTable.time_created))
    .all()
    .pipe(Effect.orDie)

/**
 * The delivery's compare-and-swap: marks one finished run reported. One write;
 * false when the row was reported already (a delivery that raced this one won)
 * or is gone. It runs inside the transaction that commits the transcript
 * message, so exactly one of two racing deliveries keeps its message.
 */
export const markReported = (db: Db, runID: string, now: number): Effect.Effect<boolean> =>
  db
    .update(ChildRunTable)
    .set({ reported_at: now })
    .where(and(eq(ChildRunTable.id, runID), isNull(ChildRunTable.reported_at), eq(ChildRunTable.state, "ended")))
    .returning({ id: ChildRunTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

/** What a delivery needs to know about the parent session it writes into. */
export interface ParentSession {
  readonly directory: string
  readonly agent: string | null
}

export const parentOf = (db: Db, sessionID: SessionID): Effect.Effect<ParentSession | undefined> =>
  db
    .select({ directory: SessionTable.directory, agent: SessionTable.agent })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)

export const activeRows = (db: Db): Effect.Effect<Array<Pick<RunRow, "id" | "runner_id">>> =>
  db
    .select({ id: ChildRunTable.id, runner_id: ChildRunTable.runner_id })
    .from(ChildRunTable)
    .where(inArray(ChildRunTable.state, ACTIVE_STATES))
    .all()
    .pipe(Effect.orDie)

export * as ChildStore from "./store"
