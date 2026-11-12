// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as BackgroundLifecycle from "./lifecycle"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Database } from "@graphagent/core/database/database"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import type { LifecycleState } from "@graphagent/core/lifecycle/state"
import { valuesOf } from "@graphagent/core/lifecycle/vocabulary"
import { SessionTable } from "@graphagent/core/session/sql"
import { sql } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceState } from "@/effect/instance-state"
import { Lifecycle } from "@/lifecycle/service"
import { BackgroundJob } from "./job"
import { readPersistedJob, type PersistedJob } from "./persist"

/**
 * Registers the job domain with the lifecycle service (#1069 P7).
 *
 * The registry in `background/job.ts` remains the only writer of job state.
 * This layer only exposes it through `Lifecycle.get`, so a waiter (goal await,
 * inbox, TUI) can validate a `StateRef` against the shared contract instead of
 * keeping a private copy. Registration is a build-time side effect; every read
 * hits the live registry first.
 *
 * The registry is process-local and instance-scoped, so after a restart it no
 * longer knows the jobs of the previous process. A miss falls back to the
 * durable `runtime_job` row and reports it as a `persisted` observation:
 * restart recovery fails the leftovers as `process_restart`, so a reader that
 * asks about such a job gets that terminal state instead of "unknown". The row
 * has no directory column, so it is only visible to the instance whose
 * directory owns the job's session, the same rule the goal resolver applies.
 */

const isJobStatus = (value: string): boolean => valuesOf("job").includes(value)

/**
 * Whether the row's session lives in the calling directory. The job's own
 * session decides; a task's child session may be gone while the caller's
 * session still locates it. A row that names no session with a durable
 * directory is not provably ours and stays hidden.
 */
const ownsRow = (db: Database.Interface["db"], row: PersistedJob, directory: string) =>
  Effect.gen(function* () {
    for (const id of [row.session_id, row.parent_session_id]) {
      if (!id) continue
      const session = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        // A bound comparison: job metadata is not guaranteed to hold a valid
        // SessionID, and building the brand would throw instead of missing.
        .where(sql`${SessionTable.id} = ${id}`)
        .get()
        .pipe(Effect.orDie)
      if (session)
        return DagLocation.canonicalDirectory(session.directory) === DagLocation.canonicalDirectory(directory)
    }
    return false
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const lifecycle = yield* Lifecycle.Service
    const { db } = yield* Database.Service
    yield* lifecycle.register({
      domain: "job",
      read: (id) =>
        Effect.gen(function* () {
          const job = yield* jobs.get(id)
          if (job) return Option.some(stateOf({ ref: ref("job", id), value: job.status, source: "live" }))
          const row = yield* readPersistedJob(db, id).pipe(Effect.orDie)
          if (!row || !isJobStatus(row.status)) return Option.none<LifecycleState<"job">>()
          const instance = yield* InstanceState.context
          if (!(yield* ownsRow(db, row, instance.directory))) return Option.none<LifecycleState<"job">>()
          return Option.some(stateOf({ ref: ref("job", id), value: row.status, source: "persisted" }))
        }),
    })
  }),
)

// `provideMerge` does not feed the accumulated context into the merged layer
// (see GoalLoop.defaultLayer), so register through a self-contained layer.
// memoMap dedups the dependencies with the AppLayer instances, keeping the
// resolver on the same Lifecycle, BackgroundJob and Database the rest of the
// runtime uses.
export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Lifecycle.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [BackgroundJob.node, Lifecycle.node, Database.node])
