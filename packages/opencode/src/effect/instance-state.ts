import { Context, Deferred, Effect, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export class Closing extends Error {
  constructor(readonly directory: string) {
    super(`instance is closing: ${directory}`)
  }
}

export interface ClosingToken {
  readonly directory: string
  readonly generation: object
  readonly done: Deferred.Deferred<void>
}

const generationRef = Context.Reference<object | undefined>("~opencode/InstanceStateGeneration", {
  defaultValue: () => undefined,
})

// One provide block owns one mutable cell. A reload retargets the cell of the
// caller that performed it (the request or test that continues afterwards),
// while every other provide keeps the generation it was admitted with.
export interface GenerationCell {
  current: object | undefined
}

const generationCellRef = Context.Reference<GenerationCell | undefined>("~opencode/InstanceStateGenerationCell", {
  defaultValue: () => undefined,
})

/** Run effects belonging to one instance generation, so a replacement
 * generation can initialize while the old one is still draining. */
export const withGeneration = <A, E, R>(generation: object, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(Effect.provideService(effect, generationRef, generation), generationCellRef, {
    current: generation,
  })

/** Retarget the calling provide block after a completed reload, or clear it
 * after the caller disposed the directory itself. */
export const adoptGeneration = (generation: object | undefined) =>
  Effect.gen(function* () {
    const cell = yield* generationCellRef
    if (cell) cell.current = generation
  })

const currentGeneration = Effect.gen(function* () {
  const cell = yield* generationCellRef
  return cell ? cell.current : yield* generationRef
})

// Per-directory lifecycle fence. A directory that is being disposed must not
// lazily re-create status, runners, or other instance state from a late cancel.
const closingDirectories = new Map<string, ClosingToken>()
const closingCleanup = new Map<string, number>()
// A replaced token can be cleared while its old generation still has work.
// Remember closed generations so that work can never observe a newer entry.
const closedGenerations = new WeakSet<object>()

export const withClosingCleanup = <A, E, R>(
  directory: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    closingCleanup.set(directory, (closingCleanup.get(directory) ?? 0) + 1)
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const count = (closingCleanup.get(directory) ?? 1) - 1
          if (count <= 0) closingCleanup.delete(directory)
          else closingCleanup.set(directory, count)
        }),
      ),
    )
  })

export const markClosing = (directory: string, generation: object): ClosingToken => {
  const existing = closingDirectories.get(directory)
  if (existing?.generation === generation) return existing
  closedGenerations.add(generation)
  // Replacements complete the old waiters; waitForOpen re-reads the current
  // token so overlapping reload/dispose cycles cannot strand a load.
  if (existing) Deferred.doneUnsafe(existing.done, Effect.void)
  const token: ClosingToken = { directory, generation, done: Deferred.makeUnsafe<void>() }
  closingDirectories.set(directory, token)
  return token
}

export const clearClosing = (directory: string, token: ClosingToken) => {
  if (closingDirectories.get(directory) !== token) return
  closingDirectories.delete(directory)
  Deferred.doneUnsafe(token.done, Effect.void)
}

export const isClosing = (directory: string) => closingDirectories.has(directory)

const isFenced = (directory: string, generation: object | undefined) => {
  if (generation !== undefined && closedGenerations.has(generation)) return true
  const token = closingDirectories.get(directory)
  return token !== undefined && (generation === undefined || generation === token.generation)
}

export const waitForOpen = (directory: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const token = closingDirectories.get(directory)
    if (!token) return Effect.void
    return Deferred.await(token.done).pipe(Effect.andThen(waitForOpen(directory)))
  })

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({
      // Deliberately unbounded: eviction is coordinated per-directory by
      // InstanceStore.disposeDirectory (via the disposer registered below),
      // which tears down every service's state for that directory together.
      // A capacity/TTL here would evict one service's entry independently —
      // closing its scope (releasing resources still held by live fibers)
      // while sibling services keep their old state for the same directory.
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          const ctx = yield* context
          const generation = yield* currentGeneration
          if (isFenced(ctx.directory, generation)) {
            return yield* Effect.die(new Closing(ctx.directory))
          }
          return yield* init(ctx)
        }),
    })

    const off = registerDisposer((directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const stateDirectory = yield* directory
    const generation = yield* currentGeneration
    if (isFenced(stateDirectory, generation)) {
      // Instance teardown itself must still finish its status/reason writes,
      // but it may only observe state that already exists. A late cancel has
      // no such cleanup flag and remains fenced.
      if (!closingCleanup.has(stateDirectory)) return yield* Effect.die(new Closing(stateDirectory))
      if (!(yield* ScopedCache.has(self.cache, stateDirectory))) {
        return yield* Effect.die(new Closing(stateDirectory))
      }
    }
    return yield* ScopedCache.get(self.cache, stateDirectory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
