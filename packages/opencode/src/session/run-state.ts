import { Logging } from "@opencode-ai/core/observability/logging"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Cause, Deferred, Effect, Exit, Latch, Layer, Option, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionAbortReason } from "./abort-reason"
import { SessionCancellation } from "./cancellation"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelBackground: (sessionID: SessionID, skipCoordinated?: boolean) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly ensureRunningHandle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Effect.Effect<SessionV1.WithParts>>
  readonly startIfIdle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Option.Option<Effect.Effect<SessionV1.WithParts>>>
  readonly startShellHandle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Effect.Effect<SessionV1.WithParts, Session.BusyError>>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        // Runner fibers get their own scope so the state finalizer can write
        // shutdown attribution BEFORE interrupting them. Forking them into the
        // InstanceState scope would let scope teardown interrupt the prompt
        // first, making the durable abort reason depend on finalizer order.
        const scope = yield* Scope.make()
        const directory = yield* InstanceState.directory
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        const owners = new Map<SessionID, () => void>()
        const starting = new Map<SessionID, Deferred.Deferred<void>>()
        const locks = KeyedMutex.makeUnsafe<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const entries = [...runners.entries()]
            const reasons: Array<readonly [SessionID, SessionAbortReason.Info]> = []
            for (const [sessionID] of entries) {
              const existing = SessionAbortReason.peek(sessionID)
              if (existing) {
                // A cancel can still be in flight when the instance is disposed.
                // Preserve its specific reason; relabelling it as shutdown would
                // hide why the interrupted turn actually stopped.
                continue
              }
              const abort = SessionAbortReason.make("shutdown", "session-scope")
              SessionAbortReason.set(sessionID, abort)
              reasons.push([sessionID, abort] as const)
            }
            yield* Effect.forEach(
              entries,
              ([sessionID, runner]) =>
                Logging.backgroundDebug("lifecycle.session.cancel", {
                  source: "instance.scope.finalizer",
                  directory,
                  sessionID,
                }).pipe(Effect.andThen(runner.cancel)),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(
              Effect.ensuring(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
                    for (const [sessionID, abort] of reasons) SessionAbortReason.clear(sessionID, abort)
                    for (const unregister of owners.values()) unregister()
                    owners.clear()
                    runners.clear()
                  }),
                ),
              ),
            )
          }),
        )
        return { runners, owners, starting, locks, scope }
      }),
    )

    // Disposal marks the directory closing before it invalidates per-service
    // state. A runner finalizer must still cancel its turn in that window; only
    // the status write is allowed to be a fail-closed no-op. Any other defect
    // keeps propagating.
    const setStatus = (sessionID: SessionID, info: Parameters<typeof status.set>[1]) =>
      status.set(sessionID, info).pipe(
        Effect.catchCause((cause) => {
          const onlyClosing =
            cause.reasons.length > 0 &&
            cause.reasons.every(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof InstanceState.Closing,
            )
          return onlyClosing ? Effect.void : Effect.failCause(cause)
        }),
      )

    const start = <A, E>(
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      fallback: A,
      run: (
        runner: Runner.Runner<SessionV1.WithParts>,
        work: Effect.Effect<SessionV1.WithParts>,
      ) => Effect.Effect<A, E>,
      work: Effect.Effect<SessionV1.WithParts>,
      admitted?: ReturnType<typeof SessionCancellation.request>,
    ): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const request = admitted ?? SessionCancellation.request(sessionID)
        return Effect.gen(function* () {
          // Callers that supply a request have already waited before taking their locks.
          if (!admitted) yield* request.wait
          if (!request.valid()) return fallback
          const data = yield* InstanceState.get(state)
          const retire = (
            runner: Runner.Runner<SessionV1.WithParts>,
            snapshot: Runner.State<SessionV1.WithParts, never>,
          ): Effect.Effect<void> =>
            SessionCancellation.publication.withLock(sessionID)(
              Effect.suspend(() => {
                if (data.runners.get(sessionID) !== runner || runner.state !== snapshot || runner.busy) return Effect.void
                if (SessionCancellation.goalCancelPending(sessionID)) {
                  data.owners.get(sessionID)?.()
                  data.owners.delete(sessionID)
                  return SessionCancellation.waitForGoalCancels(sessionID).pipe(
                    Effect.andThen(data.locks.withLock(sessionID)(retire(runner, snapshot))),
                    Effect.forkIn(data.scope),
                    Effect.asVoid,
                  )
                }
                data.runners.delete(sessionID)
                data.owners.get(sessionID)?.()
                data.owners.delete(sessionID)
                return setStatus(sessionID, { type: "idle" })
              }),
            )
          return yield* data.locks.withLock(sessionID)(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (!request.valid()) return fallback
                let next = data.runners.get(sessionID)
                if (!next || !data.owners.has(sessionID)) {
                  const context = yield* Effect.context()
                  const generation = yield* InstanceState.currentGeneration
                  const directory = yield* InstanceState.directory
                  if (!request.valid()) return fallback
                  if (!next) {
                    const created: Runner.Runner<SessionV1.WithParts> = Runner.make<SessionV1.WithParts>(data.scope, {
                      onIdle: Effect.suspend(() =>
                        data.locks.withLock(sessionID)(retire(created, created.state)),
                      ),
                      onBusy: setStatus(sessionID, { type: "busy" }),
                      onInterrupt,
                    })
                    data.runners.set(sessionID, created)
                    next = created
                  }
                  const runner = next
                  const unregister = request.register(() => {
                    const captured = runner.cancelSnapshot()
                    const pending = data.starting.get(sessionID)
                    const cancel = pending
                      ? Deferred.await(pending).pipe(
                          Effect.andThen(Effect.suspend(() => runner.cancelSnapshot())),
                          Effect.andThen(captured),
                        )
                      : captured
                    return InstanceState.withGeneration(generation, cancel).pipe(Effect.provide(context))
                  }, directory)
                  if (unregister) data.owners.set(sessionID, unregister)
                }
                const pending = Deferred.makeUnsafe<void>()
                data.starting.set(sessionID, pending)
                const guarded = Effect.suspend(() => (request.current() ? work : Effect.interrupt))
                const result = yield* restore(run(next, guarded)).pipe(Effect.exit)
                data.starting.delete(sessionID)
                Deferred.doneUnsafe(pending, Effect.void)
                if (Exit.isFailure(result) && data.runners.get(sessionID) === next && !next.busy) {
                  yield* retire(next, next.state)
                }
                return yield* result
              }),
            ),
          )
        }).pipe(Effect.ensuring(Effect.sync(() => { if (!admitted) request.release() })))
      })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      // A session with no runner in this instance has no turn to stop. Publishing
      // idle here would fake a turn boundary in a directory that only owns the
      // durable row after a move; DagLoop and GoalLoop treat every idle as real.
      if (!existing) return
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* start(
        sessionID,
        onInterrupt,
        onInterrupt,
        (runner, guarded) => runner.ensureRunningHandle(guarded),
        work,
      ).pipe(Effect.flatten)
    })

    const ensureRunningHandle = Effect.fn("SessionRunState.ensureRunningHandle")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      request?: ReturnType<typeof SessionCancellation.request>,
    ) {
      return yield* start(
        sessionID,
        onInterrupt,
        onInterrupt,
        (runner, guarded) => runner.ensureRunningHandle(guarded),
        work,
        request,
      )
    })

    const startIfIdle = Effect.fn("SessionRunState.startIfIdle")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      request?: ReturnType<typeof SessionCancellation.request>,
    ) {
      return yield* start(
        sessionID,
        onInterrupt,
        request ? Option.none() : Option.some(onInterrupt),
        (runner, guarded) => runner.startIfIdle(guarded),
        work,
        request,
      )
    })

    const startShellHandle: Interface["startShellHandle"] = Effect.fn("SessionRunState.startShellHandle")(
      function* (sessionID, onInterrupt, work, ready, request) {
        const result = yield* start(
          sessionID,
          onInterrupt,
          onInterrupt,
          (runner, guarded) => runner.startShellHandle(guarded, ready),
          work,
          request,
        )
        return result.pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
      },
    )

    const startShell: Interface["startShell"] = Effect.fn("SessionRunState.startShell")((...args) =>
      startShellHandle(...args).pipe(Effect.flatten),
    )

    return Service.of({
      assertNotBusy,
      cancel,
      cancelBackground: (sessionID, skipCoordinated) => cancelBackgroundJobs(background, sessionID, skipCoordinated),
      ensureRunning,
      ensureRunningHandle,
      startIfIdle,
      startShell,
      startShellHandle,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
  skipCoordinated = false,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        Effect.gen(function* () {
          const captured = skipCoordinated ? yield* background.capture(job) : undefined
          // The owner snapshot has the old identities; this local list may include later jobs.
          if (captured && BackgroundJob.isCoordinated(captured.identity)) return
          yield* captured ? captured.cancel : background.cancel(job.id)
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make(layer, [BackgroundJob.node, SessionStatus.node])

export * as SessionRunState from "./run-state"
