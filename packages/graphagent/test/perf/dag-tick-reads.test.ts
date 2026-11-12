// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the H0 probe narrows instance and service stubs with `as never` shims while measuring the real store's reads.

import { expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { AgentMailboxTable, AgentMessageTable } from "@graphagent/core/dag/messages.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagDelivery, PAUSED_REMINDER_DELAY_MS } from "@/dag/runtime/delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { countingDatabaseLayer, reset, settle, snapshot } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"

// H0 read budget for the DAG inbox tick (Issue #1021). `scanSessions` is the
// periodic store scan behind `dag.delivery`; every other trigger is event
// driven. The tick reads the wake ledger once (the UNION), the paused
// workflow ledger once, and the mailbox ledger once, and pays at most one
// ownership read per returned wake or due paused session. Due paused
// reminders are part of this tick (#1027 D5): the inbox 30s timer is now
// their only periodic driver. The mailbox read is one page of at most 64
// recipients whose cursor rotates across ticks, so a deep backlog never adds
// reads to a tick. The probe counts the production SQL client, so these
// numbers are the queries the store actually issues, not an assumed shape.
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

/** `count` parent sessions in this directory, each with an open main mailbox
 * holding one queued message, in ledger (session-ID) order. */
function seedQueuedMailboxes(count: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const ids = Array.from({ length: count }, (_, index) => `ses_tick_mail_${String(index).padStart(3, "0")}`)
    yield* db
      .insert(SessionTable)
      .values(
        ids.map((id) => ({
          id: SessionID.make(id),
          project_id: Project.ID.make(PROJECT_ID),
          slug: id,
          directory: AbsolutePath.make(DIRECTORY),
          title: id,
          version: "test",
        })),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(AgentMailboxTable)
      .values(
        ids.map((id) => ({
          id: `mailbox_${id}`,
          session_id: id,
          workflow_id: null,
          node_id: null,
          attempt_id: null,
          revision: 1,
          result_nudge_revision: -1,
          closed_reason: null,
          time_created: 1,
        })),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(AgentMessageTable)
      .values(
        ids.map((id) => ({
          id: `message_${id}`,
          workflow_id: "dag_tick_mail",
          sender_id: "child",
          recipient_id: `mailbox_${id}`,
          recipient_session_id: id,
          sender: {},
          recipient: {},
          idempotency_key: `key_${id}`,
          request: "request",
          content: "queued",
          recipient_sequence: 1,
          accepted_revision: 1,
          state: "queued",
          transcript_id: `msg_${id}`,
          part_id: `prt_${id}`,
          time_created: 1,
        })),
      )
      .run()
      .pipe(Effect.orDie)
    return ids
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

/** A paused workflow whose reminder is already due. The tick owns the
 * reminder now, so it must read the paused ledger, see this row as due, pay
 * one ownership read, and return the session. TestClock starts at 0, so the
 * row's `time_updated` must be further back than the reminder delay. */
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
        time_updated: -(PAUSED_REMINDER_DELAY_MS + 1),
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/** Build the delivery instance inside its own scope and close it immediately.
 * Construction runs the one-off startup scan (mailbox sweep + paused
 * reminders) and subscribes to the mailbox change stream for the scope's
 * lifetime; the scope ends right away, and `settle()` + `reset()` drop those
 * construction reads. Only the explicit `scanSessions` call below is
 * measured. */
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

it.effect("the DAG tick reads the wake, paused, and mailbox ledgers and writes nothing", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure()
    expect(sessions).toEqual([])
    // Wake UNION (1) + paused workflows (1) + mailbox recipients (1).
    expect(counts["sql.read"]).toBe(3)
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
    // Wake UNION (1) + DagLocation.ownsSession (1) + paused workflows (1) +
    // mailbox recipients (1).
    expect(counts["sql.read"]).toBe(4)
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
    // Wake UNION (1) + ownsSession (1) + paused workflows (1) + mailbox (1).
    expect(counts["sql.read"]).toBe(4)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)

it.effect("a due paused reminder is returned by the tick and pays one ownership read", () =>
  Effect.gen(function* () {
    const { sessions, counts } = yield* measure(seedPausedWorkflow())
    expect(sessions).toEqual([SESSION_ID])
    // Wake UNION (1) + paused workflows (1) + ownsSession (1) + mailbox (1).
    expect(counts["sql.read"]).toBe(4)
    expect(counts["sql.write"]).toBe(0)
    expect(counts.commits).toBe(READ_TRANSACTION_COMMITS) // read-only txn control, no rows written
  }),
)

it.effect("a deep mailbox backlog still costs one page read per tick, and the cursor wraps over every recipient", () =>
  Effect.gen(function* () {
    yield* seedProjectAndSession
    const delivery = yield* Effect.scoped(deliveryEffect)
    // Two full ledger pages (the cap is 64 per read) and a short one, seeded
    // after construction so the start-up sweep cannot react to them.
    const ids = yield* seedQueuedMailboxes(2 * 64 + 2)
    yield* settle()
    const ticks: Array<{ sessions: ReadonlyArray<string>; reads: number; writes: number; commits: number }> = []
    for (let tick = 0; tick < 4; tick++) {
      reset()
      const sessions = yield* delivery.scanSessions()
      const counts = snapshot()
      ticks.push({ sessions, reads: counts["sql.read"], writes: counts["sql.write"], commits: counts.commits })
    }
    // Page 1, page 2, the short last page, then the wrap back to page 1.
    expect(ticks.map((tick) => tick.sessions)).toEqual([
      ids.slice(0, 64),
      ids.slice(64, 128),
      ids.slice(128),
      ids.slice(0, 64),
    ])
    // Wake UNION (1) + paused workflows (1) + one mailbox page (1), however deep the backlog is.
    expect(ticks.map((tick) => tick.reads)).toEqual([3, 3, 3, 3])
    expect(ticks.map((tick) => tick.writes)).toEqual([0, 0, 0, 0])
    expect(ticks.map((tick) => tick.commits)).toEqual(ticks.map(() => READ_TRANSACTION_COMMITS))
  }).pipe(Effect.provideService(InstanceRef, instanceRef)),
)
