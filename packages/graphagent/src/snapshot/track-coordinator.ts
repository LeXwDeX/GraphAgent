import { Deferred, Effect, Exit, type Scope } from "effect"

/**
 * Coalesces concurrent snapshot tracking for one directory.
 *
 * A track request that arrives while a batch is running joins the next batch
 * instead of the running one. The next batch starts only after the running one
 * finishes, so its tree contains every write made before each request in it.
 * Requests that queue together share a single run and its result.
 *
 * The queue processor is a scoped fiber owned by the snapshot state: callers
 * only enqueue and await, so interrupting a caller cannot cancel a batch other
 * callers are waiting on. When the state scope closes, queued requests are
 * completed with the worker's interruption cause so no waiter is stranded.
 */
export interface Coordinator<A, E = never> {
  readonly track: () => Effect.Effect<A, E>
}

export const make = <A, E>(run: () => Effect.Effect<A, E>): Effect.Effect<Coordinator<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    let queued: Array<Deferred.Deferred<A, E>> = []
    let active: Array<Deferred.Deferred<A, E>> = []
    let wake: Deferred.Deferred<void> | undefined

    const request = (): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const deferred = Deferred.makeUnsafe<A, E>()
        queued.push(deferred)
        const signal = wake
        if (signal) {
          wake = undefined
          Deferred.doneUnsafe(signal, Effect.void)
        }
        return Deferred.await(deferred)
      })

    const loop = Effect.gen(function* () {
      while (true) {
        if (queued.length === 0) {
          const signal = yield* Deferred.make<void>()
          wake = signal
          // A request may have queued between the check and installing the
          // signal; the queued batch is handled without waiting for a wake.
          if (queued.length === 0) yield* Deferred.await(signal)
          wake = undefined
        }
        const batch = queued
        queued = []
        active = batch
        const exit = yield* Effect.exit(run())
        active = []
        yield* Effect.forEach(batch, (deferred) => Deferred.done(deferred, exit), { discard: true })
      }
    })

    yield* Effect.forkScoped(
      loop.pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            const rest = [...active, ...queued]
            active = []
            queued = []
            if (Exit.isFailure(exit)) {
              const cause = exit.cause
              for (const deferred of rest) Deferred.doneUnsafe(deferred, Effect.failCause(cause))
            }
            return Effect.void
          }),
        ),
      ),
      { startImmediately: true },
    )

    return { track: request }
  })

export * as TrackCoordinator from "./track-coordinator"
