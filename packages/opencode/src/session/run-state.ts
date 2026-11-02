import { Logging } from "@opencode-ai/core/observability/logging"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionAbortReason } from "./abort-reason"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly ensureRunningHandle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<Effect.Effect<SessionV1.WithParts>>
  readonly startIfIdle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<Option.Option<Effect.Effect<SessionV1.WithParts>>>
  readonly startShellHandle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
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
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const entries = [...runners.entries()]
            const reasons: Array<readonly [SessionID, SessionAbortReason.Info]> = []
            for (const [sessionID] of entries) {
              const existing = SessionAbortReason.take(sessionID)
              if (existing) {
                // A cancel can still be in flight when the instance is disposed.
                // Preserve its specific reason; relabelling it as shutdown would
                // hide why the interrupted turn actually stopped.
                SessionAbortReason.set(sessionID, existing)
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
                  }),
                ),
              ),
            )
            runners.clear()
          }),
        )
        return { runners, scope }
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

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* setStatus(sessionID, { type: "idle" })
        }),
        onBusy: setStatus(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
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
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const ensureRunningHandle = Effect.fn("SessionRunState.ensureRunningHandle")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunningHandle(work)
    })

    const startIfIdle = Effect.fn("SessionRunState.startIfIdle")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startIfIdle(work)
    })

    const startShellHandle: Interface["startShellHandle"] = Effect.fn("SessionRunState.startShellHandle")(
      function* (sessionID, onInterrupt, work, ready) {
        const result = yield* (yield* runner(sessionID, onInterrupt)).startShellHandle(work, ready)
        return result.pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
      },
    )

    const startShell: Interface["startShell"] = Effect.fn("SessionRunState.startShell")((...args) =>
      startShellHandle(...args).pipe(Effect.flatten),
    )

    return Service.of({
      assertNotBusy,
      cancel,
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
        background.cancel(job.id).pipe(
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
