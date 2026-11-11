// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the H0 probe narrows instance and service stubs with `as never` shims while measuring the real store's reads.

import { expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagDelivery } from "@/dag/runtime/delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { countingDatabaseLayer, reset, settle, snapshot } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"

// H0 read budget for the DAG inbox tick (Issue #1021). `scanSessions` is the
// periodic store scan behind `dag.delivery`; every other trigger is event
// driven. The tick must read the wake ledger once (the UNION), pay at most one
// ownership read per returned wake session, and read the mailbox ledger once.
// Paused reminders belong to the dedicated 30s sweep and must not leak into
// this budget. The probe counts the production SQL client, so these numbers
// are the queries the store actually issues, not an assumed shape.
//
// Metric scope: `sql.read` verifies the tick's read budget; `sql.write === 0`
// is the hard no-write invariant; `commits === 1` merely reflects the
// read-only transaction control (BEGIN/COMMIT) issued by
// `DagMessages.pendingRecipients` through `db.transaction` — it changes no row.
const DIRECTORY = "/work/dag-tick-reads"
const OTHER_DIRECTORY = "/work/other-worktree"
const PROJECT_ID = "project-dag-tick-reads"
const SESSION_ID = "ses_dag_tick_reads"
const WAKE_SESSION_ID = "ses_dag_tick_wake"

// Measured, not budgeted: one read-only transaction control sequence per tick.
const READ_TRANSACTION_COMMITS = 1

const databaseLayer = countingDatabaseLayer
const storeLayer = DagStore.layer.pipe(Layer.provide(databaseLayer))
const messagesLayer = DagMessages.layer.pipe(Layer.provide(databaseLayer))
const layer = Layer.mergeAll(databaseLayer, storeLayer, messagesLayer)
const it = testEffect(layer)

const instanceRef = {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  project: { id: PROJECT_ID },
} as never

const seedProjectAndSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.make(PROJECT_ID), worktree: AbsolutePath.make(DIRECTORY), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(SESSION_ID),
      project_id: Project.ID.make(PROJECT_ID),
      slug: "tick",
      directory: AbsolutePath.make(DIRECTORY),
      title: "Tick",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

function seedSession(input: { id: string; directory: string }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(input.id),
        project_id: Project.ID.make(PROJECT_ID),
        slug: input.id,
        directory: AbsolutePath.make(input.directory),
        title: input.id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/** A live workflow with one unreported, wake-eligible node: the wake ledger
 * returns its session, and ownership decides whether this instance keeps it. */
function seedWake(input: { sessionID: string; workflowID: string; directory: string }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* seedSession({ id: input.sessionID, directory: input.directory })
    yield* db
      .insert(WorkflowTable)
      .values({
        id: input.workflowID,
        project_id: Project.ID.make(PROJECT_ID),
        session_id: input.sessionID,
        directory: AbsolutePath.make(input.directory),
        target_fingerprint: { kind: "none" },
        title: input.workflowID,
        status: "running",
        seq: 1,
        config: "{}",
        wake_reported: false,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        id: `${input.workflowID}_node`,
        workflow_id: input.workflowID,
        name: "Node",
        worker_type: "build",
        status: "completed",
        output: "done",
        depends_on: [],
        required: true,
        seq: 1,
        wake_eligible: true,
        wake_reported: false,
        completed_at: 1_000,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/** A paused workflow whose reminder is due. The 30s sweep owns it, so the tick
 * must not return its session. */
function seedPausedWorkflow() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowTable)
      .values({
        id: "dag_tick_paused",
        project_id: Project.ID.make(PROJECT_ID),
        session_id: SESSION_ID,
        directory: AbsolutePath.make(DIRECTORY),
        target_fingerprint: { kind: "none" },
        title: "Paused",
        status: "paused",
        seq: 1,
        config: "{}",
        wake_reported: false,
        time_updated: 0,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/** Build the delivery instance inside its own scope and close it immediately:
 * the 250ms mailbox poll and the 30s paused sweep are transitional fallbacks
 * whose fibers stop with that scope. Only the explicit `scanSessions` call
 * below is measured. */
const deliveryEffect = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  return yield* DagDelivery.make({
    directory: DIRECTORY,
    projectID: PROJECT_ID,
    scope,
    store: yield* DagStore.Service,
    messages: yield* DagMessages.Service,
    database: yield* Database.Service,
    // The tick only reads the two ledgers; delivery paths are unreachable
    // here (no inbox, no idle trigger), so their services stay unused.
    dag: undefined as never,
    sessions: undefined as never,
    prompts: undefined as never,
    status: undefined as never,
    automation: undefined as never,
    events: undefined as never,
    inbox: undefined,
    entries: () => undefined,
    lastAssistantMessage: () => Effect.succeed(undefined),
  })
})

const measure = (seed: Effect.Effect<void, never, Database.Service> = Effect.void) =>
  Effect.gen(function* () {
    yield* seedProjectAndSession
    const delivery = yield* Effect.scoped(deliveryEffect)
    // Seed after construction so the start-up scan cannot react to the rows;
    // only the measured `scanSessions` call sees them.
    yield* seed
    yield* settle()
    reset()
    const sessions = yield* delivery.scanSessions()
    return { sessions, counts: snapshot() }
  }).pipe(Effect.provideService(InstanceRef, instanceRef))

it.effect("the DAG tick reads the two ledgers and writes nothing", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure()
    expect(sessions).toEqual([])
    // Wake UNION (1) + mailbox recipients (1).
    expect(counts["sql.read"]).toBe(2)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)

it.effect("an unreported in-directory wake adds one ownership read and is returned", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure(
      seedWake({ sessionID: WAKE_SESSION_ID, workflowID: "dag_tick_wake", directory: DIRECTORY }),
    )
    expect(sessions).toEqual([WAKE_SESSION_ID])
    // Wake UNION (1) + DagLocation.ownsSession (1) + mailbox recipients (1).
    expect(counts["sql.read"]).toBe(3)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)

it.effect("a wake owned by another directory is read but not returned", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure(
      seedWake({ sessionID: WAKE_SESSION_ID, workflowID: "dag_tick_wake", directory: OTHER_DIRECTORY }),
    )
    expect(sessions).toEqual([])
    expect(counts["sql.read"]).toBe(3)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)

it.effect("a paused session stays out of the tick", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure(seedPausedWorkflow())
    expect(sessions).toEqual([])
    // The paused row matches neither wake arm; the sweep owns the reminder.
    expect(counts["sql.read"]).toBe(2)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)
