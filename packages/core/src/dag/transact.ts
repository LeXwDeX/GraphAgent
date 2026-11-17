// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagTransact from "./transact"

import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Context, Effect, Layer, Scheduler, Schema } from "effect"
import { SqlError } from "effect/sql/SqlError"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { DagLease } from "./lease"

/**
 * One transaction per DAG write (Issue #1029, ADR-0008 decision 3).
 *
 * A DAG command used to read its guard (the attempt identity, the transition
 * table) in one statement and publish in another, so a second process could
 * change the workflow in between. `transact(dagID, token, body)` runs the whole
 * command in one `BEGIN IMMEDIATE` transaction, which takes SQLite's write
 * reservation before its first read, in a fixed order:
 *
 *   1. **Fence.** When a `token` is given, the workflow's lease row must still
 *      name it, otherwise the transaction fails with `StaleRunnerError` and
 *      rolls back. The comparison is `(runner_id, epoch)` only, never
 *      `expires_at`: expiry makes a lease claimable but does not by itself
 *      invalidate its holder, and a takeover does, because it changes the token.
 *      No token, no fence: an intent write (a user's pause or cancel) is never
 *      refused by a lease.
 *   2. **Guard.** The command's existing checks, read inside the transaction.
 *   3. **Publish.** The events and their projections.
 *
 * The body is steps 2 and 3 and may contain database reads and writes only: a
 * body that waited on anything else would hold the write reservation, and with
 * it every other process's writers, for as long as it waited. Work that needs
 * the filesystem or git is done before the transaction begins. It also runs
 * without scheduler yields (`PreventSchedulerYield`), as the guarded capture
 * path does: a fiber that gave up the thread mid-transaction would stretch the
 * time the lock is held for nothing, and in one process with several
 * connections it would let another connection's writer block the thread on
 * `busy_timeout` against a lock its own holder cannot release.
 *
 * A failure of the body, typed or not, rolls everything back, so a refused
 * writer leaves no trace; what the body published is delivered to subscribers
 * only after the OUTERMOST commit (`EventV2` delivery) and not at all on a
 * rollback. Inside an enclosing transaction `transact` joins it as a savepoint.
 *
 * This is the transaction and the fence only. Which writes carry a token, what
 * a runner does when it is refused, and the in-process lock that queues the
 * writers of one process are the callers' business (ADR-0008 decisions 4, 5).
 */

/**
 * The writer's lease no longer names its token: another runner took the
 * workflow over (a takeover changes the epoch), or no runner holds it any
 * more (the row is gone, or the workflow is terminal). The write was rolled back.
 */
export class StaleRunnerError extends Schema.TaggedError<StaleRunnerError>()("StaleRunnerError", {
  dagID: Schema.String,
  runnerID: Schema.String,
  epoch: Schema.Number,
}) {
  override get message() {
    return `Runner ${this.runnerID} (epoch ${this.epoch}) no longer holds the lease of workflow ${this.dagID}`
  }
}

type DB = Database.Interface["db"]
/** The Drizzle transaction handle a transaction body reads and writes through. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0]
/** What the database layer fails with. It is never a typed failure of a DAG command. */
type DatabaseError = SqlError | EffectDrizzleQueryError

/**
 * `body` in one `BEGIN IMMEDIATE` transaction (a savepoint inside an enclosing
 * one). A database failure, `SQLITE_BUSY` after the busy timeout included,
 * becomes a defect and so is never one of the typed errors; whatever `body`
 * itself fails with passes through typed, and rolls the transaction back like
 * any other exit that is not a success.
 *
 * The one definition of this wrapper: `DagMessages.fenceWorkflow` and
 * `DagMessages.guard` run in it too.
 */
export const immediate = <A, E, R>(
  db: DB,
  body: (tx: Tx) => Effect.Effect<A, E | DatabaseError, R>,
): Effect.Effect<A, E, R> =>
  db
    .transaction(body, { behavior: "immediate" })
    .pipe(
      Effect.catch((error) =>
        error instanceof SqlError || error instanceof EffectDrizzleQueryError ? Effect.die(error) : Effect.fail(error),
      ),
    )

export interface Interface {
  /**
   * Run `body` for workflow `dagID` in one IMMEDIATE transaction: the fence
   * when `token` is given, then `body` (the guard and the publish). Fails with
   * `StaleRunnerError` when the lease row does not name `token`.
   */
  readonly transact: <A, E, R>(
    dagID: string,
    token: DagLease.Token | undefined,
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StaleRunnerError, R>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/DagTransact") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const leases = yield* DagLease.Service

    // `held` joins the workflow row, so a terminal or vanished workflow holds
    // no lease for anyone: a late write of its old holder is refused here.
    const fence = (dagID: string, token: DagLease.Token) =>
      Effect.flatMap(leases.held(dagID), (lease) =>
        DagLease.holds(lease, token)
          ? Effect.void
          : Effect.fail(new StaleRunnerError({ dagID, runnerID: token.runnerID, epoch: token.epoch })),
      )

    return Service.of({
      transact: (dagID, token, body) =>
        immediate(db, () =>
          (token === undefined ? body : Effect.andThen(fence(dagID, token), body)).pipe(
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
          ),
        ),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(DagLease.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node, DagLease.node])
