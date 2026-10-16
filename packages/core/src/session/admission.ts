export * as SessionAdmission from "./admission"

import { Deferred, Effect } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionConversationHooks } from "./conversation-hooks"

/** Application-owned admissions. Cancellation fences only owners already present;
 * later requests wait for cancellation to finish before acquiring a new owner. */
export const make = () => {
  const owners = new Map<string, Set<Deferred.Deferred<void>>>()
  const cancelling = new Map<string, Deferred.Deferred<void>>()
  const commits = KeyedMutex.makeUnsafe<string>()
  const cancelled = () => new SessionConversationHooks.Blocked({ reason: "Prompt cancelled before admission" })
  const run = <A, E, R>(
    id: string,
    effect: (
      commit: <B, E2, R2>(
        effect: Effect.Effect<B, E2, R2>,
      ) => Effect.Effect<B, E2 | SessionConversationHooks.Blocked, R2>,
    ) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SessionConversationHooks.Blocked, R> =>
    Effect.suspend(() => {
      const barrier = cancelling.get(id)
      if (barrier) return Deferred.await(barrier).pipe(Effect.flatMap(() => run(id, effect)))
      const owner = Deferred.makeUnsafe<void>()
      const current = owners.get(id) ?? new Set<Deferred.Deferred<void>>()
      current.add(owner)
      owners.set(id, current)
      const commit = <B, E2, R2>(body: Effect.Effect<B, E2, R2>) =>
        commits.withLock(id)(
          Effect.uninterruptible(
            Effect.suspend<B, E2 | SessionConversationHooks.Blocked, R2>(() =>
              Deferred.isDoneUnsafe(owner) ? Effect.fail(cancelled()) : body,
            ),
          ),
        )
      return Effect.raceFirst(
        Effect.suspend(() => effect(commit)),
        Deferred.await(owner).pipe(Effect.flatMap(() => Effect.fail(cancelled()))),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            current.delete(owner)
            if (current.size === 0) owners.delete(id)
          }),
        ),
      )
    })
  const cancel = <E, R>(id: string, effect: Effect.Effect<void, E, R>) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const existing = cancelling.get(id)
        if (existing) return Deferred.await(existing)
        const barrier = Deferred.makeUnsafe<void>()
        cancelling.set(id, barrier)
        const snapshot = [...(owners.get(id) ?? [])]
        return Effect.gen(function* () {
          for (const owner of snapshot) yield* Deferred.succeed(owner, undefined)
          yield* commits.withLock(id)(effect)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              cancelling.delete(id)
              yield* Deferred.succeed(barrier, undefined)
            }),
          ),
        )
      }),
    )
  return { run, cancel }
}
