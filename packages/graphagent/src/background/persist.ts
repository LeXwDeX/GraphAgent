// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { BackgroundJob } from "@graphagent/core/background-job"
import type { Database } from "@graphagent/core/database/database"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Clock, Effect } from "effect"

/** One token per process: a second service instance in the same process (the
 * sidecar and AppLayer can both build the graph) must not treat this
 * process's live rows as leftovers. */
export const runtimeJobProcessID = `proc_${randomUUID()}`

const isTerminal = (status: BackgroundJob.Status) =>
  status === "completed" || status === "error" || status === "cancelled"

export type PersistedJob = typeof RuntimeJobTable.$inferSelect

/**
 * The durable row of one job, if any. After a restart this is the only record
 * of a job: the lifecycle resolver and the goal wait reconciliation both read
 * it through here so they agree on what the row says.
 */
export const readPersistedJob = (db: Database.Interface["db"], id: string) =>
  db.select().from(RuntimeJobTable).where(eq(RuntimeJobTable.id, id)).get()

/**
 * Durable observation for one registry transition (#1069 P5). The registry
 * stays authoritative: this is an upsert of the complete snapshot the sink
 * already received, never a second state store. A failed write is the caller's
 * to log — it must not change the job's in-process outcome.
 */
export const persistTransition = (db: Database.Interface["db"], transition: BackgroundJob.Transition) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const creation = transition.from === null
    const values = {
      id: transition.id,
      type: transition.type,
      process_id: runtimeJobProcessID,
      title: transition.title ?? null,
      session_id: transition.sessionID ?? null,
      parent_session_id: transition.parentSessionID ?? null,
      status: transition.to,
      metadata: transition.metadata ? JSON.stringify(transition.metadata) : null,
      result: transition.output ?? null,
      error: transition.error ?? null,
      started_at: transition.started_at ?? now,
      delivered_at: transition.to === "settling" ? now : null,
      settled_at: isTerminal(transition.to) ? now : null,
      updated_at: now,
    }
    yield* db
      .insert(RuntimeJobTable)
      .values(values)
      .onConflictDoUpdate({
        target: RuntimeJobTable.id,
        set: {
          type: transition.type,
          process_id: runtimeJobProcessID,
          title: values.title,
          session_id: values.session_id,
          parent_session_id: values.parent_session_id,
          status: transition.to,
          metadata: values.metadata,
          updated_at: now,
          // Creation resets a reused id's terminal fields; later transitions
          // only add the facts they establish.
          ...(creation
            ? { started_at: values.started_at, result: null, error: null, delivered_at: null, settled_at: null }
            : {}),
          ...(!creation && transition.to === "settling" ? { delivered_at: now } : {}),
          ...(!creation && isTerminal(transition.to)
            ? { result: transition.output ?? null, error: transition.error ?? null, settled_at: now }
            : {}),
        },
      })
      .run()
  })
