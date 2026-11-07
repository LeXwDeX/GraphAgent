import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const fixture = Effect.gen(function* () {
  const committed = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const barrier = { armed: false }
  const events = Layer.effect(
    EventV2Bridge.Service,
    Effect.gen(function* () {
      const actual = yield* EventV2Bridge.Service
      const publish: EventV2Bridge.Service["Service"]["publish"] = (definition, data, options) =>
        Effect.gen(function* () {
          const event = yield* actual.publish(definition, data, options)
          if (barrier.armed && definition.type === GoalEvent.Updated.type) {
            barrier.armed = false
            // The durable Goal transaction has committed. Pause its publisher
            // before the caller can update the shared automation lease.
            yield* Deferred.succeed(committed, undefined)
            yield* Deferred.await(release)
          }
          return event
        })
      return EventV2Bridge.Service.of({ ...actual, publish })
    }),
  ).pipe(Layer.provide(EventV2Bridge.defaultLayer))
  const layer = Goal.layer.pipe(
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(events),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
  )
  return { layer, barrier, committed: Deferred.await(committed), release: Deferred.succeed(release, undefined) }
})

describe("Goal lease follows durable authority across delayed registration", () => {
  it.live("closing the real Goal layer releases its authority from a longer-lived shared lease", () =>
    Effect.gen(function* () {
      const memo = yield* Layer.makeMemoMap
      const outer = yield* Scope.Scope
      const leaseContext = yield* Layer.buildWithMemoMap(SessionAutomationLease.defaultLayer, memo, outer)
      const lease = Context.get(leaseContext, SessionAutomationLease.Service)
      const inner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(inner, Exit.void))
      const goalContext = yield* Layer.buildWithMemoMap(Goal.defaultLayer, memo, inner)
      const goal = Context.get(goalContext, Goal.Service)
      const sid = SessionID.descending()
      const active = yield* goal.set(sid, "original goal")
      const owner = { kind: "goal" as const, id: active.goal_id! }
      expect(Option.isSome(yield* lease.claim(sid, owner))).toBe(true)
      const dag = { kind: "dag" as const, id: "longer-lived-dag" }
      yield* lease.register(sid, dag)
      yield* Scope.close(inner, Exit.void)
      expect(Option.isSome(yield* lease.claim(sid, { kind: "dag" }))).toBe(true)
      yield* lease.unregister(sid, dag)
      expect(Option.isNone(yield* lease.claim(sid, owner))).toBe(true)
      yield* lease.register(sid, { kind: "goal", id: "fixture-goal" })
      expect(Option.isSome(yield* lease.claim(sid, { kind: "goal", id: "fixture-goal" }))).toBe(true)
    }),
  )

  it.live("pause and resume of the same Goal id never revive its old lease token", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      yield* Effect.gen(function* () {
        const goal = yield* Goal.Service
        const lease = yield* SessionAutomationLease.Service
        const sid = SessionID.descending()
        const original = yield* goal.set(sid, "original goal")
        const owner = { kind: "goal" as const, id: original.goal_id! }
        const token = Option.getOrThrow(yield* lease.claim(sid, owner))
        yield* goal.pause(sid, "user-paused")
        yield* goal.resume(sid)
        expect(Option.isSome(yield* lease.claim(sid, owner))).toBe(true)
        expect(Option.isNone(yield* lease.use(token, Effect.void))).toBe(true)
        let prepared = false
        expect(
          Option.isNone(
            yield* lease.handoff(
              token,
              Effect.sync(() => {
                prepared = true
                return Option.none()
              }),
            ),
          ),
        ).toBe(true)
        expect(prepared).toBe(false)
      }).pipe(Effect.provide(test.layer))
    }),
  )

  for (const action of ["clear", "pause", "replace"] as const) {
    it.live(`a late set registration cannot undo ${action}`, () =>
      Effect.gen(function* () {
        const test = yield* fixture
        yield* Effect.gen(function* () {
          const goal = yield* Goal.Service
          const lease = yield* SessionAutomationLease.Service
          const sid = SessionID.descending()
          test.barrier.armed = true
          const setting = yield* goal.set(sid, "original goal").pipe(Effect.forkScoped)
          yield* test.committed
          if (action === "clear") yield* goal.clear(sid)
          else if (action === "pause") yield* goal.pause(sid, "user-paused")
          else yield* goal.set(sid, "replacement goal")
          yield* test.release
          const old = yield* Fiber.join(setting)
          expect(Option.isNone(yield* lease.claim(sid, { kind: "goal", id: old.goal_id! }))).toBe(true)
          const current =
            action === "pause"
              ? yield* goal.resume(sid)
              : action === "clear"
                ? yield* goal.set(sid, "next goal")
                : yield* goal.load(sid)
          expect(current?.status).toBe("active")
          expect(Option.isSome(yield* lease.claim(sid, { kind: "goal", id: current!.goal_id! }))).toBe(true)
          // A stale caller must not append its observed id over the current row.
          yield* lease.register(sid, { kind: "goal", id: "obsolete-observation" })
          expect(Option.isNone(yield* lease.claim(sid, { kind: "goal", id: "obsolete-observation" }))).toBe(true)
          expect(Option.isSome(yield* lease.claim(sid, { kind: "goal", id: current!.goal_id! }))).toBe(true)
        }).pipe(Effect.provide(test.layer), Effect.timeout("5 seconds"))
      }),
    )
  }

  for (const action of ["clear", "pause", "replace"] as const) {
    it.live(`a late resume registration cannot undo ${action}`, () =>
      Effect.gen(function* () {
        const test = yield* fixture
        yield* Effect.gen(function* () {
          const goal = yield* Goal.Service
          const lease = yield* SessionAutomationLease.Service
          const sid = SessionID.descending()
          const old = yield* goal.set(sid, "original goal")
          yield* goal.pause(sid, "user-paused")
          test.barrier.armed = true
          const resuming = yield* goal.resume(sid).pipe(Effect.forkScoped)
          yield* test.committed
          if (action === "clear") yield* goal.clear(sid)
          else if (action === "pause") yield* goal.pause(sid, "paused again")
          else yield* goal.set(sid, "replacement goal")
          yield* test.release
          yield* Fiber.join(resuming)
          expect(Option.isNone(yield* lease.claim(sid, { kind: "goal", id: old.goal_id! }))).toBe(true)
          const current =
            action === "pause"
              ? yield* goal.resume(sid)
              : action === "clear"
                ? yield* goal.set(sid, "next goal")
                : yield* goal.load(sid)
          expect(current?.status).toBe("active")
          expect(Option.isSome(yield* lease.claim(sid, { kind: "goal", id: current!.goal_id! }))).toBe(true)
        }).pipe(Effect.provide(test.layer), Effect.timeout("5 seconds"))
      }),
    )
  }

  it.live("a late pause unregistration cannot remove a resumed active goal", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      yield* Effect.gen(function* () {
        const goal = yield* Goal.Service
        const lease = yield* SessionAutomationLease.Service
        const sid = SessionID.descending()
        const original = yield* goal.set(sid, "original goal")
        test.barrier.armed = true
        const pausing = yield* goal.pause(sid, "user-paused").pipe(Effect.forkScoped)
        yield* test.committed
        yield* goal.resume(sid)
        yield* test.release
        yield* Fiber.join(pausing)
        expect((yield* goal.load(sid))?.status).toBe("active")
        expect(Option.isSome(yield* lease.claim(sid, { kind: "goal", id: original.goal_id! }))).toBe(true)
      }).pipe(Effect.provide(test.layer), Effect.timeout("5 seconds"))
    }),
  )
})
