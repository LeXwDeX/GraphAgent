export * as SessionLocation from "./location"

/**
 * DAG-LOC-01 (P2-A / P2-F) — the durable session-directory accessor.
 *
 * The execution-location authority in @/dag/location keys ownership on the
 * WORKFLOW row (WorkflowTable.directory, R7: dag sources must not read the
 * session directory column). Two consumers need the SESSION's own durable
 * directory, and both live OUTSIDE the dag trees, where the session-table
 * read is legal:
 *
 * - the GoalLoop idle trigger: goal-only sessions have no workflow rows, so
 *   the workflow-keyed ownsSession is vacuously true for them — the goal
 *   side needs a REAL directory check against SessionTable.directory
 *   (Goal.ownsSession, built on this accessor);
 * - Dag.create (P2-F): the workflow stamp must come from the TARGET
 *   session's durable directory (the single source of truth), not the
 *   ambient request instance's — otherwise a request on directory A can
 *   create a workflow for B's session and stamp it A, orphaning it from
 *   B's loops.
 *
 * Database is resolved lazily via serviceOption so callers' static layer
 * requirements stay unchanged (the optional-cross-dependency pattern);
 * production graphs always carry it. None means "no durable answer" — the
 * caller decides the fallback (vacuous-own on the goal side, ambient
 * instance on the create side).
 */

import { eq } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"

export const sessionDirectory = (sessionID: SessionID): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const db = yield* Effect.serviceOption(Database.Service)
    if (db._tag === "None") return Option.none()
    const row = yield* db.value.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    return row ? Option.some(row.directory) : Option.none()
  })
