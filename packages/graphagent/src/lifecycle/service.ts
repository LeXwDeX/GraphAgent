// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as Lifecycle from "./service"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import type { LifecycleState, StateRef } from "@graphagent/core/lifecycle/state"
import {
  checkTransition,
  JOB_TRANSITION_TABLE,
  TURN_TRANSITION_TABLE,
  type TransitionRequest,
  type TransitionTable,
} from "@graphagent/core/lifecycle/transition"
import type { Domain } from "@graphagent/schema/lifecycle-status"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { SessionID } from "@graphagent/schema/session-id"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"

/**
 * Cross-domain lifecycle state contract (#1069 P2). This is not the session
 * startup hook in `session/lifecycle.ts` (`SessionLifecycle`); it validates and
 * publishes live lifecycle observations across domains.
 *
 * Only the transient `lifecycle.transitioned` event is published. Durable
 * truth for a domain stays with its owner (DAG in `dag.*`, sessions in
 * `session.next.*`), so this service never writes state and never replays.
 */

export class LifecycleReadError extends Schema.TaggedError<LifecycleReadError>()("Lifecycle.ReadError", {
  domain: Schema.String,
  id: Schema.String,
  message: Schema.String,
}) {}

export type TransitionResult = {
  readonly published: boolean
  readonly reason?: "duplicate" | "invalid" | "unknown-state" | "unregistered-domain" | "publish-failed"
}

export interface StateResolver<D extends Domain = Domain> {
  readonly domain: D
  readonly read: (id: string) => Effect.Effect<Option.Option<LifecycleState<D>>, LifecycleReadError>
}

export interface Interface {
  readonly transition: (request: TransitionRequest) => Effect.Effect<TransitionResult>
  readonly get: <D extends Domain>(
    ref: StateRef<D>,
  ) => Effect.Effect<Option.Option<LifecycleState<D>>, LifecycleReadError>
  readonly register: (resolver: StateResolver) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Lifecycle") {}

const tables = new Map<Domain, TransitionTable>([
  ["turn", TURN_TRANSITION_TABLE],
  ["job", JOB_TRANSITION_TABLE],
])

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const resolvers = yield* Ref.make(new Map<Domain, StateResolver>())

    const transition = Effect.fn("Lifecycle.transition")(function* (request: TransitionRequest) {
      const table = tables.get(request.ref.domain)
      if (!table) {
        yield* Effect.logWarning("lifecycle transition for an unregistered domain", {
          domain: request.ref.domain,
          stateID: request.ref.id,
        })
        return { published: false, reason: "unregistered-domain" as const } satisfies TransitionResult
      }
      const check = checkTransition(table, request)
      switch (check.kind) {
        case "duplicate":
          yield* Effect.logWarning("lifecycle transition duplicates the current value", {
            domain: request.ref.domain,
            stateID: request.ref.id,
            value: request.to,
          })
          return { published: false, reason: "duplicate" as const } satisfies TransitionResult
        case "invalid":
          yield* Effect.logWarning("lifecycle transition is not allowed", {
            domain: request.ref.domain,
            stateID: request.ref.id,
            expect: request.expect,
            to: request.to,
            allowed: check.allowed,
          })
          return { published: false, reason: "invalid" as const } satisfies TransitionResult
        case "unknown-from":
        case "unknown-to":
          yield* Effect.logWarning("lifecycle transition names an unknown state", {
            domain: request.ref.domain,
            stateID: request.ref.id,
            expect: request.expect,
            to: request.to,
            value: check.value,
          })
          return { published: false, reason: "unknown-state" as const } satisfies TransitionResult
      }
      // The switch returns for every non-allowed check, so TypeScript narrows
      // what remains to the allowed branch.
      const published = yield* events
        .publish(LifecycleEvent.Transitioned, {
          domain: request.ref.domain,
          stateID: request.ref.id,
          sessionID: request.sessionID === undefined ? undefined : SessionID.make(request.sessionID),
          from: request.expect ?? undefined,
          to: request.to,
          phase: check.phase,
          reason: request.reason,
          timestamp: yield* DateTime.now,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logError("lifecycle transition publish failed", {
              domain: request.ref.domain,
              stateID: request.ref.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        )
      return published ? { published: true } : { published: false, reason: "publish-failed" as const }
    })

    const get = <D extends Domain>(
      stateRef: StateRef<D>,
    ): Effect.Effect<Option.Option<LifecycleState<D>>, LifecycleReadError> =>
      Effect.gen(function* () {
        const registered = (yield* Ref.get(resolvers)).get(stateRef.domain)
        if (!registered) return Option.none<LifecycleState<D>>()
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the registry key is the resolver's own domain, so the narrowing to D is sound.
        const resolver = registered as StateResolver<D>
        return yield* resolver.read(stateRef.id).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.fail(
                new LifecycleReadError({
                  domain: stateRef.domain,
                  id: stateRef.id,
                  message: Cause.pretty(cause),
                }),
              ),
          ),
        )
      })

    const register = Effect.fn("Lifecycle.register")(function* (resolver: StateResolver) {
      yield* Ref.update(resolvers, (current) => {
        const next = new Map(current)
        next.set(resolver.domain, resolver)
        return next
      })
    })

    return Service.of({ transition, get, register })
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))

export const node = LayerNode.make(layer, [EventV2Bridge.node])
