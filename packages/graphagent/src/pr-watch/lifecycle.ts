// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as PrWatchLifecycle from "./lifecycle"

import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import type { LifecycleState } from "@graphagent/core/lifecycle/state"
import { valuesOf } from "@graphagent/core/lifecycle/vocabulary"
import { SessionTable } from "@graphagent/core/session/sql"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceState } from "@/effect/instance-state"
import { Lifecycle } from "@/lifecycle/service"

/**
 * Registers the pr_watch domain with the lifecycle service (#1071 PR1).
 *
 * The process-level poller (a later PR) owns live watches. Until it lands this
 * resolver answers only from the durable `pr_watch` row, which is also the
 * record a restarted process resumes from. An unknown `phase` is not a
 * lifecycle value and reads as none instead of failing the read.
 *
 * The row names its owning session, so the session row decides directory
 * ownership, the same rule the job resolver applies. A row whose session is
 * gone is not provably ours and stays hidden.
 */

const isPrWatchPhase = (value: string): boolean => valuesOf("pr_watch").includes(value)

const ownsRow = (db: Database.Interface["db"], sessionID: string, directory: string) =>
  Effect.gen(function* () {
    const session = yield* db
      .select({ directory: SessionTable.directory })
      .from(SessionTable)
      // A bound comparison: the row is not guaranteed to hold a valid
      // SessionID, and building the brand would throw instead of missing.
      .where(sql`${SessionTable.id} = ${sessionID}`)
      .get()
      .pipe(Effect.orDie)
    if (!session) return false
    return DagLocation.canonicalDirectory(session.directory) === DagLocation.canonicalDirectory(directory)
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle.Service
    const { db } = yield* Database.Service
    yield* lifecycle.register({
      domain: "pr_watch",
      read: (id) =>
        Effect.gen(function* () {
          const row = yield* db.select().from(PrWatchTable).where(eq(PrWatchTable.id, id)).get().pipe(Effect.orDie)
          if (!row || !isPrWatchPhase(row.phase)) return Option.none<LifecycleState<"pr_watch">>()
          const instance = yield* InstanceState.context
          if (!(yield* ownsRow(db, row.session_id, instance.directory)))
            return Option.none<LifecycleState<"pr_watch">>()
          return Option.some(stateOf({ ref: ref("pr_watch", id), value: row.phase, source: "persisted" }))
        }),
    })
  }),
)

// `provideMerge` does not feed the accumulated context into the merged layer
// (see BackgroundLifecycle), so register through a self-contained layer.
// memoMap dedups both dependencies with the AppLayer instances.
export const defaultLayer = layer.pipe(Layer.provide(Lifecycle.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Lifecycle.node, Database.node])