// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as EventResidueSweep from "./residue-sweep"

import { Cause, Context, Effect, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"

/**
 * #524 Phase 1: default-on residue sweep for crash/in-flight zombies.
 *
 * Session.remove scrubs its session aggregate and every related dag aggregate
 * (terminal workflows included), but a crash between the session-row delete
 * and the scrub — or a project cascade that removes read-model rows without
 * any remove call — leaves durable event aggregates whose SessionTable and
 * WorkflowTable read models are BOTH gone. Read models commit atomically with
 * an aggregate's first event (the projectors run inside the publish
 * transaction), so "events visible, both read models absent" is exactly the
 * zombie shape. Live sessions, archived sessions (they keep their row), and
 * live workflows never match the predicate.
 *
 * Removal is a single atomic guarded DELETE (see `removeResidue`): the
 * both-read-models-absent guard is re-evaluated inside the delete statement
 * itself, so a read model a concurrent replay/publish recreates after
 * candidate selection survives — there is no select-then-remove TOCTOU
 * window. Soft-degrading: a failed residue read or a failed per-aggregate
 * removal is logged and left for a later pass — the sweep never fails the
 * application path. The Durable manifest only contains session- and
 * dag-family events, so every aggregate id in event_sequence is keyed by one
 * of the two checked read models.
 */

export interface Interface {
  /** One sweep pass. Returns the number of residue aggregates removed. */
  readonly sweepOnce: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/EventResidueSweep") {}

/**
 * Selection half of the sweep pass. Exported as the seam that lets tests
 * deterministically interleave a concurrent read-model recreation between
 * candidate selection and deletion (no sleeps).
 */
export const selectResidues = (db: Database.Interface["db"]) =>
  db.all<{ aggregate_id: string }>(sql`
    SELECT aggregate_id FROM event_sequence
    WHERE NOT EXISTS (SELECT 1 FROM session WHERE session.id = event_sequence.aggregate_id)
      AND NOT EXISTS (SELECT 1 FROM workflow WHERE workflow.id = event_sequence.aggregate_id)
  `)

/**
 * Removal half of the sweep pass — the atomic guarded delete. The NOT EXISTS
 * guards are re-evaluated inside the DELETE statement itself, so a read model
 * recreated between candidate selection and this statement survives; the
 * aggregate is only deleted while it is still a zombie. PRAGMA foreign_keys
 * is ON on the Database layer's connection, so the delete cascades to the
 * aggregate's event rows, and RETURNING makes the removed result reliable
 * instead of inferred. Exported for the same test seam as `selectResidues`.
 */
export const removeResidue = (db: Database.Interface["db"], aggregateID: string) =>
  db
    .all<{ aggregate_id: string }>(sql`
      DELETE FROM event_sequence
      WHERE aggregate_id = ${aggregateID}
        AND NOT EXISTS (SELECT 1 FROM session WHERE session.id = event_sequence.aggregate_id)
        AND NOT EXISTS (SELECT 1 FROM workflow WHERE workflow.id = event_sequence.aggregate_id)
      RETURNING aggregate_id
    `)
    .pipe(Effect.map((rows) => rows.length > 0))

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope

    const sweepOnce = Effect.fn("EventResidueSweep.sweepOnce")(function* () {
      const residues = yield* selectResidues(db).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                yield* Effect.logWarning("EventResidueSweep residue query failed — skipping pass", { cause })
                return [] as Array<{ aggregate_id: string }>
              }),
        ),
      )

      let removed = 0
      for (const residue of residues) {
        const done = yield* removeResidue(db, residue.aggregate_id).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.gen(function* () {
                  yield* Effect.logWarning("EventResidueSweep failed to remove a residue aggregate — left for a later pass", {
                    aggregateID: residue.aggregate_id,
                    cause,
                  })
                  return false
                }),
          ),
        )
        if (done) removed++
      }
      if (removed > 0) yield* Effect.logInfo("EventResidueSweep removed orphaned event aggregates", { removed })
      return removed
    })

    // Default-on: one pass per process start, forked into the layer scope so
    // it can neither block nor fail startup (the AGENTS.md background-loop
    // convention — no caller has to remember to init it).
    yield* sweepOnce().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning("EventResidueSweep startup pass failed", { cause }),
      ),
      Effect.forkIn(scope),
    )

    return Service.of({ sweepOnce })
  }),
)

export const defaultLayer = serviceLayer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(serviceLayer, [Database.node])
