// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { ChildBindingTable, ChildRunTable, type ChildRunState } from "@graphagent/core/session/child.sql"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { isRecord } from "@/util/record"
import { SessionID } from "../schema"
import type { ChildCancelBy, ChildOwner, ChildRunOutcome, ChildRunView } from "./types"

/**
 * Durable side of the child runs (Issue #1026, PR1): the `child_binding` and
 * `child_run` rows. Every state change of a run is exactly one statement: the
 * insert at `queued`, the update to `running`, the update to `ended`. The
 * binding is written once, with the first run of a child session.
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

const ownerRef = (owner: ChildOwner): string | null =>
  owner.kind === "task" ? (owner.toolCallID ?? null) : `${owner.workflowID}/${owner.nodeID}`

const truncate = (text: string) => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text)

/** The JSON stored in `child_run.outcome`; an error keeps a bounded message, not the whole transcript tail. */
export const outcomeJson = (outcome: ChildRunOutcome): Record<string, unknown> =>
  outcome.type === "error" ? { type: "error", message: truncate(outcome.message) } : { ...outcome }

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
 * Active -> ended. One write; false when the row had already ended (or was
 * deleted with its session). A finished run counts as reported: the old inject
 * delivers it until the result ledger of PR3 owns that. An interrupted run was
 * never reported and stays visible to `child_run_unreported`.
 */
export const endRun = (db: Db, runID: string, outcome: ChildRunOutcome, now: number): Effect.Effect<boolean> =>
  db
    .update(ChildRunTable)
    .set({
      state: "ended",
      outcome: outcomeJson(outcome),
      time_ended: now,
      reported_at: outcome.type === "interrupted" ? null : now,
    })
    .where(and(eq(ChildRunTable.id, runID), inArray(ChildRunTable.state, ACTIVE_STATES)))
    .returning({ id: ChildRunTable.id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

export const activeRows = (db: Db): Effect.Effect<Array<Pick<RunRow, "id" | "runner_id">>> =>
  db
    .select({ id: ChildRunTable.id, runner_id: ChildRunTable.runner_id })
    .from(ChildRunTable)
    .where(inArray(ChildRunTable.state, ACTIVE_STATES))
    .all()
    .pipe(Effect.orDie)

export * as ChildStore from "./store"
