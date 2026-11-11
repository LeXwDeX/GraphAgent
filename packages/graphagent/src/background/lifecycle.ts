// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as BackgroundLifecycle from "./lifecycle"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import type { LifecycleState } from "@graphagent/core/lifecycle/state"
import { Effect, Layer, Option } from "effect"
import { Lifecycle } from "@/lifecycle/service"
import { BackgroundJob } from "./job"

/**
 * Registers the job domain with the lifecycle service (#1069 P7).
 *
 * The registry in `background/job.ts` remains the only writer of job state.
 * This layer only exposes it through `Lifecycle.get`, so a waiter (goal await,
 * inbox, TUI) can validate a `StateRef` against the shared contract instead of
 * keeping a private copy. Registration is a build-time side effect; every read
 * hits the live registry.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const lifecycle = yield* Lifecycle.Service
    yield* lifecycle.register({
      domain: "job",
      read: (id) =>
        Effect.gen(function* () {
          const job = yield* jobs.get(id)
          if (!job) return Option.none<LifecycleState<"job">>()
          return Option.some(stateOf({ ref: ref("job", id), value: job.status, source: "live" }))
        }),
    })
  }),
)

// `provideMerge` does not feed the accumulated context into the merged layer
// (see GoalLoop.defaultLayer), so register through a self-contained layer.
// memoMap dedups both dependencies with the AppLayer instances, keeping the
// resolver on the same Lifecycle and BackgroundJob the rest of the runtime
// uses.
export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Lifecycle.defaultLayer),
)

export const node = LayerNode.make(layer, [BackgroundJob.node, Lifecycle.node])
