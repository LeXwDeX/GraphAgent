import { Cause, Effect, Exit, Scope } from "effect"

/** Directory-owned jobs survive turn cancellation, but session deletion and disposal interrupt them. */
export const makeReasoningQueue = Effect.gen(function* () {
  const owner = yield* Scope.Scope
  type Entry = {
    scope: Scope.Closeable
    active: number
    keys: Set<string>
    ready: Array<{ key: string; commit: Effect.Effect<unknown> }>
  }
  const sessions = new Map<string, Entry>()
  const failOpen = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("reasoning distillation failed; retaining original reasoning", Cause.squash(cause)),
      ),
    )
  return {
    enqueue: (sessionID: string, key: string, organize: Effect.Effect<Effect.Effect<unknown> | undefined>) =>
      Effect.gen(function* () {
        let entry = sessions.get(sessionID)
        if (!entry) {
          entry = { scope: yield* Scope.fork(owner), active: 0, keys: new Set(), ready: [] }
          sessions.set(sessionID, entry)
        }
        if (entry.active >= 2 || entry.keys.has(key)) return
        const current = entry
        current.keys.add(key)
        current.active++
        let queued = false
        yield* failOpen(
          organize.pipe(
            Effect.tap((commit) =>
              Effect.sync(() => {
                if (commit && sessions.get(sessionID) === current) {
                  current.ready.push({ key, commit })
                  queued = true
                }
              }),
            ),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current.active--
              if (!queued) current.keys.delete(key)
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(current.scope),
        )
      }).pipe(Effect.uninterruptible),
    drain: (sessionID: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = sessions.get(sessionID)
          if (!entry) return
          // Snapshot completed jobs only. Never join unfinished organizers on the request path.
          const ready = entry.ready.splice(0)
          let completed = 0
          yield* Effect.gen(function* () {
            for (const job of ready) {
              yield* restore(failOpen(job.commit))
              entry.keys.delete(job.key)
              completed++
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                // A cancelled turn keeps its candidates for the next boundary;
                // deleting the session must not resurrect its queue.
                if (sessions.get(sessionID) === entry) entry.ready.unshift(...ready.slice(completed))
              }),
            ),
          )
        }),
      ),
    cancel: (sessionID: string) =>
      Effect.gen(function* () {
        const entry = sessions.get(sessionID)
        sessions.delete(sessionID)
        if (entry) yield* Scope.close(entry.scope, Exit.void)
      }),
  }
})
