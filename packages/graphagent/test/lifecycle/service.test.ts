// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"
import { AbsolutePath } from "@graphagent/core/schema"
import type { Domain } from "@graphagent/schema/lifecycle-status"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle, LifecycleReadError } from "@/lifecycle/service"
import type { TurnOutcome as DecideTurnOutcome } from "@/session/turn/decide"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { testEffect } from "../lib/effect"

/**
 * Issue #1069 P2: the cross-domain lifecycle service. The bridge and a real
 * in-memory event bus run underneath, so location stamping and transient
 * publication are exercised end to end. Resolvers are fakes: production
 * resolvers arrive with their owning domains.
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const it = testEffect(Layer.mergeAll(database, events, bridge, Lifecycle.layer.pipe(Layer.provide(bridge))))

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the service reads only the directory for location stamping.
const instance = {
  directory: "/tmp/lifecycle-test",
  worktree: "/tmp/lifecycle-test",
  project: { id: "prj_lifecycle" },
} as unknown as InstanceContext

/** Erase required/optional marker differences so the two unions compare field for field. */
type Optionalize<T> = T extends unknown ? { [K in keyof T]?: T[K] } : never
/** `session.turn.settled` mirrors the loop decision union field for field. */
expectTypeOf<Optionalize<LifecycleEvent.TurnOutcome>>().toEqualTypeOf<Optionalize<DecideTurnOutcome>>()

/** Capture every lifecycle transition published during the test body. */
const watchLifecycle = Effect.fnUntraced(function* () {
  const eventsService = yield* EventV2.Service
  const seen = yield* Ref.make<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>([])
  yield* eventsService.all().pipe(
    Stream.filter((event) => event.type === LifecycleEvent.Transitioned.type),
    Stream.runForEach((event) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- filter narrowed the event type but not the payload generic.
      Ref.update(seen, (list) => [...list, event as EventV2.Payload<typeof LifecycleEvent.Transitioned>]),
    ),
    // Subscribe before the test body publishes: a plain fork may schedule the
    // stream after the first transition.
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

describe("lifecycle transition", () => {
  it.live("publishes an allowed transition once with the instance location", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const seen = yield* watchLifecycle()

      const result = yield* lifecycle
        .transition({ ref: ref("turn", "turn-1"), expect: null, to: "running" })
        .pipe(Effect.provideService(InstanceRef, instance))
      expect(result).toEqual({ published: true })

      yield* Effect.sleep("20 millis")
      const captured = yield* Ref.get(seen)
      expect(captured).toHaveLength(1)
      const event = captured[0]
      expect(event.data).toMatchObject({
        domain: "turn",
        stateID: "turn-1",
        to: "running",
        phase: "running",
      })
      expect(event.data.sessionID).toBeUndefined()
      expect(event.data.from).toBeUndefined()
      expect(event.location?.directory).toBe(AbsolutePath.make(instance.directory))
    }),
  )

  it.live("registers the job table so settling is observable but one-way", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const seen = yield* watchLifecycle()

      expect(
        yield* lifecycle
          .transition({ ref: ref("job", "job-1"), expect: null, to: "running", sessionID: "ses_job" })
          .pipe(Effect.provideService(InstanceRef, instance)),
      ).toEqual({ published: true })
      expect(
        yield* lifecycle
          .transition({ ref: ref("job", "job-1"), expect: "running", to: "settling", sessionID: "ses_job" })
          .pipe(Effect.provideService(InstanceRef, instance)),
      ).toEqual({ published: true })
      expect(
        yield* lifecycle
          .transition({ ref: ref("job", "job-1"), expect: "settling", to: "running" })
          .pipe(Effect.provideService(InstanceRef, instance)),
      ).toEqual({ published: false, reason: "invalid" })
      expect(
        yield* lifecycle
          .transition({ ref: ref("job", "job-1"), expect: "settling", to: "completed" })
          .pipe(Effect.provideService(InstanceRef, instance)),
      ).toEqual({ published: true })

      yield* Effect.sleep("20 millis")
      expect((yield* Ref.get(seen)).map((event) => event.data)).toMatchObject([
        { domain: "job", stateID: "job-1", sessionID: "ses_job", to: "running" },
        { domain: "job", stateID: "job-1", sessionID: "ses_job", to: "settling", phase: "settling" },
        { domain: "job", stateID: "job-1", to: "completed", phase: "succeeded" },
      ])
    }),
  )

  it.live("carries the declared from, phase, reason and session", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const seen = yield* watchLifecycle()

      const result = yield* lifecycle.transition({
        ref: ref("turn", "turn-2"),
        expect: "running",
        to: "ended",
        phase: "succeeded",
        reason: "loop finished",
        sessionID: "ses_lifecycle",
      })
      expect(result).toEqual({ published: true })

      yield* Effect.sleep("20 millis")
      const event = (yield* Ref.get(seen))[0]
      expect(event.data).toMatchObject({
        domain: "turn",
        stateID: "turn-2",
        sessionID: "ses_lifecycle",
        from: "running",
        to: "ended",
        phase: "succeeded",
        reason: "loop finished",
      })
    }),
  )

  it.live("registers the goal table with overwrite-on-set semantics", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service

      expect(
        yield* lifecycle.transition({ ref: ref("goal", "ses_goal"), expect: null, to: "active", sessionID: "ses_goal" }),
      ).toEqual({ published: true })
      expect(yield* lifecycle.transition({ ref: ref("goal", "ses_goal"), expect: "active", to: "waiting" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("goal", "ses_goal"), expect: "waiting", to: "paused" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("goal", "ses_goal"), expect: "paused", to: "active" })).toEqual({
        published: true,
      })
      // Completion deletes the live row; `done` is durable history only.
      expect(yield* lifecycle.transition({ ref: ref("goal", "ses_goal"), expect: "active", to: "done" })).toEqual({
        published: false,
        reason: "invalid",
      })
    }),
  )

  it.live("validates the DAG domains through the read-only bridge", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service

      expect(yield* lifecycle.transition({ ref: ref("workflow", "wf-1"), expect: null, to: "pending" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("workflow", "wf-1"), expect: "pending", to: "running" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("workflow", "wf-1"), expect: "running", to: "paused" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("workflow", "wf-1"), expect: "completed", to: "running" })).toEqual({
        published: false,
        reason: "invalid",
      })
      expect(yield* lifecycle.transition({ ref: ref("node", "node-1"), expect: null, to: "pending" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("node", "node-1"), expect: "running", to: "aborted" })).toEqual({
        published: true,
      })
      expect(yield* lifecycle.transition({ ref: ref("node", "node-1"), expect: "skipped", to: "running" })).toEqual({
        published: false,
        reason: "invalid",
      })
    }),
  )

  it.live("rejects duplicate, invalid, unknown-state and unregistered transitions without publishing", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const seen = yield* watchLifecycle()

      expect(yield* lifecycle.transition({ ref: ref("turn", "turn-3"), expect: "running", to: "running" })).toEqual({
        published: false,
        reason: "duplicate",
      })
      expect(yield* lifecycle.transition({ ref: ref("turn", "turn-3"), expect: "running", to: "failed" })).toEqual({
        published: false,
        reason: "invalid",
      })
      expect(yield* lifecycle.transition({ ref: ref("turn", "turn-3"), expect: "running", to: "ended" })).toEqual({
        published: false,
        reason: "unknown-state",
      })
      expect(yield* lifecycle.transition({ ref: ref("mailbox", "mb-1"), expect: null, to: "queued" })).toEqual({
        published: false,
        reason: "unregistered-domain",
      })

      yield* Effect.sleep("20 millis")
      expect(yield* Ref.get(seen)).toHaveLength(0)
    }),
  )
})

describe("lifecycle state reads", () => {
  it.live("returns none for a domain without a registered resolver", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      expect(Option.isNone(yield* lifecycle.get(ref("goal", "goal-1")))).toBe(true)
    }),
  )

  it.live("returns the state a registered resolver observes", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const observed = stateOf({
        ref: ref("goal", "goal-1"),
        value: "active",
        source: "persisted",
        observedAt: 42,
      })
      yield* lifecycle.register({ domain: "goal", read: () => Effect.succeed(Option.some(observed)) })

      expect(Option.getOrUndefined(yield* lifecycle.get(ref("goal", "goal-1")))).toEqual(observed)
    }),
  )

  it.live("surfaces a resolver failure as LifecycleReadError instead of none", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      yield* lifecycle.register({ domain: "hook", read: () => Effect.die(new Error("resolver exploded")) })

      const error = yield* lifecycle.get(ref("hook", "hook-1")).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LifecycleReadError)
      expect(error.domain).toBe("hook")
      expect(error.id).toBe("hook-1")
      expect(error.message).toContain("resolver exploded")
    }),
  )

  it.live("lets a later registration replace the resolver for a domain", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const domain: Domain = "tool"
      yield* lifecycle.register({
        domain,
        read: () =>
          Effect.succeed(Option.some(stateOf({ ref: ref(domain, "tool-1"), value: "pending", source: "live" }))),
      })
      yield* lifecycle.register({
        domain,
        read: () =>
          Effect.succeed(Option.some(stateOf({ ref: ref(domain, "tool-1"), value: "completed", source: "live" }))),
      })

      expect((yield* lifecycle.get(ref("tool", "tool-1"))).pipe(Option.getOrUndefined)?.value).toBe("completed")
    }),
  )
})
