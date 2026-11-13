// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as RuntimeJobRecovery from "./recovery"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import type { Status } from "@graphagent/core/background-job"
import { Database } from "@graphagent/core/database/database"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { Lifecycle } from "@/lifecycle/service"
import { runnerAlive } from "@/session/engine-process"
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Scope } from "effect"
import { runtimeJobProcessID } from "./persist"

/**
 * Startup recovery for the durable job observation (#1069 P5).
 *
 * The in-process registry dies with its process, so a `running`/`settling` row
 * whose owner process is gone can never reach a terminal status. One pass
 * fails those rows with `process_restart` and publishes the normal
 * `lifecycle.transitioned` event, so a waiter is woken instead of hanging
 * until its deadline.
 *
 * The owner is `process_id`, the `pid:nonce` runner identity (#1272), and the
 * database is shared by every graphagent process of the install. A row is a
 * leftover only when `runnerAlive` says its owner is gone:
 *   - rows of the current process are never touched: the sidecar and AppLayer
 *     may build this service twice in one process;
 *   - rows of another live process stay as they are: that process may be
 *     driving the job right now, and failing it would also send a goal waiting
 *     on it to its lost-job review;
 *   - rows of an exited pid, or of an earlier life of this pid (same pid,
 *     other nonce), are failed.
 * A `proc_<uuid>` value written before #1272 names no pid, so it counts as
 * gone and is failed too, as it was before the identity changed.
 *
 * Soft-degrading like EventResidueSweep: the startup pass is forked into the
 * layer scope and a failure is logged, never fatal to startup.
 */

export interface Interface {
  /** One recovery pass. Returns the number of leftover rows failed. */
  readonly recoverOnce: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/RuntimeJobRecovery") {}

const leftover = (status: string): status is Extract<Status, "running" | "settling"> =>
  status === "running" || status === "settling"

/** The owner this pass judged gone, as a write guard: a live process that reuses the job id replaces it. */
const ownedBy = (processID: string | null) =>
  processID === null ? isNull(RuntimeJobTable.process_id) : eq(RuntimeJobTable.process_id, processID)

export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const lifecycle = yield* Lifecycle.Service

  const recoverOnce = Effect.fn("RuntimeJobRecovery.recoverOnce")(function* () {
    const rows = yield* db
      .select()
      .from(RuntimeJobTable)
      .where(
        and(
          inArray(RuntimeJobTable.status, ["running", "settling"]),
          or(isNull(RuntimeJobTable.process_id), ne(RuntimeJobTable.process_id, runtimeJobProcessID)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    let recovered = 0
    for (const row of rows) {
      if (!leftover(row.status)) continue
      // The query only excludes this process; another process that is still
      // alive keeps its rows.
      if (runnerAlive(row.process_id)) continue
      const now = yield* Clock.currentTimeMillis
      const updated = yield* db
        .update(RuntimeJobTable)
        .set({ status: "error", error: "process_restart", settled_at: now, updated_at: now })
        .where(
          and(
            eq(RuntimeJobTable.id, row.id),
            inArray(RuntimeJobTable.status, ["running", "settling"]),
            ownedBy(row.process_id),
          ),
        )
        .returning({ id: RuntimeJobTable.id })
        .get()
        .pipe(Effect.orDie)
      // A concurrent terminal write or owner change wins; the row is not a
      // leftover anymore and gets no second transition.
      if (!updated) continue
      yield* lifecycle.transition({
        ref: { domain: "job", id: row.id },
        expect: row.status,
        to: "error",
        reason: "process_restart",
        sessionID: row.session_id ?? undefined,
      })
      recovered++
    }
    if (recovered > 0) yield* Effect.logInfo("RuntimeJobRecovery failed leftover jobs after a process restart", { recovered })
    return recovered
  })

  return Service.of({ recoverOnce })
})

/** Testable service without the process-start side effect. */
export const layer = Layer.effect(Service, make)

const startupLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = yield* make
    const scope = yield* Scope.Scope
    const { recoverOnce } = service
    yield* recoverOnce().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("RuntimeJobRecovery startup pass failed — leftovers stay visible for a later pass", { cause }),
      ),
      Effect.forkIn(scope),
    )
    return service
  }),
)

export const defaultLayer = startupLayer.pipe(Layer.provide(Layer.mergeAll(Database.defaultLayer, Lifecycle.defaultLayer)))

export const node = LayerNode.make(startupLayer, [Database.node, Lifecycle.node])
