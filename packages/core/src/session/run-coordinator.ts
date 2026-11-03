export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up; `force` also runs without queued user input. */
  readonly wake: (key: Key, force?: boolean) => Effect.Effect<void>
  /** Registers a follow-up and returns an effect that observes that drain's result. */
  readonly wakeTracked: (key: Key, force?: boolean) => Effect.Effect<Effect.Effect<void, E>>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  pendingForce: boolean
  pendingDone?: Deferred.Deferred<void, E>
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of active.values()) {
          entry.stopping = true
          entry.pendingWake = false
          entry.pendingForce = false
          if (entry.pendingDone) Deferred.doneUnsafe(entry.pendingDone, Effect.interrupt)
          entry.pendingDone = undefined
        }
      }),
    )

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      pendingForce: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false, done?: Deferred.Deferred<void, E>) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit, done))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>, done?: Deferred.Deferred<void, E>) => {
      if (done) Deferred.doneUnsafe(done, exit)
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        const force = entry.pendingForce
        const pendingDone = entry.pendingDone
        entry.pendingWake = false
        entry.pendingForce = false
        entry.pendingDone = undefined
        start(key, entry, force, true, pendingDone)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, entry.pendingForce, true, entry.pendingDone)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const schedule = (key: Key, force: boolean, tracked: boolean) => {
      const entry = active.get(key)
      if (entry !== undefined) {
        entry.pendingWake = true
        entry.pendingForce ||= force
        if (!tracked) return Effect.void
        entry.pendingDone ??= Deferred.makeUnsafe<void, E>()
        return Deferred.await(entry.pendingDone)
      }

      const next = makeEntry()
      const done = tracked ? Deferred.makeUnsafe<void, E>() : undefined
      active.set(key, next)
      start(key, next, force, false, done)
      return done ? Deferred.await(done) : Effect.void
    }

    const wake = (key: Key, force = false) => Effect.sync(() => schedule(key, force, false)).pipe(Effect.asVoid)
    const wakeTracked = (key: Key, force = false) => Effect.sync(() => schedule(key, force, true))

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        entry.pendingForce = false
        if (entry.pendingDone) Deferred.doneUnsafe(entry.pendingDone, Effect.interrupt)
        entry.pendingDone = undefined
        return Fiber.interrupt(entry.owner)
      })

    return { run, wake, wakeTracked, interrupt }
  })
