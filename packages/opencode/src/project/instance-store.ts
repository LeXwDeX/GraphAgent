import { Logging } from "@opencode-ai/core/observability/logging"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import { InstanceBootstrap as InstanceBootstrapGraph } from "./bootstrap"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(
    input: LoadInput,
    effect: Effect.Effect<A, E, R>,
    options?: { detach?: boolean },
  ) => Effect.Effect<A, E, R>
  readonly provideIfLoaded?: <A, E, R>(
    input: LoadInput,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly directory: string
  readonly generation: object
  readonly scope: Scope.Closeable
  readonly deferred: Deferred.Deferred<InstanceContext>
  // Short use gate: provideIfLoaded holds it until the effect has entered the
  // target instance. Longer cancellation work is tracked by active/idle.
  readonly use: Semaphore.Semaphore
  disposing: boolean
  cleanup?: Deferred.Deferred<Exit.Exit<unknown>>
  closing?: InstanceState.ClosingToken
  // Completes after disposal removes the entry or fails. Loads wait on this
  // instead of polling the closing token, which may be cleared before the
  // entry is gone.
  readonly disposeDone: Deferred.Deferred<void>
  active: number
  idle: Deferred.Deferred<void>
  // A lifecycle call made from inside this entry must not close its own scope
  // before the caller can finish; close is deferred until the last use exits.
  selfClose?: boolean
  scopeClosed?: boolean
}

const entryRef = Context.Reference<Entry | undefined>("~opencode/InstanceStoreEntry", {
  defaultValue: () => undefined,
})

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    // Cleanup outlives the caller that requested disposal, but not the
    // application layer. It is closed after the layer's disposeAll finalizer.
    const cleanupScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(cleanupScope, Exit.void).pipe(Effect.ignore))
    const cache = new Map<string, Entry>()
    // Serializes lifecycle transitions for one directory. Different directories
    // still dispose and reload concurrently.
    const lifecycleLocks = new Map<string, Semaphore.Semaphore>()
    const lifecycleLock = (directory: string) => {
      const existing = lifecycleLocks.get(directory)
      if (existing) return existing
      const lock = Semaphore.makeUnsafe(1)
      lifecycleLocks.set(directory, lock)
      return lock
    }
    const withLifecycle = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      lifecycleLock(directory).withPermits(1)(effect)
    // A caller may dispose a context after its entry was already removed. The
    // managed cleanup already ran in that case; do not run it a second time.
    const disposedContexts = new WeakSet<InstanceContext>()

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(InstanceState.withGeneration(entry.generation, boot({ ...input, directory })))
        if (Exit.isFailure(exit)) {
          yield* removeEntry(directory, entry)
          yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
        }
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Logging.backgroundDebug("lifecycle.instance.dispose", {
        source: "instance.disposeContext",
        phase: "started",
        directory: ctx.directory,
        projectID: ctx.project.id,
      })
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
      yield* Logging.backgroundDebug("lifecycle.instance.dispose", {
        source: "instance.disposeContext",
        phase: "completed",
        directory: ctx.directory,
        projectID: ctx.project.id,
      })
    })

    const releaseClosing = (entry: Entry) => {
      if (!entry.closing || entry.active > 0) return
      // During disposal the token fences late work until the entry is removed.
      // The dispose finalizer clears it after cache.delete.
      if (entry.disposing && cache.get(entry.directory) === entry) return
      InstanceState.clearClosing(entry.directory, entry.closing)
      entry.closing = undefined
    }

    const closeEntryScope = (entry: Entry) =>
      Effect.gen(function* () {
        // Scope.close waits for every child, including uninterruptible ones.
        // Under Effect 4 that wait cannot be interrupted, so a timeout around
        // the close itself never fires. Fork the close and bound only the wait:
        // cleanup returns, and the scope settles once its children finish.
        const closing = yield* Scope.close(entry.scope, Exit.void).pipe(
          Effect.forkIn(cleanupScope, { startImmediately: true }),
        )
        const result = yield* Fiber.await(closing).pipe(Effect.timeoutOption("1 second"))
        if (Option.isNone(result)) {
          yield* Effect.logWarning("instance entry scope close timed out", { directory: entry.directory })
          return
        }
        if (Exit.isFailure(result.value)) {
          yield* Effect.logWarning("instance entry scope close failed", {
            directory: entry.directory,
            cause: result.value.cause,
          })
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("instance entry scope close failed", { directory: entry.directory, cause }),
        ),
      )

    const beginUse = (entry: Entry) => {
      if (entry.active === 0) entry.idle = Deferred.makeUnsafe<void>()
      entry.active++
    }

    const endUse = (entry: Entry) => {
      entry.active--
      if (entry.active === 0) {
        Deferred.doneUnsafe(entry.idle, Effect.void)
        releaseClosing(entry)
      }
    }

    const waitIdle = (entry: Entry) => (entry.active === 0 ? Effect.void : Deferred.await(entry.idle))

    // A lifecycle call from inside the entry cannot close the scope synchronously:
    // that would interrupt the caller before it can observe the permission abort.
    // Close in the cleanup scope after the last admitted effect exits.
    const closeAfterUse = (entry: Entry) =>
      Effect.suspend(() => {
        if (!entry.selfClose || entry.scopeClosed || entry.active > 0) return Effect.void
        entry.scopeClosed = true
        return closeEntryScope(entry).pipe(Effect.forkIn(cleanupScope, { startImmediately: false }), Effect.ignore)
      })

    const onUseExit = (entry: Entry) =>
      Effect.gen(function* () {
        endUse(entry)
        yield* closeAfterUse(entry)
      })

    // Caller interruption only abandons the wait. Cleanup runs in the
    // application-layer cleanup scope so a shutdown timeout cannot lose it, and
    // the entry stays a tombstone until cleanup finishes. A hung disposer
    // therefore never blocks the caller, but it also cannot be reported as a
    // completed disposal.
    const finishCleanup = (directory: string, entry: Entry, ctx: InstanceContext, exit: Exit.Exit<unknown>) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) {
          if (cache.get(directory) === entry) cache.delete(directory)
          disposedContexts.add(ctx)
          Deferred.doneUnsafe(entry.disposeDone, Effect.void)
          if (entry.closing) InstanceState.clearClosing(directory, entry.closing)
          return
        }
        Deferred.doneUnsafe(
          entry.disposeDone,
          Effect.logError("instance cleanup failed", { directory, cause: exit.cause }).pipe(
            Effect.andThen(Effect.die(new Error(`instance cleanup failed: ${directory}`))),
          ),
        )
      })

    const failDisposeWaiters = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        Deferred.doneUnsafe(
          entry.disposeDone,
          Effect.die(new Error(`instance disposal interrupted while cleanup continues: ${directory}`)),
        )
      })

    const startCleanup = (
      directory: string,
      entry: Entry,
      ctx: InstanceContext,
      options?: { waitIdle?: boolean },
    ): Effect.Effect<Deferred.Deferred<Exit.Exit<unknown>>> =>
      Effect.gen(function* () {
        if (entry.cleanup) return entry.cleanup
        const cleanupDone = Deferred.makeUnsafe<Exit.Exit<unknown>>()
        entry.cleanup = cleanupDone
        const cleanup = InstanceState.withGeneration(
          entry.generation,
          InstanceState.withClosingCleanup(
            directory,
            entry.selfClose
              ? disposeContext(ctx)
              : Effect.gen(function* () {
                  if (options?.waitIdle) {
                    // Reload waits for admitted work to leave before disposers
                    // announce that the instance was replaced.
                    const settled = yield* waitIdle(entry).pipe(Effect.timeoutOption("1 second"))
                    if (Option.isNone(settled)) {
                      yield* Effect.logWarning("instance reload gave up waiting for an in-flight cancellation", {
                        directory,
                      })
                    }
                  }
                  yield* disposeContext(ctx)
                  // Directory disposers reject pending question/permission
                  // requests with typed errors. Closing the entry scope before
                  // that rejection reaches the waiter would interrupt it, so
                  // give the rejected work a bounded chance to stop first.
                  const rejected = yield* waitIdle(entry).pipe(Effect.timeoutOption("1 second"))
                  if (Option.isNone(rejected)) {
                    yield* Effect.logWarning("instance dispose interrupted pending work", { directory })
                  }
                  yield* closeEntryScope(entry)
                }),
          ),
        )
        const task = Effect.gen(function* () {
          yield* Deferred.await(entry.deferred).pipe(Effect.ignore)
          // The gate only covers the handoff into the target instance. A slow
          // uninterruptible admission must not hold instance disposal forever.
          const drained = yield* entry.use.withPermits(1)(Effect.void).pipe(Effect.timeoutOption("1 second"))
          if (Option.isNone(drained)) {
            yield* Effect.logWarning("instance dispose waited for an in-flight provideIfLoaded handoff", {
              directory,
            })
          }
          return yield* cleanup
        }).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            finishCleanup(directory, entry, ctx, exit).pipe(
              Effect.andThen(Effect.sync(() => Deferred.doneUnsafe(cleanupDone, Effect.succeed(exit)))),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(
                cleanupDone,
                Effect.succeed(Exit.die(new Error(`instance cleanup interrupted: ${directory}`))),
              )
            }),
          ),
        )
        const forked = yield* Effect.exit(task.pipe(Effect.forkIn(cleanupScope, { startImmediately: true })))
        if (Exit.isFailure(forked)) {
          const failed = Exit.die(new Error(`instance cleanup could not start: ${directory}`))
          yield* finishCleanup(directory, entry, ctx, failed)
          Deferred.doneUnsafe(cleanupDone, Effect.succeed(failed))
        }
        return cleanupDone
      })

    const disposeEntryLocked = (
      directory: string,
      entry: Entry,
      ctx: InstanceContext,
      options?: { waitIdle?: boolean },
    ) =>
      Effect.gen(function* () {
        if (cache.get(directory) !== entry) return false
        entry.disposing = true
        entry.selfClose ??= (yield* entryRef) === entry
        // The caller that disposed its own entry may keep using the directory
        // after cleanup (a remount). Other provides stay fenced.
        if (entry.selfClose) yield* InstanceState.adoptGeneration(undefined)
        entry.closing ??= InstanceState.markClosing(directory, entry.generation)
        const cleanup = yield* Effect.uninterruptible(startCleanup(directory, entry, ctx, options))
        const exit = yield* Deferred.await(cleanup).pipe(Effect.onInterrupt(() => failDisposeWaiters(directory, entry)))
        if (Exit.isFailure(exit)) {
          return yield* Effect.die(new Error(`instance cleanup failed: ${directory}`))
        }
        return true
      })

    const disposeEntry = (directory: string, entry: Entry, ctx: InstanceContext, options?: { waitIdle?: boolean }) =>
      withLifecycle(directory, disposeEntryLocked(directory, entry, ctx, options))

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      // A wait bound, not a cleanup cap: a tombstone whose cleanup is still
      // running fails the waiter instead of hanging it forever. The supervised
      // cleanup keeps running independently of this timeout.
      const waitForDispose = (entry: Entry): Effect.Effect<InstanceContext> =>
        Effect.gen(function* () {
          // The closing token may already be cleared while disposal is still
          // running. Wait for the entry itself to disappear, not the token.
          const done = yield* Deferred.await(entry.disposeDone).pipe(Effect.exit, Effect.timeoutOption("10 seconds"))
          if (Option.isNone(done)) {
            return yield* Effect.die(new Error(`instance cleanup wait timed out: ${directory}`))
          }
          if (cache.get(directory) !== entry) return yield* load(input)
          if (Exit.isFailure(done.value)) {
            // A caller timed out while cleanup continues. Wait for that
            // cleanup rather than rebuilding over the tombstone.
            if (!entry.cleanup) return yield* Effect.die(new Error(`instance cleanup is still pending: ${directory}`))
            const cleanup = yield* Deferred.await(entry.cleanup).pipe(Effect.exit, Effect.timeoutOption("10 seconds"))
            if (Option.isNone(cleanup)) {
              return yield* Effect.die(new Error(`instance cleanup wait timed out: ${directory}`))
            }
            if (cache.get(directory) !== entry) return yield* load(input)
            if (Exit.isFailure(cleanup.value)) {
              return yield* Effect.die(new Error(`instance cleanup is still pending: ${directory}`))
            }
          }
          return yield* load(input)
        })
      return Effect.gen(function* () {
        // A replacement entry may already be serving while the previous
        // generation's closing token is still draining. Do not wait for that
        // token before checking the cache, or every load would block on work
        // that belongs only to the old generation.
        const cached = cache.get(directory)
        if (cached) {
          if (cached.disposing) return yield* waitForDispose(cached)
          const ctx = yield* Deferred.await(cached.deferred)
          if (cache.get(directory) === cached && !cached.disposing) return ctx
          return yield* load(input)
        }
        yield* InstanceState.waitForOpen(directory)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry = yield* restore(
              withLifecycle(
                directory,
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    const existing = cache.get(directory)
                    if (existing) return existing

                    const entryScope = yield* Scope.make()
                    const entry: Entry = {
                      directory,
                      generation: {},
                      scope: entryScope,
                      deferred: Deferred.makeUnsafe<InstanceContext>(),
                      use: Semaphore.makeUnsafe(1),
                      disposing: false,
                      disposeDone: Deferred.makeUnsafe<void>(),
                      active: 0,
                      idle: Deferred.makeUnsafe<void>(),
                    }
                    cache.set(directory, entry)
                    yield* Effect.gen(function* () {
                      yield* Effect.logInfo("creating instance", { directory: directory })
                      yield* completeLoad(directory, input, entry)
                    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
                    return entry
                  }),
                ),
              ),
            )
            if (entry.disposing) {
              // Restore interruptibility around the wait so callers can time
              // out without abandoning the supervised cleanup.
              return yield* restore(waitForDispose(entry))
            }
            const ctx = yield* restore(Deferred.await(entry.deferred))
            if (cache.get(directory) === entry && !entry.disposing) return ctx
            return yield* load(input)
          }),
        ).pipe(Effect.withSpan("InstanceStore.load"))
      })
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        restore(
          withLifecycle(
            directory,
            Effect.gen(function* () {
              yield* Logging.backgroundDebug("lifecycle.instance.reload", { source: "instance.reload", directory })
              yield* Effect.logInfo("reloading instance", { directory: directory })
              const previous = cache.get(directory)
              if (previous) {
                const loaded = yield* Deferred.await(previous.deferred).pipe(Effect.exit)
                if (Exit.isFailure(loaded)) {
                  yield* removeEntry(directory, previous)
                } else {
                  previous.disposing = true
                  previous.selfClose ??= (yield* entryRef) === previous
                  previous.closing ??= InstanceState.markClosing(directory, previous.generation)
                  const cleanup = yield* Effect.uninterruptible(
                    startCleanup(directory, previous, loaded.value, { waitIdle: true }),
                  )
                  const cleanupExit = yield* Deferred.await(cleanup).pipe(
                    Effect.onInterrupt(() => failDisposeWaiters(directory, previous)),
                  )
                  if (Exit.isFailure(cleanupExit)) {
                    return yield* Effect.die(new Error(`instance cleanup failed: ${directory}`))
                  }
                }
              }

              yield* InstanceState.waitForOpen(directory)
              const entry = yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const entryScope = yield* Scope.make()
                  const entry: Entry = {
                    directory,
                    generation: {},
                    scope: entryScope,
                    deferred: Deferred.makeUnsafe<InstanceContext>(),
                    use: Semaphore.makeUnsafe(1),
                    disposing: false,
                    disposeDone: Deferred.makeUnsafe<void>(),
                    active: 0,
                    idle: Deferred.makeUnsafe<void>(),
                  }
                  cache.set(directory, entry)
                  yield* Effect.gen(function* () {
                    yield* completeLoad(directory, input, entry)
                  }).pipe(Effect.forkIn(scope, { startImmediately: true }))
                  return entry
                }),
              )
              const ctx = yield* restore(Deferred.await(entry.deferred))
              // The caller that performed the reload continues against the new
              // entry. Other provides keep their generation and stay fenced.
              yield* InstanceState.adoptGeneration(entry.generation)
              return ctx
            }),
          ),
        ),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      yield* withLifecycle(
        ctx.directory,
        Effect.gen(function* () {
          const entry = cache.get(ctx.directory)
          if (!entry) {
            if (disposedContexts.has(ctx)) return
            yield* disposeContext(ctx)
            disposedContexts.add(ctx)
            return
          }

          const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            yield* removeEntry(ctx.directory, entry)
            return
          }
          if (exit.value !== ctx) return
          yield* disposeEntryLocked(ctx.directory, entry, ctx).pipe(Effect.asVoid)
        }),
      )
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      yield* withLifecycle(
        directory,
        Effect.gen(function* () {
          const entry = cache.get(directory)
          if (!entry) return
          const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            yield* removeEntry(directory, entry)
            return
          }
          yield* disposeEntryLocked(directory, entry, exit.value).pipe(Effect.asVoid)
        }),
      )
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Logging.backgroundDebug("lifecycle.instance.disposeAll", {
        source: "instance.disposeAll",
        instanceCount: cache.size,
      })
      yield* Effect.logInfo("disposing all instances")
      // Keep directories independent: a cleanup hung in one directory must not
      // stop the others from being disposed.
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true, concurrency: "unbounded" },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(
      input: LoadInput,
      effect: Effect.Effect<A, E, R>,
      options?: { detach?: boolean },
    ): Effect.Effect<A, E, R> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.gen(function* () {
        const ctx = yield* load(input)
        const entry = cache.get(directory)
        if (!entry) return yield* provide(input, effect, options)
        const loaded = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        // Disposal may start while this caller waits for the load. Never fork
        // work into a closing generation; reload must pick the new entry.
        if (Exit.isFailure(loaded) || loaded.value !== ctx || entry.disposing || cache.get(directory) !== entry) {
          return yield* provide(input, effect, options)
        }
        beginUse(entry)
        if (options?.detach) {
          // Harness code (the tests' instance scope) must outlive a directory
          // reload instead of being interrupted with the replaced entry scope.
          return yield* InstanceState.withGeneration(entry.generation, effect).pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.provideService(entryRef, entry),
            Effect.onExit(() => onUseExit(entry)),
          )
        }
        const forked = InstanceState.withGeneration(entry.generation, effect).pipe(
          Scope.provide(entry.scope),
          Effect.provideService(InstanceRef, ctx),
          Effect.provideService(entryRef, entry),
          Effect.onExit(() => onUseExit(entry)),
          Effect.forkIn(entry.scope, { startImmediately: true }),
        )
        const fiber = yield* forked.pipe(
          // A fork into an already-closed scope can fail before the child's
          // own onExit is installed. Release the active count in that case.
          Effect.onExit((exit) => (Exit.isFailure(exit) ? onUseExit(entry) : Effect.void)),
        )
        return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.ignore)))
      })
    }

    const provideIfLoaded = <A, E, R>(
      input: LoadInput,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<Option.Option<A>, E, R> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.gen(function* () {
        const entry = cache.get(directory)
        if (!entry || entry.disposing) return Option.none<A>()
        // Hold the gate only through the handoff into the target instance.
        // The effect can outlive disposal (a slow uninterruptible admission),
        // so it is tracked by active/idle instead of this short gate.
        const fiber = yield* entry.use.withPermits(1)(
          Effect.gen(function* () {
            if (entry.disposing || cache.get(directory) !== entry) return Option.none<Fiber.Fiber<A, E>>()
            // "if loaded" means do not wait for an in-flight load. A caller
            // cancelling a session must not block on bootstrap.
            if (!(yield* Deferred.isDone(entry.deferred))) return Option.none<Fiber.Fiber<A, E>>()
            const loaded = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
            if (Exit.isFailure(loaded)) return Option.none<Fiber.Fiber<A, E>>()
            // Re-check after the load wait: disposal may have started while
            // this caller waited, and it must not run on a torn-down instance.
            if (entry.disposing || cache.get(directory) !== entry) return Option.none<Fiber.Fiber<A, E>>()
            beginUse(entry)
            const forked = InstanceState.withGeneration(entry.generation, effect).pipe(
              Scope.provide(entry.scope),
              Effect.provideService(InstanceRef, loaded.value),
              Effect.provideService(entryRef, entry),
              Effect.onExit(() => onUseExit(entry)),
              Effect.forkIn(entry.scope, { startImmediately: true }),
            )
            const fiber = yield* forked.pipe(
              Effect.onExit((exit) => (Exit.isFailure(exit) ? onUseExit(entry) : Effect.void)),
            )
            // Let the effect reach its first suspension point so a reload can
            // observe that it has entered before the gate is released.
            yield* Effect.yieldNow
            return Option.some(fiber)
          }),
        )
        if (Option.isNone(fiber)) return Option.none<A>()
        return yield* Fiber.join(fiber.value).pipe(
          Effect.map((value) => Option.some(value)),
          Effect.onInterrupt(() => Fiber.interrupt(fiber.value).pipe(Effect.ignore)),
        )
      })
    }

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
      provideIfLoaded,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export const node = LayerNode.make(layer, [Project.node, InstanceBootstrapGraph.node])

export * as InstanceStore from "./instance-store"
