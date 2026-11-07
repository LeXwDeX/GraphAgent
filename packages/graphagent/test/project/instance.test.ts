import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { GlobalLifecycle } from "../../src/server/global-lifecycle"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(noopBootstrap)),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
      expect(ctx.root).toBe(dir)
    }),
  )

  it.live("anchors the project root at the nearest .agents directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const nested = path.join(dir, "packages", "app")
      yield* Effect.promise(() => mkdir(path.join(nested, ".agents"), { recursive: true }))
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: nested })

      expect(ctx.directory).toBe(nested)
      expect(ctx.worktree).toBe(dir)
      expect(ctx.root).toBe(nested)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )

  it.live("provideIfLoaded does not boot an unloaded directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      let booted = 0
      let ran = 0
      yield* setBootstrap(
        Effect.sync(() => {
          booted++
        }),
      )

      const result = yield* provideIfLoaded({ directory: dir }, Effect.sync(() => ran++))

      expect(Option.isNone(result)).toBe(true)
      expect(ran).toBe(0)
      expect(booted).toBe(0)
    }),
  )

  it.live("provideIfLoaded runs under a loaded instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      yield* store.load({ directory: dir })

      const result = yield* provideIfLoaded(
        { directory: dir },
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          return ctx?.directory
        }),
      )

      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrUndefined(result)).toBe(dir)
    }),
  )

  it.live("provideIfLoaded waits for disposal and refuses work while disposing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      let booted = 0
      yield* setBootstrap(
        Effect.sync(() => {
          booted++
        }),
      )
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const running = yield* provideIfLoaded(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      const during = yield* provideIfLoaded({ directory: dir }, Effect.sync(() => "ran")).pipe(
        Effect.timeoutOption("100 millis"),
      )
      expect(during).toEqual(Option.some(Option.none()))

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* Fiber.join(disposing)

      const after = yield* provideIfLoaded({ directory: dir }, Effect.sync(() => "ran"))
      expect(Option.isNone(after)).toBe(true)
      expect(booted).toBe(1)
    }),
  )

  it.live("provideIfLoaded does not reload a disposed directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      let booted = 0
      yield* setBootstrap(
        Effect.sync(() => {
          booted++
        }),
      )
      const ctx = yield* store.load({ directory: dir })
      yield* store.dispose(ctx)

      const result = yield* provideIfLoaded({ directory: dir }, Effect.sync(() => "ran"))

      expect(Option.isNone(result)).toBe(true)
      expect(booted).toBe(1)
      yield* store.load({ directory: dir })
      expect(booted).toBe(2)
    }),
  )

  it.live("reload waits for an in-flight provideIfLoaded and starts a new entry", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const running = yield* provideIfLoaded(
        { directory: dir },
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const reloading = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      const pending = yield* Fiber.join(reloading).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(pending)).toBe(true)
      expect(disposed).toEqual([])

      const next = yield* Fiber.join(reloading).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(next)).toBe(true)
      if (Option.isNone(next)) throw new Error("reload did not return")
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit)).toBe(true)

      expect(next.value).not.toBe(ctx)
      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(next.value)
      expect(Option.getOrUndefined(yield* provideIfLoaded({ directory: dir }, Effect.succeed("new")))).toBe("new")

      // A stale context must not tear down the replacement entry.
      yield* store.dispose(ctx)
      expect(yield* store.load({ directory: dir })).toBe(next.value)
    }),
  )

  it.live("dispose does not wait for an in-flight provideIfLoaded admission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const running = yield* provideIfLoaded(
        { directory: dir },
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposeResult = yield* store.dispose(ctx).pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(disposeResult)).toBe(true)
      expect(disposed).toEqual([dir])
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(Option.isNone(yield* provideIfLoaded({ directory: dir }, Effect.succeed("late")))).toBe(true)
    }),
  )

  it.live("closing a directory fences InstanceState.get", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const state = yield* InstanceState.make(() => Effect.succeed({ created: true }))
      const ctx = { directory: dir, worktree: dir, project: { id: "p" } } as never
      const read = InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))

      expect((yield* read).created).toBe(true)
      const token = InstanceState.markClosing(dir, {})
      expect(Exit.isFailure(yield* read.pipe(Effect.exit))).toBe(true)
      InstanceState.clearClosing(dir, token)
      expect((yield* read).created).toBe(true)
    }),
  )

  it.live("late provideIfLoaded work fails closed after disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      const state = yield* InstanceState.make(() => Effect.succeed({ created: true }))
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()

      const running = yield* provideIfLoaded(
        { directory: dir },
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          yield* InstanceState.get(state)
          yield* Deferred.succeed(completed, undefined)
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      yield* store.dispose(ctx)
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(running)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* Deferred.isDone(completed)).toBe(false)
    }),
  )

  it.live("reload returns after a bounded wait for a slow in-flight effect", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const provideIfLoaded = store.provideIfLoaded!
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const running = yield* provideIfLoaded(
        { directory: dir },
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const next = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(next)).toBe(true)
      if (Option.isNone(next)) throw new Error("reload did not return within its bound")
      expect(next.value).not.toBe(ctx)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)

      yield* store.dispose(ctx)
      expect(yield* store.load({ directory: dir })).toBe(next.value)
    }),
  )

  it.live("waitForOpen follows a replaced closing token", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const first = InstanceState.markClosing(dir, {})
      const waiting = yield* InstanceState.waitForOpen(dir).pipe(Effect.forkScoped)
      const pending = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("50 millis"))
      expect(Option.isNone(pending)).toBe(true)

      const second = InstanceState.markClosing(dir, {})
      InstanceState.clearClosing(dir, second)
      yield* Fiber.await(waiting)
      expect(InstanceState.isClosing(dir)).toBe(false)
      yield* Deferred.await(first.done)
    }),
  )

  it.live("overlapping reloads resolve a waiting load", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      yield* store.load({ directory: dir })
      const [first, second, loaded] = yield* Effect.all(
        [
          store.reload({ directory: dir }),
          store.reload({ directory: dir }),
          store.load({ directory: dir }),
        ],
        { concurrency: "unbounded" },
      )
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(loaded).toBeDefined()
      expect(yield* store.load({ directory: dir })).toBeDefined()
    }),
  )

  it.live("reload and dispose overlap without stranding a load", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      yield* store.load({ directory: dir })
      const [, , loaded] = yield* Effect.all(
        [store.reload({ directory: dir }), store.disposeDirectory(dir), store.load({ directory: dir })],
        { concurrency: "unbounded" },
      )
      expect(loaded).toBeDefined()
    }),
  )

  it.live("provide is generation-bound and reload interrupts its child scope", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const childStarted = yield* Deferred.make<void>()
      const childStopped = yield* Deferred.make<void>()

      const running = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.forkScoped(
              Deferred.succeed(childStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(childStopped, undefined)),
              ),
            )
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Deferred.await(childStarted)

      const next = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(next)).toBe(true)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* Deferred.isDone(childStopped)).toBe(true)
      expect(yield* store.load({ directory: dir })).toBeDefined()
    }),
  )

  it.live("a replaced closing token does not block a new entry and fences the old generation", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const other = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const state = yield* InstanceState.make(() => Effect.succeed({ created: true }))
      yield* setBootstrap(Effect.void)
      const first = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fenced = yield* Deferred.make<boolean>()

      const running = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.uninterruptible(
              Deferred.await(release).pipe(
                Effect.andThen(
                  InstanceState.get(state).pipe(
                    Effect.exit,
                    Effect.flatMap((exit) => Deferred.succeed(fenced, Exit.isFailure(exit))),
                  ),
                ),
              ),
            )
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const second = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("10 seconds"))
      expect(Option.isSome(second)).toBe(true)
      if (Option.isNone(second)) throw new Error("reload did not return")

      // The old generation is still draining, but the new entry must serve.
      const whileDraining = yield* store.load({ directory: dir }).pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(whileDraining)).toBe(true)
      if (Option.isNone(whileDraining)) throw new Error("load waited for the replaced closing token")
      expect(whileDraining.value).toBe(second.value)

      const otherCtx = yield* store.load({ directory: other })
      expect(otherCtx.directory).toBe(other)

      // A second replacement can clear the token while the old child lives.
      const third = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(third)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      expect(yield* Deferred.await(fenced)).toBe(true)
      yield* Fiber.await(running).pipe(Effect.ignore)
      expect(first.directory).toBe(dir)
      expect(yield* store.load({ directory: dir })).toBeDefined()
    }),
  )

  it.live("a load waits for disposal to remove a closing entry", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const disposerStarted = yield* Deferred.make<void>()
      const releaseDisposer = yield* Deferred.make<void>()

      yield* registerDisposerScoped(async () => {
        await Effect.runPromise(Deferred.succeed(disposerStarted, undefined))
        await Effect.runPromise(Deferred.await(releaseDisposer))
      })

      const running = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(disposerStarted)

      const loadFiber = yield* store
        .load({ directory: dir })
        .pipe(Effect.timeoutOption("3 seconds"), Effect.forkScoped)
      const beforeRelease = yield* Fiber.join(loadFiber).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(beforeRelease)).toBe(true)

      yield* Deferred.succeed(releaseDisposer, undefined)
      const afterRelease = yield* Fiber.join(loadFiber)
      expect(Option.isSome(afterRelease)).toBe(true)
      if (Option.isNone(afterRelease)) throw new Error("load did not resume after disposal")
      expect(afterRelease.value.directory).toBe(dir)

      yield* Fiber.await(disposing).pipe(Effect.ignore)
      yield* Fiber.await(running).pipe(Effect.ignore)
    }),
  )

  it.live("a load recovers after an interrupted disposal removes the closing entry", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })
      const entered = yield* Deferred.make<void>()
      const releaseProvide = yield* Deferred.make<void>()
      const running = yield* store
        .provide(
          { directory: dir },
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(releaseProvide)
            }),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.sync(() => (InstanceState.isClosing(dir) ? true : undefined)),
        "dispose did not mark the directory closing",
      )
      const interrupting = yield* Fiber.interrupt(disposing).pipe(Effect.forkScoped)
      yield* Fiber.await(interrupting).pipe(Effect.ignore)
      yield* Deferred.succeed(releaseProvide, undefined)
      yield* Fiber.await(running).pipe(Effect.ignore)

      const loaded = yield* store.load({ directory: dir }).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(loaded)).toBe(true)
      if (Option.isNone(loaded)) throw new Error("load did not recover after an interrupted disposal")
      expect(loaded.value.directory).toBe(dir)
    }),
  )

  it.live("interrupted disposal invalidates old state before a new generation starts", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let created = 0
      let released = 0
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.sync(() => ({ created: ++created })),
          () => Effect.sync(() => void released++),
        ),
      )
      const ctx = yield* store.load({ directory: dir })
      const first = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(first.created).toBe(1)

      const entered = yield* Deferred.make<void>()
      const closing = yield* Deferred.make<void>()
      const releaseClose = yield* Deferred.make<void>()
      const running = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.uninterruptible(
                Effect.sync(() => Deferred.doneUnsafe(closing, Effect.void)).pipe(
                  Effect.andThen(Deferred.await(releaseClose)),
                ),
              ),
            )
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.sync(() => (InstanceState.isClosing(dir) ? true : undefined)),
        "dispose did not mark the directory closing",
      )
      // The entry scope is now closing and blocked in the running effect's
      // finalizer, before disposeContext can run any directory disposers.
      yield* Deferred.await(closing)
      const interrupting = yield* Fiber.interrupt(disposing).pipe(Effect.forkScoped)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(releaseClose, undefined)
      yield* Fiber.await(interrupting)
      yield* Fiber.await(running).pipe(Effect.ignore)

      expect(released).toBe(1)

      const next = yield* store.load({ directory: dir }).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(next)).toBe(true)
      if (Option.isNone(next)) throw new Error("load did not recover after an interrupted disposal")
      expect(next.value).not.toBe(ctx)
      const second = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(second.created).toBe(2)
      expect(released).toBe(1)
    }),
  )

  it.live("does not rebuild state while a slow disposer is running", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let created = 0
      let released = 0
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.sync(() => ({ created: ++created })),
          () => Effect.sync(() => void released++),
        ),
      )
      const ctx = yield* store.load({ directory: dir })
      const first = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(first.created).toBe(1)

      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registerDisposerScoped(async () => {
        await Effect.runPromise(Deferred.succeed(started, undefined))
        await Effect.runPromise(Deferred.await(release))
      })

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      const early = yield* Fiber.await(loading).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(early)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(disposing)
      const next = yield* Fiber.join(loading)
      expect(next).not.toBe(ctx)
      expect(released).toBe(1)
      const second = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(second.created).toBe(2)
    }),
  )

  it.live("fences an active uninterruptible effect and recovers after disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let created = 0
      let released = 0
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.sync(() => ({ created: ++created })),
          () => Effect.sync(() => void released++),
        ),
      )
      const ctx = yield* store.load({ directory: dir })
      const first = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(first.created).toBe(1)

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const oldRead = yield* Deferred.make<Exit.Exit<{ created: number }>>()
      const running = yield* store
        .provide(
          { directory: dir },
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              yield* Deferred.succeed(oldRead, yield* InstanceState.get(state).pipe(Effect.exit))
            }),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.sync(() => (InstanceState.isClosing(dir) ? true : undefined)),
        "dispose did not mark the directory closing",
      )
      const disposed = yield* Fiber.await(disposing).pipe(Effect.timeoutOption("3 seconds"))
      expect(Option.isSome(disposed)).toBe(true)
      if (Option.isNone(disposed)) throw new Error("dispose did not finish after the scope close timeout")

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.await(running).pipe(Effect.ignore)
      const exit = yield* Deferred.await(oldRead)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(released).toBe(1)

      const nextCtx = yield* store.load({ directory: dir })
      expect(nextCtx).not.toBe(ctx)
      const second = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(second.created).toBe(2)
    }),
  )

  it.live("a timed-out disposal keeps a tombstone and recovers after cleanup", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let created = 0
      const state = yield* InstanceState.make(() => Effect.sync(() => ({ created: ++created })))
      const ctx = yield* store.load({ directory: dir })
      const first = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(first.created).toBe(1)

      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registerDisposerScoped(async () => {
        Deferred.doneUnsafe(started, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })

      const timed = yield* store.dispose(ctx).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(timed)).toBe(true)

      // Either the load fails explicitly or its own wait times out; it must
      // never read the old state or create a replacement over the tombstone.
      const during = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.timeoutOption("100 millis"))
      if (Option.isSome(during)) expect(Exit.isFailure(during.value)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      const recovered = yield* pollWithTimeout(
        Effect.gen(function* () {
          const exit = yield* store.load({ directory: dir }).pipe(Effect.exit)
          return Exit.isSuccess(exit) ? exit.value : undefined
        }),
        "load did not recover after cleanup",
        "2 seconds",
      )
      expect(recovered).not.toBe(ctx)
      const second = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(second.created).toBe(2)
    }),
  )

  it.live("global disposal bounds a hung cleanup and keeps the tombstone", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registerDisposerScoped(async () => {
        Deferred.doneUnsafe(started, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })

      const shutdown = yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(
        Effect.forkScoped,
      )
      yield* Deferred.await(started)
      const result = yield* Fiber.await(shutdown).pipe(Effect.timeoutOption("11 seconds"))
      expect(Option.isSome(result)).toBe(true)

      // Either the load fails explicitly or its own wait times out; it must
      // never read the old state or create a replacement over the tombstone.
      const during = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.timeoutOption("100 millis"))
      if (Option.isSome(during)) expect(Exit.isFailure(during.value)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      const recovered = yield* pollWithTimeout(
        Effect.gen(function* () {
          const exit = yield* store.load({ directory: dir }).pipe(Effect.exit)
          return Exit.isSuccess(exit) ? exit.value : undefined
        }),
        "load did not recover after global cleanup",
        "2 seconds",
      )
      expect(recovered).not.toBe(ctx)
    }),
  )

  it.live("disposes an entry once when dispose calls overlap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      let calls = 0
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registerDisposerScoped(async () => {
        calls += 1
        Deferred.doneUnsafe(entered, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })

      const first = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.await(first)
      yield* Fiber.await(second)
      expect(calls).toBe(1)
    }),
  )

  it.live("dispose from inside the entry closes its scope after the caller exits", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      const closed = yield* Deferred.make<void>()

      yield* store.provide(
        { directory: dir },
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid))
          yield* store.dispose(ctx)
          // The caller must outlive the scope that dispose is tearing down.
          expect(yield* Deferred.isDone(closed)).toBe(false)
        }),
      )

      const closedInTime = yield* Deferred.await(closed).pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(closedInTime)).toBe(true)
    }),
  )

  it.live("reload waits for an in-progress disposal cleanup", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let created = 0
      let released = 0
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.sync(() => ({ created: ++created })),
          () => Effect.sync(() => void released++),
        ),
      )
      const ctx = yield* store.load({ directory: dir })
      const first = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(first.created).toBe(1)

      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registerDisposerScoped(async () => {
        Deferred.doneUnsafe(started, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const reloading = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      const early = yield* Fiber.await(reloading).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(early)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.await(disposing)
      const next = yield* Fiber.join(reloading)
      expect(next).not.toBe(ctx)
      expect(released).toBe(1)
      const second = yield* store.provide({ directory: dir }, InstanceState.get(state))
      expect(second.created).toBe(2)
    }),
  )

  it.live("a load waits for an in-progress reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* setBootstrap(Effect.void)
      const ctx = yield* store.load({ directory: dir })

      const reloadStarted = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloadStarted, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reloading = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(reloadStarted)
      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      const early = yield* Fiber.await(loading).pipe(Effect.timeoutOption("100 millis"))
      expect(Option.isNone(early)).toBe(true)

      yield* Deferred.succeed(releaseReload, undefined)
      const next = yield* Fiber.join(reloading)
      const loaded = yield* Fiber.join(loading)
      expect(loaded).toBe(next)
      expect(next).not.toBe(ctx)
    }),
  )

  it.live("provideIfLoaded does not wait for a booting instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )

      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const during = yield* store
        .provideIfLoaded!({ directory: dir }, Effect.succeed("ran"))
        .pipe(Effect.timeoutOption("500 millis"))

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(loading)
      expect(Option.isSome(during)).toBe(true)
      if (Option.isSome(during)) expect(Option.isNone(during.value)).toBe(true)
      const loaded = yield* store.provideIfLoaded!({ directory: dir }, Effect.succeed("ran"))
      expect(loaded).toEqual(Option.some("ran"))
    }),
  )
})
