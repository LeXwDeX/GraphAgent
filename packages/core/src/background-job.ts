export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"

/**
 * `settling` means the work has produced its result but the owner is still
 * delivering its side effects (a notice prompt, a result card, a wake). It is
 * deliberately not terminal: waiters still observe the final status, but
 * dedupe paths must treat a settling job as already finished so a new job can
 * start from the delivery turn (#1066).
 */
export type Status = "running" | "settling" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

export type Transition = {
  readonly id: string
  readonly type: string
  readonly from: Status | null
  readonly to: Status
  readonly sessionID?: string
  readonly parentSessionID?: string
  readonly title?: string
  readonly metadata?: Record<string, unknown>
  readonly started_at?: number
  readonly output?: string
  readonly error?: string
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
  transition?: Transition
}

export type MakeOptions = {
  /**
   * Observation sink for state transitions. The sink is called after the
   * compare-and-swap commits; it is best-effort and never changes job state.
   * Callers wire it to `Lifecycle.transition` so background jobs share the
   * cross-domain vocabulary without making the core registry depend on the
   * event bridge (#1069 P4).
   */
  readonly onTransition?: (transition: Transition) => Effect.Effect<void>
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type Captured = {
  readonly identity: object
  readonly cancel: Effect.Effect<Info | undefined>
  readonly done: Effect.Effect<Info>
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  /**
   * Moves a running job to `settling` before it delivers its side effects.
   * Idempotent for a job that is already settling; a terminal job is returned
   * unchanged. The job's `done` deferred resolves only at its real terminal
   * status.
   */
  readonly beginSettling: (id: string) => Effect.Effect<Info | undefined>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  readonly capture: (info: Info) => Effect.Effect<Captured | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/BackgroundJob") {}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const makeWith = (options: MakeOptions = {}) =>
  Effect.gen(function* () {
    const state: State = {
      jobs: yield* SynchronizedRef.make(new Map()),
      scope: yield* Scope.Scope,
    }
    const notify = (transition: Transition) =>
      options.onTransition ? options.onTransition(transition).pipe(Effect.catchCause(() => Effect.void)) : Effect.void
    const sessionIDOf = (job: Active): string | undefined =>
      typeof job.info.metadata?.sessionId === "string" ? job.info.metadata.sessionId : undefined
    const parentSessionIDOf = (job: Active): string | undefined =>
      typeof job.info.metadata?.parentSessionId === "string" ? job.info.metadata.parentSessionId : undefined
    /** The sink sees one complete job snapshot per transition, so durable
     * observers never have to merge partial deltas (#1069 P5). */
    const transitionOf = (job: Active, from: Status | null, to: Status, info: Info = job.info): Transition => ({
      id: job.info.id,
      type: job.info.type,
      from,
      to,
      sessionID: sessionIDOf(job),
      parentSessionID: parentSessionIDOf(job),
      title: info.title,
      metadata: info.metadata,
      started_at: info.started_at,
      output: info.output,
      error: info.error,
    })
    const identities = new WeakMap<Info, { id: string; token: object; done: Deferred.Deferred<Info> }>()
    const snapshot = (job: Active): Info => {
      const info = { ...job.info, ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}) }
      identities.set(info, { id: job.info.id, token: job.token, done: job.done })
      return info
    }

    const settle = Effect.fn("BackgroundJob.settle")(function* (
      id: string,
      token: object,
      sequence: number,
      exit: Exit.Exit<string, unknown>,
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.token !== token) return [{}, jobs]
        if (job.info.status !== "running" && job.info.status !== "settling") return [{ info: snapshot(job) }, jobs]
        const pending = job.pending - 1
        const output =
          Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
            ? { sequence, text: exit.value }
            : job.output
        if (Exit.isSuccess(exit) && pending > 0) {
          return [{}, new Map(jobs).set(id, { ...job, pending, output })]
        }
        const status: Exclude<Status, "running" | "settling"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
        const next = {
          ...job,
          onPromote: undefined,
          pending: 0,
          output,
          info: {
            ...job.info,
            status,
            completed_at,
            ...(output ? { output: output.text } : {}),
            ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
          },
        }
        return [
          {
            info: snapshot(next),
            done: job.done,
            scope: job.scope,
            transition: transitionOf(job, job.info.status, status, next.info),
          },
          new Map(jobs).set(id, next),
        ]
      })
      if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      if (result.transition) yield* notify(result.transition)
      if (result.scope) {
        yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
      }
      return result.info
    })

    const fork = Effect.fn("BackgroundJob.fork")(function* (
      scope: Scope.Scope,
      id: string,
      token: object,
      sequence: number,
      run: Effect.Effect<string, unknown>,
    ) {
      return yield* run.pipe(
        Effect.matchCauseEffect({
          onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
          onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
        }),
        Effect.asVoid,
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
      return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
        .map(snapshot)
        .toSorted((a, b) => a.started_at - b.started_at)
    })

    const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
      const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
      if (!job) return
      return snapshot(job)
    })

    const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = input.id ?? Identifier.ascending("job")
          const started_at = yield* Clock.currentTimeMillis
          const done = yield* Deferred.make<Info>()
          const promoted = yield* Deferred.make<Info>()
          const tail = yield* Deferred.make<void>()
          const result = yield* SynchronizedRef.modifyEffect(
            state.jobs,
            Effect.fnUntraced(function* (jobs) {
              const existing = jobs.get(id)
              const terminal =
                existing?.info.status === "completed" ||
                existing?.info.status === "error" ||
                existing?.info.status === "cancelled"
              if (existing && !terminal) {
                return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
              }
              const scope = yield* Scope.fork(state.scope, "parallel")
              const token = {}
              const job = {
                info: {
                  id,
                  type: input.type,
                  title: input.title,
                  status: "running" as const,
                  started_at,
                  metadata: input.metadata,
                },
                done,
                scope,
                token,
                pending: 1,
                next: 1,
                tail,
                promoted,
                onPromote: input.onPromote,
              }
              return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
                StartResult,
                Map<string, Active>,
              ]
            }),
          )
          if ("scope" in result) {
            yield* notify({
              id,
              type: input.type,
              from: null,
              to: "running",
              sessionID: typeof input.metadata?.sessionId === "string" ? input.metadata.sessionId : undefined,
              parentSessionID:
                typeof input.metadata?.parentSessionId === "string" ? input.metadata.parentSessionId : undefined,
              title: input.title,
              metadata: input.metadata,
              started_at: result.info.started_at,
            })
            yield* fork(
              result.scope,
              id,
              result.token,
              0,
              restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
            )
          }
          return result.info
        }),
      )
    })

    const beginSettling: Interface["beginSettling"] = Effect.fn("BackgroundJob.beginSettling")(function* (id) {
      const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const next = { ...job, info: { ...job.info, status: "settling" as const } }
        return [
          {
            info: snapshot(next),
            transition: transitionOf(job, "running", "settling"),
          },
          new Map(jobs).set(id, next),
        ]
      })
      if (result.transition) yield* notify(result.transition)
      return result.info
    })

    const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const tail = yield* Deferred.make<void>()
          const result = yield* SynchronizedRef.modify(
            state.jobs,
            (jobs): readonly [ExtendResult, Map<string, Active>] => {
              const job = jobs.get(input.id)
              if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
              return [
                { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
                new Map(jobs).set(input.id, {
                  ...job,
                  pending: job.pending + 1,
                  next: job.next + 1,
                  tail,
                }),
              ]
            },
          )
          if (!result.extended) return false
          yield* fork(
            result.scope,
            input.id,
            result.token,
            result.sequence,
            Deferred.await(result.previous).pipe(
              Effect.andThen(restore(input.run)),
              Effect.ensuring(Deferred.succeed(result.tail, undefined)),
            ),
          )
          return true
        }),
      )
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
      const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
      if (!job) return { timedOut: false }
      if (job.info.status !== "running" && job.info.status !== "settling")
        return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    })

    const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
      const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
      if (!job || job.info.status !== "running") return yield* Effect.never
      if (job.info.metadata?.background === true) return snapshot(job)
      return yield* Deferred.await(job.promoted)
    })

    const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
      const result = yield* SynchronizedRef.modifyEffect(
        state.jobs,
        Effect.fnUntraced(function* (jobs) {
          const job = jobs.get(id)
          if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
          if (job.info.metadata?.background === true)
            return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
          const next = {
            ...job,
            onPromote: undefined,
            info: {
              ...job.info,
              metadata: { ...job.info.metadata, background: true },
            },
          }
          return [
            { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
            new Map(jobs).set(id, next),
          ] as readonly [PromoteResult, Map<string, Active>]
        }),
      )
      if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
      if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
      return result.info
    })

    const cancelIf = Effect.fn("BackgroundJob.cancel")(function* (id: string, token?: object) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (token && job.token !== token) return [{}, jobs]
        if (job.info.status !== "running" && job.info.status !== "settling") return [{ info: snapshot(job) }, jobs]
        const next = {
          ...job,
          onPromote: undefined,
          pending: 0,
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
          },
        }
        return [
          {
            info: snapshot(next),
            done: job.done,
            scope: job.scope,
            transition: transitionOf(job, job.info.status, "cancelled", next.info),
          },
          new Map(jobs).set(id, next),
        ]
      })
      if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      if (result.transition) yield* notify(result.transition)
      if (result.scope) yield* Scope.close(result.scope, Exit.void)
      return result.info
    })

    const cancel: Interface["cancel"] = (id) => cancelIf(id)
    const capture: Interface["capture"] = (info) =>
      Effect.sync(() => {
        const identity = identities.get(info)
        if (!identity) return undefined
        return {
          identity: identity.token,
          cancel: cancelIf(identity.id, identity.token),
          done: Deferred.await(identity.done),
        }
      })

    return Service.of({ list, get, start, beginSettling, extend, wait, waitForPromotion, promote, cancel, capture })
  })

export const make = makeWith()

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer
