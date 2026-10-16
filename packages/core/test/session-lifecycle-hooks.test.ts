import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { Location } from "@opencode-ai/core/location"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionLifecycleHooks } from "@opencode-ai/core/session/lifecycle-hooks"
import { SessionTurnHooks } from "@opencode-ai/core/session/turn-hooks"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { testEffect } from "./lib/effect"

const calls: string[] = []
const execution = Layer.succeed(SessionExecution.Service, {
  wake: () => Effect.void,
  resume: () => Effect.void,
  interrupt: () =>
    Effect.sync(() => {
      calls.push("interrupt")
    }),
})
const sessions = SessionV2.layer.pipe(
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(execution),
)
const hooks = Layer.mock(SessionTurnHooks.Service, {
  invalidateRewake: () =>
    Effect.sync(() => {
      calls.push("invalidate")
    }),
})
const it = testEffect(Layer.mergeAll(sessions, hooks, SessionProjector.defaultLayer))
it.live("V2 interrupt reaches execution while the lifecycle admission lock is held", () =>
  Effect.gen(function* () {
    calls.length = 0
    const id = SessionV2.ID.make("ses_cancel_lifecycle")
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const owner = yield* SessionLifecycleHooks.withLock(
      id,
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const cancelling = yield* (yield* SessionV2.Service).interrupt(id).pipe(Effect.forkChild)
    yield* Effect.sleep("10 millis")
    expect(calls).toEqual(["interrupt"])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(owner)
    yield* Fiber.join(cancelling)
    expect(calls).toEqual(["interrupt"])
  }),
)

it.live("V2 cancellation supplies the session location and still interrupts after a host hook defect", () =>
  Effect.gen(function* () {
    calls.length = 0
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const service = yield* SessionV2.Service
    const current = yield* service.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
    })
    const hook = Layer.mock(SessionTurnHooks.Service, {
      invalidateRewake: () =>
        Effect.gen(function* () {
          const location = Option.getOrThrow(yield* Effect.serviceOption(Location.Service))
          expect(String(location.directory)).toBe(directory.path)
          calls.push("invalidate")
          return yield* Effect.die(new Error("host invalidation defect"))
        }),
    })
    yield* service.interrupt(current.id).pipe(Effect.provide(hook))
    expect(calls).toEqual(["invalidate", "interrupt"])
  }),
)

it.live("cancellation fences existing admission owners but preserves a later admission", () =>
  Effect.gen(function* () {
    const admissions = SessionAdmission.make()
    const entered = yield* Deferred.make<void>()
    const cancellationEntered = yield* Deferred.make<void>()
    const cancellationRelease = yield* Deferred.make<void>()
    const committed: string[] = []
    const old = yield* admissions
      .run("session", (commit) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
          yield* commit(Effect.sync(() => committed.push("old")))
        }),
      )
      .pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(entered)
    const cancelling = yield* admissions
      .cancel(
        "session",
        Effect.gen(function* () {
          yield* Deferred.succeed(cancellationEntered, undefined)
          yield* Deferred.await(cancellationRelease)
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(cancellationEntered)
    const next = yield* admissions
      .run("session", (commit) => commit(Effect.sync(() => committed.push("new"))))
      .pipe(Effect.forkChild)
    yield* Effect.sleep("10 millis")
    expect(committed).toEqual([])
    yield* Deferred.succeed(cancellationRelease, undefined)
    yield* Fiber.join(cancelling)
    yield* Fiber.join(next)
    expect((yield* Fiber.join(old))._tag).toBe("Failure")
    expect(committed).toEqual(["new"])
  }),
)

it.live("a late uninterruptible hook cannot commit after its admission owner was cancelled", () =>
  Effect.gen(function* () {
    const admissions = SessionAdmission.make()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const committed: string[] = []
    const old = yield* admissions
      .run("session", (commit) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* commit(Effect.sync(() => committed.push("old")))
          }),
        ),
      )
      .pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(entered)
    yield* admissions.cancel("session", Effect.void)
    yield* admissions.run("session", (commit) => commit(Effect.sync(() => committed.push("new"))))
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(old))._tag).toBe("Failure")
    expect(committed).toEqual(["new"])
  }),
)
