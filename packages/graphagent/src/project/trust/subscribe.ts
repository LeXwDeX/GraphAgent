// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared trust-change subscription (T1 PR3).
 *
 * A loader that caches gated values — config files, agents, commands,
 * formatters, LSP servers — must drop that cache when the user decides on a
 * project entry: a newly trusted entry has to take effect without a restart,
 * and a revoked one has to stop immediately.
 *
 * Subscriptions are per-directory. A layer is constructed before any instance
 * exists, so `InstanceRef` is not available there; callers create a small
 * `InstanceState` whose init runs under the directory's context and holds the
 * subscription in that directory's scope.
 */
import { ProjectTrust as ProjectTrustEvent } from "@graphagent/schema/project-trust"
import { Effect, Option, Scope, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"

/**
 * Run `reload` whenever this directory's `project.trust.updated` event fires.
 * Without the event service (partial test wiring) this is a no-op.
 */
export function watchTrustChanges(
  ctx: InstanceContext,
  reload: Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
    if (!events) return
    yield* events.all().pipe(
      Stream.filter((event) => event.type === ProjectTrustEvent.Event.Updated.type),
      Stream.filter((event) => event.location?.directory === ctx.directory),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
}

/**
 * Per-directory watcher state. Read it before reading a gated cache: its first
 * lookup subscribes the directory, and a later trust decision then invalidates
 * the cache before the next read. The subscription closes with the directory.
 */
export function watchTrustState<A, E, R>(state: InstanceState<A, E, R>) {
  return InstanceState.make(
    Effect.fnUntraced(function* (ctx: InstanceContext) {
      yield* watchTrustChanges(ctx, InstanceState.invalidate(state))
      return true as const
    }),
  )
}

export * as TrustSubscribe from "./subscribe"