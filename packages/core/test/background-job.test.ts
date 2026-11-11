import { describe, expect } from "bun:test"
import { BackgroundJob } from "@graphagent/core/background-job"
import { Deferred, Effect, Exit, Scope } from "effect"
import { it } from "./lib/effect"

describe("BackgroundJob", () => {
  it.effect("captures a job identity even when its replacement has the same timestamp", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const old = yield* jobs.start({ id: "reused", type: "test", run: Effect.never })
      const captured = yield* jobs.capture(old)
      if (!captured) throw new Error("missing job capture")
      yield* jobs.cancel(old.id)
      const replacement = yield* jobs.start({ id: old.id, type: "test", run: Effect.never })

      expect(replacement.started_at).toBe(old.started_at)
      expect((yield* captured.done).status).toBe("cancelled")
      expect(yield* captured.cancel).toBeUndefined()
      expect((yield* jobs.get(old.id))?.status).toBe("running")
      yield* jobs.cancel(old.id)
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )

  it.live("moves running work to settling without resolving waiters before the terminal status", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "settling",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect((yield* jobs.beginSettling(job.id))?.status).toBe("settling")
      expect(yield* jobs.beginSettling(job.id)).toMatchObject({ id: job.id, status: "settling" })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "settling" },
      })
      expect((yield* jobs.get(job.id))?.status).toBe("settling")

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("settles settling work as failed or cancelled and never starts a second job under the same id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const failingLatch = yield* Deferred.make<void>()
      const failing = yield* jobs.start({
        id: "failing",
        type: "test",
        run: Deferred.await(failingLatch).pipe(Effect.flatMap(() => Effect.fail(new Error("boom")))),
      })
      yield* jobs.beginSettling(failing.id)
      yield* Deferred.succeed(failingLatch, undefined)
      expect((yield* jobs.wait({ id: failing.id })).info?.status).toBe("error")

      const held = yield* Deferred.make<void>()
      const cancelling = yield* jobs.start({ id: "cancelling", type: "test", run: Deferred.await(held).pipe(Effect.as("done")) })
      yield* jobs.beginSettling(cancelling.id)
      expect((yield* jobs.start({ id: "cancelling", type: "other", run: Effect.succeed("new") }))?.type).toBe("test")
      expect((yield* jobs.cancel(cancelling.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(cancelling.id))?.status).toBe("cancelled")
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("reports every job transition to the optional sink", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const observed: Array<{ from: string | null; to: string; sessionID?: string }> = []
      const jobs = yield* BackgroundJob.makeWith({
        onTransition: (transition) =>
          Effect.sync(() => {
            observed.push({ from: transition.from, to: transition.to, sessionID: transition.sessionID })
          }),
      }).pipe(Scope.provide(scope))
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "observed",
        type: "test",
        metadata: { sessionId: "ses_observed" },
        run: Deferred.await(latch).pipe(Effect.as("ok")),
      })

      yield* jobs.beginSettling(job.id)
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      expect(observed).toEqual([
        { from: null, to: "running", sessionID: "ses_observed" },
        { from: "running", to: "settling", sessionID: "ses_observed" },
        { from: "settling", to: "completed", sessionID: "ses_observed" },
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
