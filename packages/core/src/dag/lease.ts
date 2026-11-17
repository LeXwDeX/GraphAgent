// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLease from "./lease"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { WORKFLOW_TERMINAL_STATUS_VALUES } from "./core/types"

/**
 * Runner lease primitives (Issue #1029, ADR-0008 decisions 1 and 2).
 *
 * Several engine processes can open one SQLite database, and which of them
 * drives a workflow existed only in memory. A workflow's lease is one row of
 * `dag_runner`: `(dag_id, runner_id, epoch, expires_at)`. The runner is an
 * engine process (`EngineProcess.runner.id`, `pid:nonce`); a lease's token is
 * the pair `(runner_id, epoch)`.
 *
 * Every operation is ONE SQL statement. The three that write (`claim`,
 * `renew`, `release`) are compare-and-sets that SQLite serializes across
 * connections and processes: there is no read-then-write gap to lose a race
 * in, and none needs an explicit transaction. The writers take the runner (or
 * its token) and `now` as arguments and, like `held`, read neither
 * `EngineProcess.runner` nor a clock, so a test can drive two runners in one
 * process on a TestClock.
 *
 * This is the table and the primitives only. Nothing here decides who should
 * claim, when to renew or what a runner that lost its lease does: that is the
 * reconciler's job (ADR-0008 decisions 2, 5 and 6).
 *
 * A database failure, `SQLITE_BUSY` after the busy timeout included, is a
 * defect and never a `false` or an `undefined`: a caller must not read a
 * transient failure as a lost lease (ADR-0008 decision 2).
 */

/** How long a claim or a renewal keeps a lease: 90 seconds. */
export const TTL_MS = 90_000

/** How often a runner renews the leases it holds: 30 seconds, a third of the TTL. */
export const RENEWAL_PERIOD_MS = 30_000

/** What a runner holds a lease by. The epoch only ever grows, across all holders of a workflow. */
export interface Token {
  /** `pid:nonce` of the engine process. */
  readonly runnerID: string
  readonly epoch: number
}

export interface Lease extends Token {
  readonly dagID: string
  /** Epoch milliseconds. Another runner may claim the lease once `now >= expiresAt`. */
  readonly expiresAt: number
}

/** Whether `lease` is held by `token`: the runner and the epoch, never the expiry. */
export const holds = (lease: Lease | undefined, token: Token): boolean =>
  lease !== undefined && lease.runnerID === token.runnerID && lease.epoch === token.epoch

export interface Interface {
  /**
   * Take the lease of a workflow, or refresh one this runner already holds.
   * Succeeds when the row is missing, has expired (`expires_at <= now`) or
   * already names `runnerID`, and then sets the expiry to `now + TTL_MS`. A
   * takeover from another runner increases the epoch by one; a first claim
   * starts at epoch 1 and a refresh by the holder keeps its epoch. Refused
   * (`undefined`, nothing written) while another runner's lease is live.
   *
   * This is also the #270 admission (ADR-0008): it is refused when the
   * workflow row is gone or terminal, even for the holder.
   */
  readonly claim: (input: {
    readonly dagID: string
    readonly runnerID: string
    readonly now: number
  }) => Effect.Effect<Lease | undefined>
  /**
   * Extend the lease to `now + TTL_MS` while the row still names `token`;
   * `false` means it does not (another runner took the lease over, or the row
   * is gone) and nothing was written. Never changes the epoch, never takes a
   * lease back and does not compare time: a lease that has expired but that
   * nobody took can still be renewed.
   */
  readonly renew: (input: {
    readonly dagID: string
    readonly token: Token
    readonly now: number
  }) => Effect.Effect<boolean>
  /**
   * Give up the lease at a clean exit: it expires at `now`, so another runner
   * can claim it at once. Only while the row still names `token`; `false`
   * means it does not. The row stays and keeps its epoch, so the next
   * takeover continues the count.
   */
  readonly release: (input: {
    readonly dagID: string
    readonly token: Token
    readonly now: number
  }) => Effect.Effect<boolean>
  /**
   * The lease row of a workflow: who holds it, at which epoch, until when.
   * `undefined` when no runner has claimed it, or (the admission guarantee of
   * `claim`) when the workflow is gone or terminal. Time is not compared, so
   * an expired lease is reported as it stands; whether the token a runner
   * carries still holds is `holds(lease, token)`, and whether the lease is
   * live is the caller's judgement from `expiresAt` and its own `now`.
   */
  readonly held: (dagID: string) => Effect.Effect<Lease | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/DagLease") {}

interface Row {
  readonly dag_id: string
  readonly runner_id: string
  readonly epoch: number
  readonly expires_at: number
}

const toLease = (row: Row): Lease => ({
  dagID: row.dag_id,
  runnerID: row.runner_id,
  epoch: row.epoch,
  expiresAt: row.expires_at,
})

/** `NOT IN (<terminal statuses>)`: what #270 admission means, from the shared status vocabulary. */
const nonTerminal = sql`NOT IN (${sql.join(
  WORKFLOW_TERMINAL_STATUS_VALUES.map((status) => sql`${status}`),
  sql`, `,
)})`

// INSERT ... SELECT inserts the first lease, and only for a workflow that
// exists and is not terminal: the SELECT yields no row otherwise, so nothing is
// inserted and nothing conflicts. ON CONFLICT takes an existing row over only
// when this runner already holds it or it has expired. The SET expressions read
// the OLD row, so the epoch rises only when the runner changes. When that WHERE
// is false nothing is updated and RETURNING yields no row: the absence is the
// refusal.
const claimStatement = (dagID: string, runnerID: string, now: number) => sql`
  INSERT INTO dag_runner (dag_id, runner_id, epoch, expires_at)
  SELECT id, ${runnerID}, 1, ${now + TTL_MS}
  FROM workflow
  WHERE id = ${dagID} AND status ${nonTerminal}
  ON CONFLICT (dag_id) DO UPDATE SET
    runner_id = excluded.runner_id,
    epoch = CASE WHEN dag_runner.runner_id = excluded.runner_id THEN dag_runner.epoch ELSE dag_runner.epoch + 1 END,
    expires_at = excluded.expires_at
  WHERE dag_runner.runner_id = excluded.runner_id OR dag_runner.expires_at <= ${now}
  RETURNING dag_id, runner_id, epoch, expires_at
`

// Renewal and release match the whole token, the runner AND the epoch: a row
// that names the same runner at a later epoch is another holding.
const renewStatement = (dagID: string, token: Token, now: number) => sql`
  UPDATE dag_runner SET expires_at = ${now + TTL_MS}
  WHERE dag_id = ${dagID} AND runner_id = ${token.runnerID} AND epoch = ${token.epoch}
  RETURNING dag_id
`

const releaseStatement = (dagID: string, token: Token, now: number) => sql`
  UPDATE dag_runner SET expires_at = ${now}
  WHERE dag_id = ${dagID} AND runner_id = ${token.runnerID} AND epoch = ${token.epoch}
  RETURNING dag_id
`

const heldStatement = (dagID: string) => sql`
  SELECT r.dag_id, r.runner_id, r.epoch, r.expires_at
  FROM dag_runner r
  JOIN workflow w ON w.id = r.dag_id
  WHERE r.dag_id = ${dagID} AND w.status ${nonTerminal}
`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      claim: Effect.fn("DagLease.claim")(function* (input) {
        const row = yield* db.get<Row>(claimStatement(input.dagID, input.runnerID, input.now)).pipe(Effect.orDie)
        return row === undefined ? undefined : toLease(row)
      }),

      renew: Effect.fn("DagLease.renew")(function* (input) {
        const row = yield* db.get(renewStatement(input.dagID, input.token, input.now)).pipe(Effect.orDie)
        return row !== undefined
      }),

      release: Effect.fn("DagLease.release")(function* (input) {
        const row = yield* db.get(releaseStatement(input.dagID, input.token, input.now)).pipe(Effect.orDie)
        return row !== undefined
      }),

      held: Effect.fn("DagLease.held")(function* (dagID) {
        const row = yield* db.get<Row>(heldStatement(dagID)).pipe(Effect.orDie)
        return row === undefined ? undefined : toLease(row)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])
