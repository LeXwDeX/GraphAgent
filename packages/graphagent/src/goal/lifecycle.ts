// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as GoalLifecycle from "./lifecycle"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import type { LifecycleState } from "@graphagent/core/lifecycle/state"
import { Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Lifecycle } from "@/lifecycle/service"
import { SessionID } from "@/session/schema"
import { Goal } from "./goal"

/**
 * Registers the goal domain with the lifecycle service (#1069).
 *
 * `goal_state` stays the durable owner: this layer only exposes its current
 * row through `Lifecycle.get`, reading the live value on every call. Goal
 * state has no directory column, so the session row is the ownership
 * authority (the same `Goal.ownsSession` check the goal loop uses): a ref from
 * another directory reads as unknown rather than leaking across instances.
 *
 * `id` is the session id. Completion deletes the row and keeps the terminal
 * snapshot in `goal_outcome`, so a finished goal reads as none here and
 * removal is announced by `goal.cleared`, not by a lifecycle value.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const goals = yield* Goal.Service
    const lifecycle = yield* Lifecycle.Service
    yield* lifecycle.register({
      domain: "goal",
      read: (id) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(id)
          const instance = yield* InstanceState.context
          if (!(yield* Goal.ownsSession(sessionID, instance.directory)))
            return Option.none<LifecycleState<"goal">>()
          const state = yield* goals.load(sessionID)
          if (!state) return Option.none<LifecycleState<"goal">>()
          return Option.some(stateOf({ ref: ref("goal", id), value: state.status, source: "persisted" }))
        }),
    })
  }),
)

// `provideMerge` does not feed the accumulated context into the merged layer
// (see BackgroundLifecycle), so register through a self-contained layer.
// memoMap dedups both dependencies with the AppLayer instances.
export const defaultLayer = layer.pipe(
  Layer.provide(Goal.defaultLayer),
  Layer.provide(Lifecycle.defaultLayer),
)

export const node = LayerNode.make(layer, [Goal.node, Lifecycle.node])
