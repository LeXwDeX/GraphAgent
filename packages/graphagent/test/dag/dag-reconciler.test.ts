// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029, PR4a and PR4b: the shell of the reconciler (ADR-0008 decision 6)
 * over a real database and scripted collaborators. `decide` has its own table
 * (`dag-reconcile-decide.test.ts`); the cases here are what the shell does with
 * a verdict: what it reads to make the observation (and in which order), which
 * collaborator each action calls (and which it does not), the flight the orphan
 * terminalization runs in, the single flight of `reconcile`, `reconcileAfter`
 * (the trigger that brings news and is answered by an evaluation that began after
 * it), the clock watch every observation feeds, and the order and the resilience
 * of a round. The loop and two runners over one database are in
 * `dag-runner-lease.test.ts` ("the reconcile tick") and `dag-runner-races.test.ts`
 * (race 3).
 */

import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Semaphore } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Project } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DagReconciler } from "@/dag/runtime/reconciler"
import { ReconcileDecide } from "@/dag/runtime/reconcile-decide"
import type { RunnerLease } from "@/dag/runtime/runner-lease"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const PROJECT = "project-1"
const SESSION = "ses_parent1"
const DIRECTORY = process.cwd()
const RUNNER = "10:me"
const OTHER = "11:other"
const token = (epoch: number): DagLease.Token => ({ runnerID: RUNNER, epoch })

const database = Database.layerFromPath(":memory:")
const store = DagStore.layer.pipe(Layer.provide(database))
const lease = DagLease.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, store, lease))

interface Entry extends RunnerLease.Evictable {
  readonly name: string
}

const entryOf = (name: string, held: DagLease.Token): Entry => ({
  name,
  token: held,
  parentSessionID: SESSION,
  evalLock: Semaphore.makeUnsafe(1),
  fibers: new Map(),
  watchers: new Map(),
  attemptChild: new WeakMap(),
})

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.make(PROJECT), worktree: AbsolutePath.make(DIRECTORY), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(SESSION),
      project_id: Project.ID.make(PROJECT),
      slug: "parent",
      directory: DIRECTORY,
      title: "Parent",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

/** A workflow row of this instance's project, owned by `directory` (this instance's by default). */
const workflow = (
  id: string,
  options: {
    readonly status?: string
    readonly directory?: string
    readonly executionDirectory?: string
    readonly ageMs?: number
    readonly nodes?: ReadonlyArray<string>
  } = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowTable)
      .values({
        id,
        project_id: Project.ID.make(PROJECT),
        session_id: SessionID.make(SESSION),
        directory: options.directory ?? DIRECTORY,
        execution_directory: options.executionDirectory,
        target_fingerprint: { kind: "none" },
        title: id,
        status: options.status ?? "running",
        config: "{}",
        seq: 1,
        wake_reported: true,
        time_created: Date.now() - (options.ageMs ?? 0),
      })
      .run()
      .pipe(Effect.orDie)
    for (const [index, status] of (options.nodes ?? []).entries())
      yield* db
        .insert(WorkflowNodeTable)
        .values({
          id: `n${index + 1}`,
          workflow_id: id,
          name: `n${index + 1}`,
          worker_type: "build",
          status,
          required: true,
          depends_on: [],
          seq: index + 1,
        })
        .run()
        .pipe(Effect.orDie)
  })

/** The lease of `dagID` as another runner holds it: live, or already run out. */
const heldByOther = (dagID: string, how: "live" | "expired") =>
  Effect.gen(function* () {
    const leases = yield* DagLease.Service
    const now = how === "live" ? Date.now() : Date.now() - 2 * DagLease.TTL_MS
    expect(yield* leases.claim({ dagID, runnerID: OTHER, now })).toMatchObject({ runnerID: OTHER, epoch: 1 })
  })

/** The reconciler with every collaborator scripted, and what each was asked. */
const harness = Effect.gen(function* () {
  const real = yield* DagStore.Service
  const leases = yield* DagLease.Service
  const entries = new Map<string, Entry>()
  const calls = {
    getWorkflow: 0,
    getNodes: 0,
    /** What an observation reads, in the order it reads it: the clock, then the lease row, then the workflow row. */
    reads: [] as Array<"clock" | "held" | "workflow">,
    adopt: [] as string[],
    failUnusable: [] as Array<{ readonly dagID: string; readonly location: string }>,
    evictLost: [] as string[],
    evictMoved: [] as string[],
    claim: [] as string[],
    abandon: [] as Array<DagLease.Token | undefined>,
    published: [] as string[],
    failed: [] as Array<{ readonly dagID: string; readonly token: DagLease.Token; readonly reason: string }>,
  }
  // What a test changes about the scripted collaborators.
  const script: {
    claim: DagLease.Token | undefined
    fail: Effect.Effect<void, Error>
    adopt: Effect.Effect<void>
    beforeGetWorkflow: Effect.Effect<void>
    /** Runs once the workflow row is read: an evaluation that parks here concludes from what the row said at that moment. */
    afterGetWorkflow: Effect.Effect<void>
    /** Runs before the nodes of a `pending` workflow are read, which the observation does after it read the ownership. */
    beforeGetNodes: Effect.Effect<void>
    beforeHeld: Effect.Effect<void>
    /** Runs inside the orphan's `WorkflowStarted` publish, where the first-wave handler of the loop would pick the event up. */
    whilePublishing: Effect.Effect<void>
    /** The instance's clock watch, which `RunnerLease` keeps in the loop; a test that gives none runs without one. */
    noteClock: ((at: number) => boolean) | undefined
  } = {
    claim: token(1),
    fail: Effect.void,
    adopt: Effect.void,
    beforeGetWorkflow: Effect.void,
    afterGetWorkflow: Effect.void,
    beforeGetNodes: Effect.void,
    beforeHeld: Effect.void,
    whilePublishing: Effect.void,
    noteClock: undefined,
  }

  const reconciler = DagReconciler.make<Entry>({
    store: {
      ...real,
      getWorkflow: (id) =>
        Effect.suspend(() => {
          calls.getWorkflow++
          calls.reads.push("workflow")
          return script.beforeGetWorkflow.pipe(
            Effect.andThen(real.getWorkflow(id)),
            Effect.tap(() => script.afterGetWorkflow),
          )
        }),
      getNodes: (id) =>
        Effect.suspend(() => {
          calls.getNodes++
          return script.beforeGetNodes.pipe(Effect.andThen(real.getNodes(id)))
        }),
    },
    leases: {
      held: (id) =>
        Effect.suspend(() => {
          calls.reads.push("held")
          return script.beforeHeld.pipe(Effect.andThen(leases.held(id)))
        }),
    },
    runnerID: RUNNER,
    directory: DIRECTORY,
    entries,
    events: {
      // The publish is generic in its event, and the stub only records which one: the cast is the stub's shape.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      publish: ((definition: { readonly type: string }) =>
        Effect.sync(() => void calls.published.push(definition.type)).pipe(
          Effect.andThen(Effect.suspend(() => script.whilePublishing)),
        )) as never,
    },
    lease: {
      claim: (dagID) =>
        Effect.sync(() => {
          calls.claim.push(dagID)
          return script.claim
        }),
      abandon: (_dagID, claimed) => Effect.sync(() => void calls.abandon.push(claimed)),
      evict: (dagID) => Effect.sync(() => void calls.evictLost.push(dagID)),
    },
    portFor: (_dagID, held) => ({
      fail: (dagID, reason) =>
        Effect.suspend(() => script.fail).pipe(
          Effect.tap(() => Effect.sync(() => void calls.failed.push({ dagID, token: held, reason }))),
        ),
    }),
    adopt: (row) => Effect.sync(() => void calls.adopt.push(row.id)).pipe(Effect.andThen(script.adopt)),
    failUnusable: (row, location) =>
      Effect.sync(() => void calls.failUnusable.push({ dagID: row.id, location: location._tag })),
    evictMoved: (dagID) => Effect.sync(() => void calls.evictMoved.push(dagID)),
    noteClock: (at) => {
      calls.reads.push("clock")
      return script.noteClock?.(at) ?? false
    },
  })
  return { reconciler, calls, script, entries }
})

/** A test of a reconciler of this instance: the project, the session and the directory it works in. */
const instance = {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  root: DIRECTORY,
  project: {
    id: Project.ID.make(PROJECT),
    worktree: AbsolutePath.make(DIRECTORY),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
}

const scenario = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  seed.pipe(Effect.andThen(body), Effect.provideService(InstanceRef, instance))

/** What a verdict left behind: nothing was adopted, failed, claimed, evicted or published. */
const untouched = (calls: Effect.Success<typeof harness>["calls"]) => {
  expect(calls.adopt).toEqual([])
  expect(calls.failUnusable).toEqual([])
  expect(calls.evictLost).toEqual([])
  expect(calls.evictMoved).toEqual([])
  expect(calls.claim).toEqual([])
  expect(calls.published).toEqual([])
  expect(calls.failed).toEqual([])
}

describe("what the reconciler does with a verdict", () => {
  it.live("a workflow that is gone or terminal is left alone, whatever else is known about it", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries } = yield* harness
        yield* workflow("wf-done", { status: "completed" })
        entries.set("wf-done", entryOf("done", token(1)))

        expect(yield* reconciler.reconcile("wf-done")).toEqual({ _tag: "noop" })
        expect(yield* reconciler.reconcile("wf-nowhere")).toEqual({ _tag: "noop" })
        untouched(calls)
      }),
    ),
  )

  it.live("a workflow of another directory is nobody's business here, unless the instance has an entry for it", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries } = yield* harness
        yield* workflow("wf-foreign", { directory: "/somewhere/else" })

        expect(yield* reconciler.reconcile("wf-foreign")).toEqual({ _tag: "noop" })
        untouched(calls)

        // The entry is what ownership no longer covers: dropped as a session that moved away is.
        const entry = entryOf("foreign", token(1))
        entries.set("wf-foreign", entry)
        expect(yield* reconciler.reconcile("wf-foreign")).toEqual({ _tag: "evict", reason: "not-owned" })
        expect(calls.evictMoved).toEqual(["wf-foreign"])
        expect(calls.evictLost).toEqual([])
      }),
    ),
  )

  it.live("an entry whose lease row names another runner is evicted as lost, and nothing else is judged", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries } = yield* harness
        yield* workflow("wf-lost")
        yield* heldByOther("wf-lost", "live")
        entries.set("wf-lost", entryOf("lost", token(1)))

        expect(yield* reconciler.reconcile("wf-lost")).toEqual({ _tag: "evict", reason: "lease-lost" })

        expect(calls.evictLost).toEqual(["wf-lost"])
        expect(calls.evictMoved).toEqual([])
        expect(calls.adopt).toEqual([])
        expect(calls.claim).toEqual([])
      }),
    ),
  )

  it.live("an entry whose lease is held only renews, which the tick did: the round writes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries } = yield* harness
        yield* workflow("wf-mine")
        const leases = yield* DagLease.Service
        const claimed = yield* leases.claim({ dagID: "wf-mine", runnerID: RUNNER, now: Date.now() })
        entries.set("wf-mine", entryOf("mine", { runnerID: RUNNER, epoch: claimed?.epoch ?? 0 }))

        expect(yield* reconciler.reconcile("wf-mine")).toEqual({ _tag: "renew" })
        untouched(calls)
      }),
    ),
  )

  it.live("another runner's live lease is neither claimed nor judged", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-theirs")
        yield* heldByOther("wf-theirs", "live")

        expect(yield* reconciler.reconcile("wf-theirs")).toEqual({ _tag: "defer", reason: "other-live" })
        untouched(calls)
      }),
    ),
  )

  it.live("a location that cannot be used is failed durably, with the verdict of the location", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-gone-dir", { executionDirectory: "/nonexistent/dag-reconciler-workspace" })

        expect(yield* reconciler.reconcile("wf-gone-dir")).toEqual({ _tag: "fail-unrecoverable" })

        expect(calls.failUnusable).toEqual([{ dagID: "wf-gone-dir", location: "missing" }])
        expect(calls.adopt).toEqual([])
      }),
    ),
  )

  it.live("a workflow nobody drives is adopted with the row that was read: no lease row, or one that ran out", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-free")
        yield* workflow("wf-ran-out")
        yield* heldByOther("wf-ran-out", "expired")

        expect(yield* reconciler.reconcile("wf-free")).toEqual({ _tag: "adopt" })
        expect(yield* reconciler.reconcile("wf-ran-out")).toEqual({ _tag: "adopt" })

        expect(calls.adopt).toEqual(["wf-free", "wf-ran-out"])
      }),
    ),
  )

  it.live(
    "another runner's expired lease is left alone right after a clock jump, and taken once the jump is behind",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls } = yield* harness
          yield* workflow("wf-jump")
          yield* heldByOther("wf-jump", "expired")

          expect(yield* reconciler.reconcile("wf-jump", { afterClockJump: true })).toEqual({
            _tag: "defer",
            reason: "clock-jump",
          })
          expect(calls.adopt).toEqual([])
          expect(yield* reconciler.reconcile("wf-jump", { afterClockJump: false })).toEqual({ _tag: "adopt" })
          expect(calls.adopt).toEqual(["wf-jump"])
        }),
      ),
  )

  it.live("an adoption that fails fails the evaluation, and the next one starts afresh", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-boom")
        script.adopt = Effect.die(new Error("recovery failed"))

        const exit = yield* Effect.exit(reconciler.reconcile("wf-boom"))
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

        script.adopt = Effect.void
        expect(yield* reconciler.reconcile("wf-boom")).toEqual({ _tag: "adopt" })
        expect(calls.adopt).toEqual(["wf-boom", "wf-boom"])
      }),
    ),
  )
})

describe("the order of the reads (ADR-0008 decision 6, row 3)", () => {
  it.live("an observation reads the clock, then the lease row, then the workflow row", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-order")

        yield* reconciler.reconcile("wf-order")

        // The lease row before the workflow: `DagLease.held` has no row for a workflow that ended.
        expect(calls.reads).toEqual(["clock", "held", "workflow"])
      }),
    ),
  )

  // `DagLease.held` joins the workflow row and has none for a workflow that ended. Read second, it reports the lease of
  // a workflow that ended between the two reads as lost, and its entry would be evicted before the terminal handler
  // gets it (no worktree settlement, no wake of the parent).
  it.live(
    "a workflow that ends between the two reads is not a lost lease: its entry is left to the terminal handler",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, entries, script } = yield* harness
          yield* workflow("wf-ending")
          const { db } = yield* Database.Service
          const complete = db
            .run(sql`UPDATE workflow SET status = 'completed' WHERE id = 'wf-ending'`)
            .pipe(Effect.orDie)
          const leases = yield* DagLease.Service
          const claimed = yield* leases.claim({ dagID: "wf-ending", runnerID: RUNNER, now: Date.now() })
          const entry = entryOf("ending", { runnerID: RUNNER, epoch: claimed?.epoch ?? 0 })
          entries.set("wf-ending", entry)
          // It ends right before the second of the two reads, whichever of them that is.
          let reads = 0
          const endsBeforeTheSecondRead = Effect.suspend(() => (++reads === 2 ? complete : Effect.void))
          script.beforeHeld = endsBeforeTheSecondRead
          script.beforeGetWorkflow = endsBeforeTheSecondRead

          expect(yield* reconciler.reconcile("wf-ending")).toEqual({ _tag: "noop" })

          expect(reads).toBe(2)
          expect(entries.get("wf-ending")).toBe(entry)
          untouched(calls)
        }),
      ),
  )

  // The workflow ends as the lease row is read: `DagLease.held` has no row for it any more, and the workflow row read
  // after it says that it ended. (Read the other way round, the workflow row would have shown a live workflow.)
  it.live("a lease row that is gone because the workflow ended, and the workflow row that says so, are a noop", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries, script } = yield* harness
        yield* workflow("wf-over")
        const { db } = yield* Database.Service
        const leases = yield* DagLease.Service
        const claimed = yield* leases.claim({ dagID: "wf-over", runnerID: RUNNER, now: Date.now() })
        const entry = entryOf("over", { runnerID: RUNNER, epoch: claimed?.epoch ?? 0 })
        entries.set("wf-over", entry)
        // The workflow fails right before the lease row is read.
        script.beforeHeld = db
          .run(sql`UPDATE workflow SET status = 'failed' WHERE id = 'wf-over'`)
          .pipe(Effect.orDie, Effect.asVoid)

        expect(yield* reconciler.reconcile("wf-over")).toEqual({ _tag: "noop" })

        expect(entries.get("wf-over")).toBe(entry)
        untouched(calls)
      }),
    ),
  )

  it.live("a lease that another runner took is still evicted as lost while the workflow is live", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries } = yield* harness
        yield* workflow("wf-taken")
        yield* heldByOther("wf-taken", "live")
        entries.set("wf-taken", entryOf("taken", token(1)))

        expect(yield* reconciler.reconcile("wf-taken")).toEqual({ _tag: "evict", reason: "lease-lost" })

        expect(calls.evictLost).toEqual(["wf-taken"])
      }),
    ),
  )
})

describe("the clock watch (ADR-0008 decision 2): every observation feeds it", () => {
  const PERIOD = DagLease.RENEWAL_PERIOD_MS
  const START = 1_000_000

  /** The watch of an instance as `RunnerLease` keeps it: seeded with the start of the instance, fed with every reading. */
  const watchFrom = (seed: number) => {
    let watch = ReconcileDecide.noteClock(ReconcileDecide.unwatched, seed, PERIOD).watch
    const readings: number[] = []
    const noteClock = (at: number) => {
      readings.push(at)
      const noted = ReconcileDecide.noteClock(watch, at, PERIOD)
      watch = noted.watch
      return noted.afterJump
    }
    return { noteClock, readings }
  }

  /** A workflow whose lease another runner last renewed at 0: it ran out long before `START`. */
  const lapsed = (dagID: string, ageMs: number) =>
    Effect.gen(function* () {
      yield* workflow(dagID, { ageMs })
      const leases = yield* DagLease.Service
      expect(yield* leases.claim({ dagID, runnerID: OTHER, now: 0 })).toMatchObject({ runnerID: OTHER, epoch: 1 })
    })

  it.effect(
    "a jump between two observations of one round holds back the second, and the quiet period outlasts the round",
    () =>
      scenario(
        Effect.gen(function* () {
          yield* TestClock.setTime(START)
          const { reconciler, calls, script } = yield* harness
          const { noteClock, readings } = watchFrom(START)
          script.noteClock = noteClock
          // A round looks at the newest workflow first.
          yield* lapsed("wf-first", 1_000)
          yield* lapsed("wf-second", 5_000)
          // Adopting the first takes the machine two minutes (it sleeps through them): the second is looked at after
          // that, with a lease that ran out only because nobody could renew it. Its round was told no jump.
          script.adopt = TestClock.adjust("2 minutes")

          yield* reconciler.round({ afterClockJump: false })

          expect(readings).toEqual([START, START + 120_000])
          expect(calls.adopt).toEqual(["wf-first"])

          // The jump started a quiet period of two periods: a round inside it holds both back, and a lease is taken
          // by the first round after it. A round is no different for having been told nothing.
          script.adopt = Effect.void
          yield* TestClock.adjust(`${PERIOD} millis`)
          yield* reconciler.round({ afterClockJump: false })
          expect(calls.adopt).toEqual(["wf-first"])
          yield* TestClock.adjust(`${PERIOD} millis`)
          yield* reconciler.round({ afterClockJump: false })
          expect(calls.adopt).toEqual(["wf-first", "wf-first", "wf-second"])
        }),
      ),
  )

  it.effect(
    "an observation takes the verdict of the watch and the caller's together: either one holds a takeover back",
    () =>
      scenario(
        Effect.gen(function* () {
          yield* TestClock.setTime(START)
          const { reconciler, calls, script } = yield* harness
          const { noteClock } = watchFrom(START)
          script.noteClock = noteClock
          yield* lapsed("wf-lapsed", 1_000)

          // The watch saw no jump, the caller did.
          expect(yield* reconciler.reconcile("wf-lapsed", { afterClockJump: true })).toEqual({
            _tag: "defer",
            reason: "clock-jump",
          })
          // The watch sees one (nothing was fed for 10 periods), the caller did not.
          yield* TestClock.adjust(`${10 * PERIOD} millis`)
          expect(yield* reconciler.reconcile("wf-lapsed", { afterClockJump: false })).toEqual({
            _tag: "defer",
            reason: "clock-jump",
          })
          expect(calls.adopt).toEqual([])
        }),
      ),
  )

  // The reading is taken before the lease row: a process that is suspended between the two (a round that was in flight
  // when the machine went to sleep) sees the lease as it was before, which can only make it look younger than it is.
  it.effect(
    "judges the lease against the clock as it was before the read: a stall in between never makes it expired",
    () =>
      scenario(
        Effect.gen(function* () {
          yield* TestClock.setTime(START)
          const { reconciler, calls, script } = yield* harness
          yield* workflow("wf-stalled", { ageMs: 1_000 })
          const leases = yield* DagLease.Service
          // Renewed by another runner at the very moment of the reading: live for another 90 s.
          yield* leases.claim({ dagID: "wf-stalled", runnerID: OTHER, now: START })
          script.beforeHeld = TestClock.adjust("2 minutes")

          expect(yield* reconciler.reconcile("wf-stalled")).toEqual({ _tag: "defer", reason: "other-live" })
          expect(calls.adopt).toEqual([])
        }),
      ),
  )

  it.live(
    "every observation feeds its reading, whatever it concludes: a workflow that is gone or foreign included",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          const readings: number[] = []
          script.noteClock = (at) => {
            readings.push(at)
            return false
          }
          yield* workflow("wf-foreign", { directory: "/somewhere/else" })

          yield* reconciler.reconcile("wf-nowhere")
          yield* reconciler.reconcile("wf-foreign")

          expect(readings).toHaveLength(2)
          // The reading is the first thing an observation does.
          expect(calls.reads.filter((read) => read === "clock")).toHaveLength(2)
          expect(calls.reads[0]).toBe("clock")
        }),
      ),
  )
})

describe("an orphan pending workflow (ADR-0008 decision 6, rows 8 and 9)", () => {
  const old = ReconcileDecide.ORPHAN_PENDING_GRACE_MS + 1_000

  it.live("is claimed, started and failed under the claim, which is then given back", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-orphan", { status: "pending", ageMs: old, nodes: ["pending", "pending"] })

        expect(yield* reconciler.reconcile("wf-orphan")).toEqual({ _tag: "terminalize-orphan" })

        expect(calls.claim).toEqual(["wf-orphan"])
        expect(calls.published).toEqual([DagEvent.WorkflowStarted.type])
        expect(calls.failed).toEqual([{ dagID: "wf-orphan", token: token(1), reason: DagReconciler.ORPHAN_REASON }])
        expect(calls.abandon).toEqual([token(1)])
      }),
    ),
  )

  // The first-wave handler of the loop calls `reconcileAfter` for every `WorkflowStarted`, and the orphan path publishes
  // one of its own to legalize pending -> running -> failed. It must not adopt the orphan mid-way (a zero-node orphan
  // would be completed instead of failed): the call waits for the flight of the terminalization and finds the failure.
  it.live("raises the first wave of its own WorkflowStarted, which waits for it and finds the workflow failed", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        const { db } = yield* Database.Service
        yield* workflow("wf-orphan", { status: "pending", ageMs: old, nodes: ["pending"] })
        const raised: Array<Fiber.Fiber<ReconcileDecide.Action>> = []
        script.whilePublishing = reconciler.reconcileAfter("wf-orphan").pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.tap((fiber) => Effect.sync(() => void raised.push(fiber))),
          Effect.asVoid,
        )
        // The failure as the real command makes it, which the first wave reads afterwards.
        script.fail = db
          .run(sql`UPDATE workflow SET status = 'failed' WHERE id = 'wf-orphan'`)
          .pipe(Effect.orDie, Effect.asVoid)

        expect(yield* reconciler.reconcile("wf-orphan")).toEqual({ _tag: "terminalize-orphan" })

        expect(raised).toHaveLength(1)
        expect(yield* Fiber.join(raised[0])).toEqual({ _tag: "noop" })
        // Two evaluations (the orphan's, then the first wave's), and nothing was adopted.
        expect(calls.getWorkflow).toBe(2)
        expect(calls.adopt).toEqual([])
        expect(calls.claim).toEqual(["wf-orphan"])
      }),
    ),
  )

  it.live("is not touched within the grace period, or when a node has progressed", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-young", {
          status: "pending",
          ageMs: ReconcileDecide.ORPHAN_PENDING_GRACE_MS - 10_000,
          nodes: ["pending"],
        })
        yield* workflow("wf-started", { status: "pending", ageMs: old, nodes: ["pending", "running"] })

        expect(yield* reconciler.reconcile("wf-young")).toEqual({ _tag: "defer", reason: "pending" })
        expect(yield* reconciler.reconcile("wf-started")).toEqual({ _tag: "defer", reason: "pending" })
        untouched(calls)
      }),
    ),
  )

  it.live("is left to the runner that holds a live lease on it", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-driven", { status: "pending", ageMs: old, nodes: ["pending"] })
        yield* heldByOther("wf-driven", "live")

        expect(yield* reconciler.reconcile("wf-driven")).toEqual({ _tag: "defer", reason: "other-live" })
        untouched(calls)
      }),
    ),
  )

  it.live(
    "is not terminalized when its claim is refused: nothing is published, and there is nothing to give back",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          yield* workflow("wf-refused", { status: "pending", ageMs: old, nodes: ["pending"] })
          script.claim = undefined

          expect(yield* reconciler.reconcile("wf-refused")).toEqual({ _tag: "terminalize-orphan" })

          expect(calls.claim).toEqual(["wf-refused"])
          expect(calls.published).toEqual([])
          expect(calls.failed).toEqual([])
          expect(calls.abandon).toEqual([undefined])
        }),
      ),
  )

  // The verdict is made from an observation, and an adoption can publish its entry in between.
  it.live("is not started again when an adoption published its entry since the observation", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, entries, script } = yield* harness
        yield* workflow("wf-busy", {
          status: "pending",
          ageMs: ReconcileDecide.ORPHAN_PENDING_GRACE_MS + 1_000,
          nodes: ["pending"],
        })

        // The observation reads the entries first, then the row: an entry that appears during the read is not in it.
        script.beforeGetWorkflow = Effect.sync(() => void entries.set("wf-busy", entryOf("busy", token(1))))
        expect(yield* reconciler.reconcile("wf-busy")).toEqual({ _tag: "terminalize-orphan" })

        untouched(calls)
      }),
    ),
  )

  it.live(
    "gives its claim back and ends its flight when the failure is rejected, which ends the evaluation as a defect",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          yield* workflow("wf-rejected", { status: "pending", ageMs: old, nodes: ["pending"] })
          script.fail = Effect.fail(new Error("the transition is not legal any more"))

          const exit = yield* Effect.exit(reconciler.reconcile("wf-rejected"))

          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          expect(calls.abandon).toEqual([token(1)])
          // The flight is over: the next call evaluates for itself, and gets the same orphan to dispose of.
          script.fail = Effect.void
          expect(yield* reconciler.reconcile("wf-rejected")).toEqual({ _tag: "terminalize-orphan" })
          expect(calls.claim).toEqual(["wf-rejected", "wf-rejected"])
        }),
      ),
  )

  it.live(
    "an owner-less one (an empty directory stamp) is failed as an unusable location, the verdict that it has no owner",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls } = yield* harness
          yield* workflow("wf-ownerless", { status: "pending", directory: "", nodes: ["pending"] })

          expect(yield* reconciler.reconcile("wf-ownerless")).toEqual({ _tag: "fail-unrecoverable" })

          expect(calls.failUnusable).toEqual([{ dagID: "wf-ownerless", location: "invalid" }])
        }),
      ),
  )

  it.live("an owner-less workflow that is not pending is nobody's, as ever", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-ownerless-running", { status: "running", directory: "" })

        expect(yield* reconciler.reconcile("wf-ownerless-running")).toEqual({ _tag: "noop" })
        untouched(calls)
      }),
    ),
  )
})

describe("reconcile is single-flight", () => {
  it.live("calls for one workflow that overlap share one evaluation, and the next one evaluates again", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-shared")
        const gate = yield* Deferred.make<void>()
        script.beforeGetWorkflow = Deferred.await(gate)

        const first = yield* reconciler.reconcile("wf-shared").pipe(Effect.forkChild({ startImmediately: true }))
        const second = yield* reconciler.reconcile("wf-shared").pipe(Effect.forkChild({ startImmediately: true }))
        const third = yield* reconciler.reconcile("wf-shared").pipe(Effect.forkChild({ startImmediately: true }))
        yield* pollWithTimeout(
          Effect.sync(() => (calls.getWorkflow > 0 ? true : undefined)),
          "the evaluation never started",
        )
        // Three callers, one observation: the other two wait for its answer.
        expect(calls.getWorkflow).toBe(1)

        yield* Deferred.succeed(gate, undefined)
        const answers = [yield* Fiber.join(first), yield* Fiber.join(second), yield* Fiber.join(third)]
        expect(answers).toEqual([{ _tag: "adopt" }, { _tag: "adopt" }, { _tag: "adopt" }])
        expect(calls.adopt).toEqual(["wf-shared"])

        // The flight is over: a later call is a new evaluation.
        yield* reconciler.reconcile("wf-shared")
        expect(calls.getWorkflow).toBe(2)
      }),
    ),
  )

  it.live("calls for different workflows do not wait for each other", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-a")
        yield* workflow("wf-b")
        const gate = yield* Deferred.make<void>()
        // Only the first observation parks.
        let parked = false
        script.beforeGetWorkflow = Effect.suspend(() => {
          if (parked) return Effect.void
          parked = true
          return Deferred.await(gate)
        })

        const slow = yield* reconciler.reconcile("wf-a").pipe(Effect.forkChild({ startImmediately: true }))
        expect(yield* reconciler.reconcile("wf-b")).toEqual({ _tag: "adopt" })
        expect(calls.adopt).toEqual(["wf-b"])

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(slow)
        expect(calls.adopt).toEqual(["wf-b", "wf-a"])
      }),
    ),
  )

  it.live("a call that joined an evaluation that was interrupted evaluates for itself", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-interrupted")
        const gate = yield* Deferred.make<void>()
        // The first observation parks for good; the next ones go through.
        let parked = false
        script.beforeGetWorkflow = Effect.suspend(() => {
          if (parked) return Effect.void
          parked = true
          return Deferred.await(gate)
        })

        const evaluator = yield* reconciler
          .reconcile("wf-interrupted")
          .pipe(Effect.forkChild({ startImmediately: true }))
        const joiner = yield* reconciler.reconcile("wf-interrupted").pipe(Effect.forkChild({ startImmediately: true }))
        yield* pollWithTimeout(
          Effect.sync(() => (calls.getWorkflow > 0 ? true : undefined)),
          "the evaluation never started",
        )
        yield* Fiber.interrupt(evaluator)

        // The joiner was not interrupted with it: it observed and adopted on its own.
        expect(yield* Fiber.join(joiner)).toEqual({ _tag: "adopt" })
        expect(calls.getWorkflow).toBe(2)
        expect(calls.adopt).toEqual(["wf-interrupted"])
      }),
    ),
  )

  it.live("an evaluation that fails fails the calls that joined it too, and is not remembered", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-failing")
        const gate = yield* Deferred.make<void>()
        script.beforeGetWorkflow = Deferred.await(gate)
        script.adopt = Effect.die(new Error("recovery failed"))

        const first = yield* reconciler
          .reconcile("wf-failing")
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        const second = yield* reconciler
          .reconcile("wf-failing")
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(gate, undefined)

        for (const exit of [yield* Fiber.join(first), yield* Fiber.join(second)])
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(calls.adopt).toEqual(["wf-failing"])

        script.adopt = Effect.void
        expect(yield* reconciler.reconcile("wf-failing")).toEqual({ _tag: "adopt" })
      }),
    ),
  )
})

describe("reconcileAfter: a trigger that brings news is answered by an evaluation that began after it", () => {
  type Script = Effect.Success<typeof harness>["script"]
  type Calls = Effect.Success<typeof harness>["calls"]

  /** The evaluations park after they read the workflow row, one gate each in the order they read it; later ones go through. */
  const parkAfterRead = (script: Script, gates: ReadonlyArray<Deferred.Deferred<void>>) => {
    let next = 0
    script.afterGetWorkflow = Effect.suspend(() => (next < gates.length ? Deferred.await(gates[next++]) : Effect.void))
  }
  /** Wait until the evaluations have read the workflow row `count` times in all. */
  const reads = (calls: Calls, count: number) =>
    pollWithTimeout(
      Effect.sync(() => (calls.getWorkflow >= count ? true : undefined)),
      `the evaluations read the workflow ${calls.getWorkflow} times, not ${count}`,
    )
  const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkChild(effect, { startImmediately: true })
  const died = <A>(exit: Exit.Exit<A, unknown>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)

  it.live("with nothing under way it is `reconcile`: it evaluates at once and leaves no flight behind", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-idle")

        expect(yield* reconciler.reconcileAfter("wf-idle")).toEqual({ _tag: "adopt" })
        expect(calls.getWorkflow).toBe(1)
        expect(calls.adopt).toEqual(["wf-idle"])

        // Nothing is left to join or to wait for: every later call evaluates for itself.
        expect(yield* reconciler.reconcileAfter("wf-idle")).toEqual({ _tag: "adopt" })
        expect(yield* reconciler.reconcile("wf-idle")).toEqual({ _tag: "adopt" })
        expect(calls.getWorkflow).toBe(3)
      }),
    ),
  )

  // The evaluation under way read the workflow as ended and concludes `noop`; an extend has reopened it since, and its
  // WorkflowReplanned finds no entry. Joining would hand it the stale `noop` and leave the workflow to the next tick.
  it.live(
    "a workflow that was reopened while an evaluation judged it ended is adopted by the call that came with it",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          const { db } = yield* Database.Service
          yield* workflow("wf-reopened", { status: "completed" })
          const gate = yield* Deferred.make<void>()
          parkAfterRead(script, [gate])

          const tick = yield* fork(reconciler.reconcile("wf-reopened"))
          yield* reads(calls, 1)
          yield* db.run(sql`UPDATE workflow SET status = 'running' WHERE id = 'wf-reopened'`).pipe(Effect.orDie)
          const replanned = yield* fork(reconciler.reconcileAfter("wf-reopened"))
          // It neither takes the verdict of the evaluation under way nor evaluates beside it.
          expect(calls.getWorkflow).toBe(1)
          yield* Deferred.succeed(gate, undefined)

          expect(yield* Fiber.join(tick)).toEqual({ _tag: "noop" })
          expect(yield* Fiber.join(replanned)).toEqual({ _tag: "adopt" })
          expect(calls.getWorkflow).toBe(2)
          expect(calls.adopt).toEqual(["wf-reopened"])
        }),
      ),
  )

  it.live("`reconcile` in the same situation takes the verdict of the evaluation under way, as the tick does", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        const { db } = yield* Database.Service
        yield* workflow("wf-joined", { status: "completed" })
        const gate = yield* Deferred.make<void>()
        parkAfterRead(script, [gate])

        const first = yield* fork(reconciler.reconcile("wf-joined"))
        yield* reads(calls, 1)
        yield* db.run(sql`UPDATE workflow SET status = 'running' WHERE id = 'wf-joined'`).pipe(Effect.orDie)
        const second = yield* fork(reconciler.reconcile("wf-joined"))
        yield* Deferred.succeed(gate, undefined)

        expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([{ _tag: "noop" }, { _tag: "noop" }])
        expect(calls.getWorkflow).toBe(1)
        expect(calls.adopt).toEqual([])
        // The next round is the one that looks again.
        expect(yield* reconciler.reconcile("wf-joined")).toEqual({ _tag: "adopt" })
      }),
    ),
  )

  it.live("calls that arrive during the same wait share one re-evaluation", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-shared")
        const gate = yield* Deferred.make<void>()
        parkAfterRead(script, [gate])

        const tick = yield* fork(reconciler.reconcile("wf-shared"))
        yield* reads(calls, 1)
        const triggers = [
          yield* fork(reconciler.reconcileAfter("wf-shared")),
          yield* fork(reconciler.reconcileAfter("wf-shared")),
          yield* fork(reconciler.reconcileAfter("wf-shared")),
        ]
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(tick)).toEqual({ _tag: "adopt" })
        for (const trigger of triggers) expect(yield* Fiber.join(trigger)).toEqual({ _tag: "adopt" })
        // The evaluation under way, and one more for the three: two observations, two adoptions.
        expect(calls.getWorkflow).toBe(2)
        expect(calls.adopt).toEqual(["wf-shared", "wf-shared"])
      }),
    ),
  )

  it.live(
    "a call that arrives during the re-evaluation does not join it, which began before: it waits for the next",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          yield* workflow("wf-again")
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          parkAfterRead(script, [first, second])

          const tick = yield* fork(reconciler.reconcile("wf-again"))
          yield* reads(calls, 1)
          const early = yield* fork(reconciler.reconcileAfter("wf-again"))
          // The evaluation under way ends, and the re-evaluation reads the row and parks with what it read.
          yield* Deferred.succeed(first, undefined)
          yield* Fiber.join(tick)
          yield* reads(calls, 2)
          const late = yield* fork(reconciler.reconcileAfter("wf-again"))
          expect(calls.getWorkflow).toBe(2)
          yield* Deferred.succeed(second, undefined)

          expect(yield* Fiber.join(early)).toEqual({ _tag: "adopt" })
          expect(yield* Fiber.join(late)).toEqual({ _tag: "adopt" })
          // One evaluation for the call that came late, which no earlier read could answer.
          expect(calls.getWorkflow).toBe(3)
        }),
      ),
  )

  it.live("the evaluation under way failing does not take the re-evaluation with it", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-fails")
        const gate = yield* Deferred.make<void>()
        parkAfterRead(script, [gate])
        let attempts = 0
        script.adopt = Effect.suspend(() => (++attempts === 1 ? Effect.die(new Error("recovery failed")) : Effect.void))

        const tick = yield* fork(Effect.exit(reconciler.reconcile("wf-fails")))
        yield* reads(calls, 1)
        const trigger = yield* fork(reconciler.reconcileAfter("wf-fails"))
        yield* Deferred.succeed(gate, undefined)

        expect(died(yield* Fiber.join(tick))).toBe(true)
        expect(yield* Fiber.join(trigger)).toEqual({ _tag: "adopt" })
        expect(calls.adopt).toEqual(["wf-fails", "wf-fails"])
      }),
    ),
  )

  it.live("the evaluation under way being interrupted does not take the re-evaluation with it", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-cut")
        parkAfterRead(script, [yield* Deferred.make<void>()])

        const tick = yield* fork(reconciler.reconcile("wf-cut"))
        yield* reads(calls, 1)
        const trigger = yield* fork(reconciler.reconcileAfter("wf-cut"))
        yield* Fiber.interrupt(tick)

        expect(yield* Fiber.join(trigger)).toEqual({ _tag: "adopt" })
        // The interrupted evaluation never got to adopt; the re-evaluation did, once.
        expect(calls.getWorkflow).toBe(2)
        expect(calls.adopt).toEqual(["wf-cut"])
      }),
    ),
  )

  it.live("the call that leads the re-evaluation being interrupted leaves the calls that follow it an answer", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-led")
        const gate = yield* Deferred.make<void>()
        parkAfterRead(script, [gate])

        const tick = yield* fork(reconciler.reconcile("wf-led"))
        yield* reads(calls, 1)
        const leader = yield* fork(reconciler.reconcileAfter("wf-led"))
        const follower = yield* fork(reconciler.reconcileAfter("wf-led"))
        yield* Fiber.interrupt(leader)
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(follower)).toEqual({ _tag: "adopt" })
        yield* Fiber.join(tick)
        // One re-evaluation for the follower, which took the lead; none for the leader that was cut off.
        expect(calls.getWorkflow).toBe(2)
        expect(calls.adopt).toEqual(["wf-led", "wf-led"])
      }),
    ),
  )

  it.live("a re-evaluation that fails fails the calls that share it, and is not remembered", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-shared-failure")
        const gate = yield* Deferred.make<void>()
        parkAfterRead(script, [gate])
        let attempts = 0
        script.adopt = Effect.suspend(() => (++attempts === 2 ? Effect.die(new Error("recovery failed")) : Effect.void))

        const tick = yield* fork(reconciler.reconcile("wf-shared-failure"))
        yield* reads(calls, 1)
        const leader = yield* fork(Effect.exit(reconciler.reconcileAfter("wf-shared-failure")))
        const follower = yield* fork(Effect.exit(reconciler.reconcileAfter("wf-shared-failure")))
        yield* Deferred.succeed(gate, undefined)

        yield* Fiber.join(tick)
        expect(died(yield* Fiber.join(leader))).toBe(true)
        expect(died(yield* Fiber.join(follower))).toBe(true)
        expect(calls.getWorkflow).toBe(2)

        expect(yield* reconciler.reconcileAfter("wf-shared-failure")).toEqual({ _tag: "adopt" })
        expect(calls.adopt).toHaveLength(3)
      }),
    ),
  )

  it.live(
    "the tick joins whichever evaluation is under way and is never made to wait for a trigger's re-evaluation",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script } = yield* harness
          yield* workflow("wf-ticked")
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          parkAfterRead(script, [first, second])
          const done = { joiner: false, tick: false }

          const early = yield* fork(reconciler.reconcile("wf-ticked"))
          yield* reads(calls, 1)
          const trigger = yield* fork(reconciler.reconcileAfter("wf-ticked"))
          // A tick that arrives while the trigger waits joins the evaluation under way, not the re-evaluation behind it.
          const joiner = yield* fork(
            reconciler.reconcile("wf-ticked").pipe(Effect.tap(() => Effect.sync(() => void (done.joiner = true)))),
          )
          yield* Deferred.succeed(first, undefined)
          yield* reads(calls, 2)
          yield* pollWithTimeout(
            Effect.sync(() => (done.joiner ? true : undefined)),
            "the tick was held up by the re-evaluation",
          )
          // One that arrives during the re-evaluation joins that one: no evaluation of its own.
          const tick = yield* fork(
            reconciler.reconcile("wf-ticked").pipe(Effect.tap(() => Effect.sync(() => void (done.tick = true)))),
          )
          expect(calls.getWorkflow).toBe(2)
          yield* Deferred.succeed(second, undefined)

          yield* Fiber.join(early)
          yield* Fiber.join(joiner)
          expect(yield* Fiber.join(trigger)).toEqual({ _tag: "adopt" })
          expect(yield* Fiber.join(tick)).toEqual({ _tag: "adopt" })
          expect(done.tick).toBe(true)
          expect(calls.getWorkflow).toBe(2)
        }),
      ),
  )

  // The last stretch of an observation that the harness can park is the nodes of a `pending` workflow, which are read
  // after the ownership was: the evaluation has concluded that the directory owns the workflow and the entry may stay.
  it.live(
    "a session that moved away while an evaluation judged its entry renewable is evicted by the call that came with the move",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script, entries } = yield* harness
          const { db } = yield* Database.Service
          yield* workflow("wf-away", { status: "pending", nodes: ["pending"] })
          const leases = yield* DagLease.Service
          const claimed = yield* leases.claim({ dagID: "wf-away", runnerID: RUNNER, now: Date.now() })
          entries.set("wf-away", entryOf("away", { runnerID: RUNNER, epoch: claimed?.epoch ?? 0 }))
          const gate = yield* Deferred.make<void>()
          script.beforeGetNodes = Deferred.await(gate)

          const tick = yield* fork(reconciler.reconcile("wf-away"))
          yield* pollWithTimeout(
            Effect.sync(() => (calls.getNodes > 0 ? true : undefined)),
            "the evaluation never reached the nodes",
          )
          // The session moves: the projection re-stamps the workflow, and the Moved handler calls `reconcileAfter`.
          yield* db.run(sql`UPDATE workflow SET directory = '/somewhere/else' WHERE id = 'wf-away'`).pipe(Effect.orDie)
          const moved = yield* fork(reconciler.reconcileAfter("wf-away"))
          expect(calls.evictMoved).toEqual([])
          yield* Deferred.succeed(gate, undefined)

          // The evaluation under way read the stamp as it was: the entry stays. The one that came with the move does not.
          expect(yield* Fiber.join(tick)).toEqual({ _tag: "renew" })
          expect(yield* Fiber.join(moved)).toEqual({ _tag: "evict", reason: "not-owned" })
          expect(calls.evictMoved).toEqual(["wf-away"])
        }),
      ),
  )

  it.live(
    "workflows do not wait for each other: a round that is parked on one does not hold a trigger for another",
    () =>
      scenario(
        Effect.gen(function* () {
          const { reconciler, calls, script, entries } = yield* harness
          yield* workflow("wf-slow")
          yield* workflow("wf-moved")
          // The session of wf-moved has moved away: the row is stamped for another directory, and this instance still has
          // its entry.
          const { db } = yield* Database.Service
          yield* db.run(sql`UPDATE workflow SET directory = '/somewhere/else' WHERE id = 'wf-moved'`).pipe(Effect.orDie)
          entries.set("wf-moved", entryOf("moved", token(1)))
          // The round is in progress, parked on the first workflow it looks at.
          const gate = yield* Deferred.make<void>()
          let parked = false
          script.beforeGetWorkflow = Effect.suspend(() => {
            if (parked) return Effect.void
            parked = true
            return Deferred.await(gate)
          })
          const round = yield* fork(reconciler.round({ afterClockJump: false }))
          yield* reads(calls, 1)

          // Its Moved is handled now, not at the next round.
          expect(yield* reconciler.reconcileAfter("wf-moved")).toEqual({ _tag: "evict", reason: "not-owned" })
          expect(calls.evictMoved).toEqual(["wf-moved"])

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(round)
        }),
      ),
  )
})

describe("a round", () => {
  it.live("looks at the pending workflows first, then the running, paused and stepping ones, and skips the ended", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-stepping", { status: "stepping" })
        yield* workflow("wf-paused", { status: "paused" })
        yield* workflow("wf-running", { status: "running" })
        yield* workflow("wf-orphan", {
          status: "pending",
          ageMs: ReconcileDecide.ORPHAN_PENDING_GRACE_MS + 1_000,
          nodes: ["pending"],
        })
        yield* workflow("wf-failed", { status: "failed" })
        yield* workflow("wf-completed", { status: "completed" })

        yield* reconciler.round({ afterClockJump: false })

        // The orphan is disposed of before anything is adopted; the ended ones are not even looked at.
        expect(calls.claim).toEqual(["wf-orphan"])
        expect([...calls.adopt].sort()).toEqual(["wf-paused", "wf-running", "wf-stepping"])
        expect(calls.getWorkflow).toBe(4)
      }),
    ),
  )

  it.live("hands every workflow the verdict on the clock that it was given", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls } = yield* harness
        yield* workflow("wf-a")
        yield* workflow("wf-b")
        yield* heldByOther("wf-a", "expired")
        yield* heldByOther("wf-b", "expired")

        yield* reconciler.round({ afterClockJump: true })
        expect(calls.adopt).toEqual([])
        yield* reconciler.round({ afterClockJump: false })
        expect([...calls.adopt].sort()).toEqual(["wf-a", "wf-b"])
      }),
    ),
  )

  it.live("goes on with the other workflows when one of them fails, and says so", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-1")
        yield* workflow("wf-2")
        let first = true
        script.adopt = Effect.suspend(() => {
          if (!first) return Effect.void
          first = false
          return Effect.die(new Error("recovery failed"))
        })

        yield* reconciler.round({ afterClockJump: false })

        expect(calls.adopt).toHaveLength(2)
      }),
    ),
  )

  it.live("is interrupted when its fiber is, not swallowed as a failure of the workflow it is in", () =>
    scenario(
      Effect.gen(function* () {
        const { reconciler, calls, script } = yield* harness
        yield* workflow("wf-1")
        yield* workflow("wf-2")
        const gate = yield* Deferred.make<void>()
        script.adopt = Deferred.await(gate)

        const round = yield* reconciler
          .round({ afterClockJump: false })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* pollWithTimeout(
          Effect.sync(() => (calls.adopt.length > 0 ? true : undefined)),
          "the round never adopted",
        )
        yield* Fiber.interrupt(round)

        // It stopped at the workflow it was in: the second one was never looked at.
        expect(calls.adopt).toHaveLength(1)
        expect(calls.getWorkflow).toBe(1)
      }),
    ),
  )
})

describe("movedEvictor", () => {
  const evictor = (
    entries: Map<string, Entry>,
    aborted: Array<{ readonly nodeID: string; readonly childSessionID: string | null }>,
  ) =>
    Effect.gen(function* () {
      const real = yield* DagStore.Service
      return DagReconciler.movedEvictor({
        entries,
        store: real,
        abort: (_dagID, nodeID, childSessionID) => Effect.sync(() => void aborted.push({ nodeID, childSessionID })),
      })
    })

  it.live("aborts the children the node rows name, interrupts the fibers and watchers, and drops the entry", () =>
    scenario(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* workflow("wf-moved", { nodes: ["running", "running"] })
        yield* db
          .run(
            sql`UPDATE workflow_node SET child_session_id = 'ses_child_1' WHERE workflow_id = 'wf-moved' AND id = 'n1'`,
          )
          .pipe(Effect.orDie)
        const entries = new Map<string, Entry>()
        const entry = entryOf("moved", token(1))
        entries.set("wf-moved", entry)
        const interrupted: string[] = []
        const park = (name: string) =>
          Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(name))))
        const n1 = yield* Effect.forkChild(park("fiber n1"), { startImmediately: true })
        const n2 = yield* Effect.forkChild(park("fiber n2"), { startImmediately: true })
        const watcher = yield* Effect.forkChild(park("watcher n1"), { startImmediately: true })
        entry.fibers.set("n1", n1)
        entry.fibers.set("n2", n2)
        entry.watchers.set("n1", watcher)
        const aborted: Array<{ readonly nodeID: string; readonly childSessionID: string | null }> = []

        yield* (yield* evictor(entries, aborted))("wf-moved", entry)

        // The row's child, and none for a node that has not created one.
        expect(aborted).toEqual([
          { nodeID: "n1", childSessionID: "ses_child_1" },
          { nodeID: "n2", childSessionID: null },
        ])
        expect([...interrupted].sort()).toEqual(["fiber n1", "fiber n2", "watcher n1"])
        expect(entries.has("wf-moved")).toBe(false)
        expect(entry.fibers.size).toBe(0)
        expect(entry.watchers.size).toBe(0)
      }),
    ),
  )

  it.live("leaves an entry alone that another path dropped, or replaced, before it got the entry's lock", () =>
    scenario(
      Effect.gen(function* () {
        yield* workflow("wf-gone", { nodes: ["running"] })
        const entries = new Map<string, Entry>()
        const stale = entryOf("stale", token(1))
        const current = entryOf("current", token(2))
        const fiber = yield* Effect.forkChild(Effect.never, { startImmediately: true })
        stale.fibers.set("n1", fiber)
        entries.set("wf-gone", current)
        const aborted: Array<{ readonly nodeID: string; readonly childSessionID: string | null }> = []

        yield* (yield* evictor(entries, aborted))("wf-gone", stale)

        expect(aborted).toEqual([])
        expect(entries.get("wf-gone")).toBe(current)
        expect(stale.fibers.size).toBe(1)
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )
})
