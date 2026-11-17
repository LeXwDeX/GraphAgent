// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the InstanceRef shim is a partial instance context, as in dag-workspace-missing.test.ts.
/**
 * Issue #1029, PR4b (ADR-0008 decision 7): the host sweep no longer takes every
 * row it can read for its own. `failUnusableWorkspaces` fails a workflow whose
 * execution location is unusable only when no live lease names a holder; a live
 * lease, held by another runner or by this one, is left to the holder's own
 * reconcile round. The node-timeout half of the sweep reads no lease and is
 * covered by `dag-node-supervision.test.ts`.
 *
 * Every case drives the real Dag and projector over one in-memory database, with
 * the lease rows written by the real `DagLease` at explicit times. The clock is a
 * TestClock set to `START` and never advanced: a lease is live, run out, or at
 * the boundary by the `now` it was claimed at.
 */
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagRunnerTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag } from "@/dag/dag"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess, ExclusiveRegistry } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { mockSessionPrompt } from "../lib/child-runs"
import { it } from "../lib/effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PROJECT = "project-1"
const SESSION = "ses_parent"
const START = 1_000_000
const TTL = DagLease.TTL_MS
const OTHER = "11:other"
const ME = EngineProcess.runner.id

/** What the sweep is given for `DagLease`: the real service, none (it then reads the table of its own database), or a scripted one. */
type SweepLeases = "provided" | "absent" | Layer.Layer<DagLease.Service>

const harness = (sweepLeases: SweepLeases) => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const leases = DagLease.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const given = sweepLeases === "provided" ? leases : sweepLeases === "absent" ? Layer.empty : sweepLeases
  const sweep = DagSupervisionSweep.layerWithoutDeps.pipe(
    Layer.provide(Layer.mergeAll(base, given)),
    Layer.provide(mockSessionPrompt({ cancel: () => Effect.void })),
    Layer.provideMerge(ExclusiveRegistry.defaultLayer),
  )
  // The test body always gets the real service over the same database, to write the lease rows with.
  return Layer.mergeAll(base, leases, sweep)
}

interface Services {
  readonly dagID: string
  readonly database: Database.Interface
  readonly store: DagStore.Interface
  readonly leases: DagLease.Interface
  readonly sweep: DagSupervisionSweep.Interface
}

/**
 * One workflow whose execution location is unusable (an owner-less row, #948),
 * so that the sweep would fail it without the lease rule.
 */
const seed = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const dag = yield* Dag.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make(PROJECT), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(SESSION),
        project_id: Project.ID.make(PROJECT),
        slug: "p",
        directory,
        title: "P",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const dagID = yield* dag.create({
      projectID: PROJECT,
      sessionID: SESSION,
      title: "lease",
      config: {
        name: "lease",
        nodes: [
          {
            id: "n1",
            name: "n1",
            worker_type: "build",
            depends_on: [],
            required: true,
            prompt_template: { inline: "x" },
          },
        ],
      },
    })
    yield* db.update(WorkflowTable).set({ directory: "" }).where(eq(WorkflowTable.id, dagID)).run().pipe(Effect.orDie)
    return dagID
  })

const scenario = <A, E>(sweepLeases: SweepLeases, test: (services: Services) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    // Set before the layer is built: the sweep's own 60 s timer starts at START and is never reached, so every pass is the test's.
    yield* TestClock.setTime(START)
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => realpathSync(mkdtempSync(path.join(tmpdir(), "dag-sweep-lease-")))),
      (created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
    )
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* DagStore.Service
      const leases = yield* DagLease.Service
      const sweep = yield* DagSupervisionSweep.Service
      const dagID = yield* seed(directory)
      return yield* test({ dagID, database, store, leases, sweep })
    }).pipe(
      Effect.provide(harness(sweepLeases)),
      Effect.provideService(InstanceRef, {
        directory,
        worktree: directory,
        project: { id: PROJECT },
      } as never),
    )
  })

/** What a pass of the sweep may change: the workflow's status, the failures published for it, and (never) the lease rows. */
const snapshot = ({ database, store, dagID }: Services) =>
  Effect.gen(function* () {
    const workflow = yield* store.getWorkflow(dagID)
    const events = yield* database.db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, dagID))
      .all()
      .pipe(Effect.orDie)
    return {
      status: workflow?.status,
      failures: events.filter((row) => row.type.startsWith("dag.workflow.failed")).length,
      leaseRows: yield* database.db.select().from(DagRunnerTable).all().pipe(Effect.orDie),
    }
  })

/** The lease of `dagID` as `runnerID` took it at `now`. */
const claimed = (services: Services, runnerID: string, now: number) =>
  Effect.gen(function* () {
    const { leases, dagID } = services
    const lease = yield* leases.claim({ dagID, runnerID, now })
    if (lease === undefined) return yield* Effect.die(new Error(`the claim of ${dagID} by ${runnerID} was refused`))
    expect(lease).toMatchObject({ dagID, runnerID, epoch: 1, expiresAt: now + TTL })
    return lease
  })

/** Two passes leave the workflow, the failures published for it and every lease row as they were. */
const leftAlone = (services: Services) =>
  Effect.gen(function* () {
    const before = yield* snapshot(services)
    expect(before.status).not.toBe("failed")
    yield* services.sweep.sweepOnce()
    yield* services.sweep.sweepOnce()
    expect(yield* snapshot(services)).toEqual(before)
  })

/** One pass fails the workflow (one failure published, not two) and writes no lease row; a second pass adds nothing. */
const failed = (services: Services) =>
  Effect.gen(function* () {
    const before = yield* snapshot(services)
    yield* services.sweep.sweepOnce()
    const after = yield* snapshot(services)
    expect(after).toEqual({ ...before, status: "failed", failures: 1 })
    yield* services.sweep.sweepOnce()
    expect(yield* snapshot(services)).toEqual(after)
  })

/** The holder gives the lease back (a clean exit, a moment before the pass): no live lease is left, and the sweep fails the same row. */
const failedOnceReleased = (services: Services, lease: DagLease.Lease) =>
  Effect.gen(function* () {
    const released = yield* services.leases.release({ dagID: services.dagID, token: lease, now: START - 1 })
    expect(released).toBe(true)
    yield* failed(services)
  })

describe("DagSupervisionSweep: workspace failure only for a workflow with no live lease (ADR-0008 decision 7)", () => {
  it.effect("leaves a workflow with an unusable location to another runner that holds a live lease", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        const lease = yield* claimed(services, OTHER, START)
        yield* leftAlone(services)
        // Not a vacuous pass: once the holder gives the lease back, the same row is failed.
        yield* failedOnceReleased(services, lease)
      }),
    ),
  )

  it.effect("leaves it to this runner's own live lease as well", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        const lease = yield* claimed(services, ME, START)
        yield* leftAlone(services)
        yield* failedOnceReleased(services, lease)
      }),
    ),
  )

  it.effect("fails the workflow when the lease has run out", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        // Claimed two TTLs ago by a runner that never renewed it: it ran out one TTL ago.
        yield* claimed(services, OTHER, START - 2 * TTL)
        yield* failed(services)
      }),
    ),
  )

  it.effect("fails the workflow when no lease row names a holder", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        expect((yield* snapshot(services)).leaseRows).toEqual([])
        yield* failed(services)
      }),
    ),
  )

  it.effect("counts a lease that runs out exactly now as run out", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        // expires_at == START: the boundary at which `DagLease.claim` would let another runner take it over.
        const lease = yield* claimed(services, OTHER, START - TTL)
        expect(lease.expiresAt).toBe(START)
        yield* failed(services)
      }),
    ),
  )

  it.effect("keeps a lease that runs out one millisecond from now", () =>
    scenario("provided", (services) =>
      Effect.gen(function* () {
        const lease = yield* claimed(services, OTHER, START - TTL + 1)
        expect(lease.expiresAt).toBe(START + 1)
        yield* leftAlone(services)
      }),
    ),
  )

  it.effect("reads the lease table of its own database when the graph gives it no DagLease", () =>
    scenario("absent", (services) =>
      Effect.gen(function* () {
        const lease = yield* claimed(services, OTHER, START)
        yield* leftAlone(services)
        yield* failedOnceReleased(services, lease)
      }),
    ),
  )

  it.effect("leaves the workflow for the next tick when the lease cannot be read", () =>
    scenario(
      Layer.mock(DagLease.Service, {
        // A database failure is a defect, never an `undefined`: it must not be taken for "no lease".
        held: () => Effect.die(new Error("SQLITE_BUSY: database is locked")),
      }),
      // The pass itself survives the failure, and leaves the workflow alone.
      leftAlone,
    ),
  )
})
