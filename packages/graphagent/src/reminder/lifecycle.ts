// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import type { LifecycleState } from "@graphagent/core/lifecycle/state"
import { valuesOf } from "@graphagent/core/lifecycle/vocabulary"
import { Effect, Layer, Option } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceState } from "@/effect/instance-state"
import { Lifecycle } from "@/lifecycle/service"
import { ReminderStore as Store } from "./store"

/**
 * Registers the reminder domain with the lifecycle service (#1072).
 *
 * The durable `reminder` row is the only authority (the clock keeps nothing but
 * its next wake-up time), so a read is one primary-key lookup. Every row names
 * its owning session, so the session row decides directory ownership, the same
 * rule the job and PR-watch resolvers apply: a reminder of another directory,
 * or of a session that is gone, reads as unknown. An unknown `status` is not a
 * lifecycle value and reads as none instead of failing the read.
 */

const isReminderStatus = (value: string): boolean => valuesOf("reminder").includes(value)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle.Service
    const { db } = yield* Database.Service
    yield* lifecycle.register({
      domain: "reminder",
      read: (id) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const row = yield* Store.rowOf(db, id)
          if (!row || !isReminderStatus(row.status)) return Option.none<LifecycleState<"reminder">>()
          const session = yield* Store.sessionOf(db, row.session_id)
          if (
            !session ||
            DagLocation.canonicalDirectory(session.directory) !== DagLocation.canonicalDirectory(instance.directory)
          )
            return Option.none<LifecycleState<"reminder">>()
          return Option.some(stateOf({ ref: ref("reminder", id), value: row.status, source: "persisted" }))
        }),
    })
  }),
)

// `provideMerge` does not feed the accumulated context into the merged layer
// (see BackgroundLifecycle), so register through a self-contained layer.
// memoMap dedups both dependencies with the AppLayer instances.
export const defaultLayer = layer.pipe(Layer.provide(Lifecycle.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Lifecycle.node, Database.node])

export * as ReminderLifecycle from "./lifecycle"
