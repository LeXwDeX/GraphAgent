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
      const observed: Array<{
        from: string | null
        to: string
        sessionID?: string
        parentSessionID?: string
        title?: string
        output?: string
        started?: boolean
      }> = []
      const jobs = yield* BackgroundJob.makeWith({
        onTransition: (transition) =>
          Effect.sync(() => {
            observed.push({
              from: transition.from,
              to: transition.to,
              sessionID: transition.sessionID,
              parentSessionID: transition.parentSessionID,
              title: transition.title,
              output: transition.output,
              started: typeof transition.started_at === "number",
            })
          }),
      }).pipe(Scope.provide(scope))
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "observed",
        type: "test",
        title: "observed job",
        // Writers record the current keys (#1069 P9); the registry must read them.
        metadata: { sessionID: "ses_observed", parentSessionID: "ses_parent" },
        run: Deferred.await(latch).pipe(Effect.as("ok")),
      })

      yield* jobs.beginSettling(job.id)
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      // Every transition carries the complete snapshot: a durable observer
      // never has to merge a partial delta (#1069 P5).
      const identity = {
        sessionID: "ses_observed",
        parentSessionID: "ses_parent",
        title: "observed job",
        started: true,
      }
      expect(observed).toEqual([
        { from: null, to: "running", ...identity },
        { from: "running", to: "settling", ...identity },
        { from: "settling", to: "completed", ...identity, output: "ok" },
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("emits exactly one terminal transition when completion, cancel and settling race", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const observed: Array<{ id: string; from: BackgroundJob.Status | null; to: BackgroundJob.Status }> = []
      const jobs = yield* BackgroundJob.makeWith({
        onTransition: (transition) =>
          Effect.sync(() => {
            observed.push({ id: transition.id, from: transition.from, to: transition.to })
          }),
      }).pipe(Scope.provide(scope))
      const terminal = new Set<BackgroundJob.Status>(["completed", "error", "cancelled"])

      yield* Effect.forEach(Array.from({ length: 60 }), (_, index) =>
        Effect.gen(function* () {
          const id = `race_${index}`
          // The job finishes after a varying number of scheduler turns, so every
          // iteration lands its natural completion at a different point of the race.
          yield* jobs.start({
            id,
            type: "test",
            run: Effect.forEach(Array.from({ length: Math.floor(index / 2) % 6 }), () => Effect.yieldNow).pipe(
              Effect.as("done"),
            ),
          })
          // Half of the rounds race a cancel against settling and completion; the
          // other half race settling against completion alone, so the registry sees
          // both `settling -> cancelled` and `settling -> completed`.
          const race = [
            jobs.beginSettling(id),
            ...(index % 2 === 0 ? [jobs.cancel(id)] : []),
            jobs.beginSettling(id),
            jobs.wait({ id }),
          ]
          const turn = index % race.length
          yield* Effect.all([...race.slice(turn), ...race.slice(0, turn)], { concurrency: "unbounded", discard: true })
          // A waiter resumes when the job's `done` resolves, which is just before the
          // job's own fiber hands its terminal transition to the sink. Let the sink
          // catch up, then give a duplicate every chance to show up.
          const seen = () => observed.some((entry) => entry.id === id && terminal.has(entry.to))
          for (let spin = 0; spin < 100 && !seen(); spin++) yield* Effect.yieldNow
          for (let spin = 0; spin < 20; spin++) yield* Effect.yieldNow

          const mine = observed.filter((entry) => entry.id === id)
          // The compare-and-swap inside the registry lets one terminal status win.
          expect(mine.filter((entry) => terminal.has(entry.to))).toHaveLength(1)
          // Settling is entered at most once and every transition continues from the previous one.
          expect(mine.filter((entry) => entry.to === "settling").length).toBeLessThanOrEqual(1)
          expect(mine[0]).toEqual({ id, from: null, to: "running" })
          for (let position = 1; position < mine.length; position++) {
            expect(mine[position]?.from).toBe(mine[position - 1]?.to)
          }
          const final = mine[mine.length - 1]?.to
          expect(final !== undefined && terminal.has(final)).toBe(true)
          expect((yield* jobs.get(id))?.status).toBe(final)
          // Waiters resolve with that same terminal status.
          expect((yield* jobs.wait({ id })).info?.status).toBe(final)
        }),
      )
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("still reads the pre-rename session keys of metadata written before them", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const observed: Array<{ to: string; sessionID?: string; parentSessionID?: string }> = []
      const jobs = yield* BackgroundJob.makeWith({
        onTransition: (transition) =>
          Effect.sync(() => {
            observed.push({
              to: transition.to,
              sessionID: transition.sessionID,
              parentSessionID: transition.parentSessionID,
            })
          }),
      }).pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        metadata: { sessionId: "ses_legacy", parentSessionId: "ses_legacy_parent" },
        run: Effect.succeed("ok"),
      })
      yield* jobs.wait({ id: job.id })

      const identity = { sessionID: "ses_legacy", parentSessionID: "ses_legacy_parent" }
      expect(observed).toEqual([
        { to: "running", ...identity },
        { to: "completed", ...identity },
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("prefers the current keys over the pre-rename ones", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const observed: Array<{ sessionID?: string; parentSessionID?: string }> = []
      const jobs = yield* BackgroundJob.makeWith({
        onTransition: (transition) =>
          Effect.sync(() => {
            observed.push({ sessionID: transition.sessionID, parentSessionID: transition.parentSessionID })
          }),
      }).pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        metadata: {
          sessionID: "ses_new",
          sessionId: "ses_old",
          parentSessionID: "ses_new_parent",
          parentSessionId: "ses_old_parent",
        },
        run: Effect.succeed("ok"),
      })
      yield* jobs.wait({ id: job.id })

      expect(observed.length).toBeGreaterThan(0)
      for (const entry of observed) expect(entry).toEqual({ sessionID: "ses_new", parentSessionID: "ses_new_parent" })
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
