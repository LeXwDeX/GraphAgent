import { expect, spyOn } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Latch, Layer } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { BackgroundJob } from "@/background/job"
import { SessionCancellation } from "@/session/cancellation"
import { SessionRunState } from "@/session/run-state"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const writes = new Map<SessionID, (info: SessionStatus.Info) => Effect.Effect<void>>()
const it = testEffect(
  SessionRunState.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BackgroundJob.Service, { list: () => Effect.succeed([]) }),
        Layer.mock(SessionStatus.Service, {
          set: (id, info) => Effect.suspend(() => writes.get(id)?.(info) ?? Effect.void),
        }),
      ),
    ),
  ),
)

const fallbackSession = SessionID.create()
const fallbackCancelled: string[] = []
const fallback = testEffect(
  SessionRunState.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BackgroundJob.Service, {
          list: () =>
            Effect.succeed([
              {
                id: "marked",
                type: "watch_pr",
                status: "running",
                started_at: 0,
                metadata: { sessionId: fallbackSession, survivesSessionCancel: true },
              },
              {
                id: "uncoordinated",
                type: "test",
                status: "running",
                started_at: 0,
                metadata: { sessionId: fallbackSession },
              },
            ]),
          capture: () => Effect.succeed(undefined),
          cancel: (id) =>
            Effect.sync(() => {
              fallbackCancelled.push(id)
              return undefined
            }),
        }),
        Layer.mock(SessionStatus.Service, {}),
      ),
    ),
  ),
)

fallback.live("local cleanup keeps marked jobs and cancels uncoordinated jobs", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    yield* runs.cancelBackground(fallbackSession, true)
    expect(fallbackCancelled).toEqual(["uncoordinated"])
  }),
)

it.instance("failed start unregisters the owner and restores idle", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const seen: string[] = []
    writes.set(id, (info) =>
      Effect.sync(() => seen.push(info.type)).pipe(
        Effect.andThen(info.type === "busy" ? Effect.die("start failed") : Effect.void),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => writes.delete(id)))
    const result = yield* runs.ensureRunningHandle(id, Effect.die("interrupted"), Effect.never).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(seen).toEqual(["busy", "idle"])
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    expect(abort.owners).toHaveLength(0)
  }),
)

it.instance("completion during start handoff publishes idle", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const release = yield* Deferred.make<void>()
    const completed = yield* Deferred.make<void>()
    const statuses: string[] = []
    let isBusy = () => true
    const make = Runner.make
    const spy = spyOn(Runner, "make").mockImplementation((scope, opts) => {
      const inner = make(scope, opts)
      isBusy = () => inner.busy
      return {
        ...inner,
        get busy() {
          return inner.busy
        },
        get state() {
          return inner.state
        },
        ensureRunningHandle: (work) => inner.ensureRunningHandle(work).pipe(Effect.tap(() => Deferred.await(release))),
      }
    })
    writes.set(id, (info) => Effect.sync(() => statuses.push(info.type)).pipe(Effect.asVoid))
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        spy.mockRestore()
        writes.delete(id)
        yield* Deferred.succeed(release, undefined)
      }),
    )
    const message = {
      info: {
        id: MessageID.ascending(),
        sessionID: id,
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
      parts: [],
    }
    const starting = yield* runs
      .ensureRunningHandle(
        id,
        Effect.die("interrupted"),
        Deferred.succeed(completed, undefined).pipe(Effect.as(message)),
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(completed), "run did not complete")
    yield* awaitWithTimeout(
      Effect.gen(function* () {
        while (isBusy()) yield* Effect.yieldNow
      }),
      "runner did not reach idle during handoff",
    )
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(starting)
    expect(yield* awaitWithTimeout(result, "completed run did not return")).toEqual(message)
    expect(statuses).toEqual(["busy", "idle"])
  }),
)

it.instance("cancellation intent does not wait for an in-flight idle publication", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    writes.set(id, (info) =>
      info.type === "idle"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        writes.delete(id)
        yield* Deferred.succeed(finish, undefined)
        yield* Deferred.succeed(release, undefined)
      }),
    )
    const message = {
      info: {
        id: MessageID.ascending(),
        sessionID: id,
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
      parts: [],
    }
    const run = yield* runs.ensureRunningHandle(
      id,
      Effect.die("interrupted"),
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)), Effect.as(message)),
    )
    yield* awaitWithTimeout(Deferred.await(started), "runner did not start")
    yield* Deferred.succeed(finish, undefined)
    yield* awaitWithTimeout(Deferred.await(entered), "idle publication did not start")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    expect(SessionCancellation.goalCancelPending(id)).toBe(true)
    yield* Deferred.succeed(release, undefined)
    yield* awaitWithTimeout(run, "run did not finish")
    abort.finish()
  }),
)

it.instance("delayed idle cannot overwrite a later run", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const firstStarted = yield* Deferred.make<void>()
    const firstRelease = yield* Deferred.make<void>()
    const waiting = yield* Deferred.make<void>()
    const idleRelease = yield* Deferred.make<void>()
    const checked = Deferred.makeUnsafe<void>()
    const laterStarted = yield* Deferred.make<void>()
    const laterRelease = yield* Deferred.make<void>()
    const statuses: string[] = []
    let observeCheck = false
    const make = Runner.make
    const makeSpy = spyOn(Runner, "make").mockImplementation((scope, opts) => {
      const inner = make(scope, opts)
      return {
        ...inner,
        get busy() {
          return inner.busy
        },
        get state() {
          if (observeCheck) Deferred.doneUnsafe(checked, Effect.void)
          return inner.state
        },
      }
    })
    const wait = SessionCancellation.waitForGoalCancels
    const waitSpy = spyOn(SessionCancellation, "waitForGoalCancels").mockImplementation((sessionID) =>
      Deferred.succeed(waiting, undefined).pipe(
        Effect.andThen(wait(sessionID)),
        Effect.andThen(Deferred.await(idleRelease)),
      ),
    )
    writes.set(id, (info) => Effect.sync(() => statuses.push(info.type)).pipe(Effect.asVoid))
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        makeSpy.mockRestore()
        waitSpy.mockRestore()
        writes.delete(id)
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Deferred.succeed(idleRelease, undefined)
        yield* Deferred.succeed(laterRelease, undefined)
      }),
    )
    const message = {
      info: {
        id: MessageID.ascending(),
        sessionID: id,
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
      parts: [],
    }
    const first = yield* runs.ensureRunningHandle(
      id,
      Effect.die("interrupted"),
      Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstRelease)), Effect.as(message)),
    )
    yield* awaitWithTimeout(Deferred.await(firstStarted), "first runner did not start")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    yield* Deferred.succeed(firstRelease, undefined)
    yield* awaitWithTimeout(first, "first runner did not finish")
    yield* awaitWithTimeout(Deferred.await(waiting), "idle did not wait for the pause decision")
    expect(statuses).toEqual(["busy"])
    abort.finish()
    const later = yield* runs.ensureRunningHandle(
      id,
      Effect.die("interrupted"),
      Deferred.succeed(laterStarted, undefined).pipe(Effect.andThen(Deferred.await(laterRelease)), Effect.as(message)),
    )
    yield* awaitWithTimeout(Deferred.await(laterStarted), "later runner did not start")
    observeCheck = true
    yield* Deferred.succeed(idleRelease, undefined)
    yield* awaitWithTimeout(Deferred.await(checked), "delayed idle did not check the later runner")
    expect(statuses).toEqual(["busy", "busy"])
    observeCheck = false
    yield* Deferred.succeed(laterRelease, undefined)
    yield* awaitWithTimeout(later, "later runner did not finish")
    expect(statuses).toEqual(["busy", "busy", "idle"])
  }),
)

it.instance("a completed runner cannot mask a later request", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const firstStarted = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const secondStopped = yield* Deferred.make<void>()
    const first = yield* runs.ensureRunningHandle(
      id,
      Effect.die("first interrupted"),
      Deferred.succeed(firstStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.andThen(Effect.never),
      ),
    )
    yield* awaitWithTimeout(Deferred.await(firstStarted), "first runner did not start")
    yield* runs.cancel(id)
    yield* first.pipe(Effect.exit)
    yield* Deferred.succeed(finish, undefined)
    const second = yield* runs.ensureRunningHandle(
      id,
      Effect.die("second interrupted"),
      Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(secondStopped, undefined)),
      ),
    )
    yield* awaitWithTimeout(Deferred.await(secondStarted), "second runner did not start")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    yield* Effect.all(abort.owners)
    yield* awaitWithTimeout(Deferred.await(secondStopped), "second runner was masked by an older epoch")
    yield* second.pipe(Effect.exit)
  }),
)

it.instance("abort fences a runner whose start is already in flight", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let ran = false
    writes.set(id, (info) =>
      info.type === "busy"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        writes.delete(id)
        yield* Deferred.succeed(release, undefined)
      }),
    )
    const start = yield* runs
      .ensureRunningHandle(
        id,
        Effect.die("interrupted"),
        Effect.sync(() => {
          ran = true
        }).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(entered), "runner start did not reach busy status")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    expect(abort.owners).toHaveLength(1)
    const cancel = yield* Effect.all(abort.owners).pipe(Effect.forkChild)
    yield* Deferred.succeed(release, undefined)
    yield* awaitWithTimeout(Fiber.await(cancel), "captured start did not settle")
    const started = yield* awaitWithTimeout(Fiber.await(start), "runner start did not return")
    if (Exit.isSuccess(started)) yield* started.value.pipe(Effect.exit)
    expect(ran).toBe(false)
    abort.finish()
    const after = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(after.finish))
    expect(after.owners).toHaveLength(0)
  }),
)

it.instance("abort settles a shell rejected before initialization and admits the next request", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const ready = yield* Latch.make()
    const laterStarted = yield* Deferred.make<void>()
    let ran = false
    writes.set(id, (info) =>
      info.type === "busy"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        writes.delete(id)
        yield* Deferred.succeed(release, undefined)
        yield* ready.open
      }),
    )
    const shell = yield* runs
      .startShellHandle(
        id,
        Effect.die("interrupted"),
        Effect.sync(() => {
          ran = true
        }).pipe(Effect.andThen(Effect.never)),
        ready,
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(entered), "shell did not reach busy status")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    const cancel = yield* Effect.all(abort.owners).pipe(Effect.forkChild)
    yield* Deferred.succeed(release, undefined)
    yield* awaitWithTimeout(Fiber.await(cancel), "rejected shell blocked cancellation")
    const handle = yield* Fiber.join(shell)
    yield* handle.pipe(Effect.exit)
    expect(ran).toBe(false)
    abort.finish()
    writes.delete(id)
    const later = yield* runs.ensureRunningHandle(
      id,
      Effect.die("interrupted"),
      Deferred.succeed(laterStarted, undefined).pipe(Effect.andThen(Effect.never)),
    )
    yield* awaitWithTimeout(Deferred.await(laterStarted), "later request did not start")
    yield* runs.cancel(id)
    yield* later.pipe(Effect.exit)
  }),
)

it.instance("a request after abort waits and starts its own runner", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    const id = SessionID.create()
    const firstStarted = yield* Deferred.make<void>()
    const firstStopped = yield* Deferred.make<void>()
    const laterStarted = yield* Deferred.make<void>()
    const first = yield* runs.ensureRunningHandle(
      id,
      Effect.die("interrupted"),
      Deferred.succeed(firstStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(firstStopped, undefined)),
      ),
    )
    yield* awaitWithTimeout(Deferred.await(firstStarted), "first runner did not start")
    const abort = SessionCancellation.begin(id)
    yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
    const later = yield* runs
      .ensureRunningHandle(
        id,
        Effect.die("interrupted"),
        Deferred.succeed(laterStarted, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild)
    yield* Effect.all(abort.owners)
    yield* awaitWithTimeout(Deferred.await(firstStopped), "first runner did not stop")
    expect(yield* Deferred.isDone(laterStarted)).toBe(false)
    yield* first.pipe(Effect.exit)
    abort.finish()
    const laterHandle = yield* awaitWithTimeout(Fiber.join(later), "later runner was not admitted")
    yield* awaitWithTimeout(Deferred.await(laterStarted), "later runner did not start")
    yield* runs.cancel(id)
    yield* laterHandle.pipe(Effect.exit)
  }),
)

for (const original of [undefined, {}] as const)
  it.instance(`captured runner cleanup keeps its ${original ? "set" : "unset"} generation`, () => {
    const replacement = {}
    return InstanceState.withGeneration(
      original,
      Effect.gen(function* () {
        const runs = yield* SessionRunState.Service
        const id = SessionID.create()
        const generations: Array<object | undefined> = []
        const started = yield* Deferred.make<void>()
        writes.set(id, () =>
          InstanceState.currentGeneration.pipe(
            Effect.tap((generation) =>
              Effect.sync(() => {
                generations.push(generation)
              }),
            ),
            Effect.asVoid,
          ),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => writes.delete(id)))
        const handle = yield* runs.ensureRunningHandle(
          id,
          Effect.die("interrupted"),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        )
        yield* awaitWithTimeout(Deferred.await(started), "runner did not start")
        const abort = SessionCancellation.begin(id)
        yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
        yield* InstanceState.adoptGeneration(replacement)
        abort.finishGoalCancel()
        yield* Effect.all(abort.owners)
        yield* handle.pipe(Effect.exit)
        expect(generations).toEqual([original, original])
      }),
    )
  })
