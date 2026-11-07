// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices and seeded rows use `as never` shims.
import { describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { tmpdir } from "./fixture/tmpdir"

function storeLayer(filename: string) {
  const database = Database.layerFromPath(filename)
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

function seedBatch() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: "ses_parent" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowTable).values({
      id: "wf-1",
      project_id: "project-1" as never,
      session_id: "ses_parent" as never,
      title: "Batch",
      status: "completed",
      config: "{}",
      seq: 4,
      wake_reported: false,
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      {
        id: "a",
        workflow_id: "wf-1",
        name: "A",
        worker_type: "build",
        status: "completed",
        required: true,
        depends_on: [],
        output: "A",
        wake_eligible: true,
        wake_reported: false,
        seq: 2,
      },
      {
        id: "b",
        workflow_id: "wf-1",
        name: "B",
        worker_type: "build",
        status: "completed",
        required: true,
        depends_on: [],
        output: "B",
        wake_eligible: true,
        wake_reported: false,
        seq: 3,
      },
    ]).run().pipe(Effect.orDie)
  })
}

function acknowledgeBatch(store: DagStore.Interface) {
  return Effect.gen(function* () {
    const nodes = yield* store.getUnreportedWakeNodes("ses_parent")
    const workflows = yield* store.getUnreportedWakeWorkflows("ses_parent")
    yield* store.markWakeBatchReported({ nodes, workflows })
  })
}

describe("DagStore wake batch", () => {
  test("atomically marks every included node and workflow reported", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seedBatch()

        yield* acknowledgeBatch(store)

        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toEqual([])
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toEqual([])
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("keeps a timeout-extended node wake after escalation is cleared", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* DagStore.Service
        yield* database.db.insert(ProjectTable).values({
          id: "project-1" as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: "ses_parent" as never,
          project_id: "project-1" as never,
          slug: "parent",
          directory: process.cwd() as never,
          title: "Parent",
          version: "test",
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(WorkflowTable).values({
          id: "wf-1",
          project_id: "project-1" as never,
          session_id: "ses_parent" as never,
          title: "Timeout",
          status: "running",
          config: "{}",
          seq: 1,
          wake_reported: false,
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(WorkflowNodeTable).values({
          id: "timeout-node",
          workflow_id: "wf-1",
          name: "Timeout",
          worker_type: "build",
          status: "running",
          required: true,
          depends_on: [],
          wake_eligible: false,
          wake_reported: false,
          escalation_pending: false,
          timeout_extensions: 1,
          seq: 1,
        }).run().pipe(Effect.orDie)

        expect((yield* store.getUnreportedWakeNodes("ses_parent")).map((node) => node.id)).toEqual([
          "timeout-node",
        ])
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("rolls back the whole batch when one acknowledgement update fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* DagStore.Service
        yield* seedBatch()
        yield* database.db.run(sql`
          CREATE TRIGGER reject_workflow_wake
          BEFORE UPDATE OF wake_reported ON workflow
          WHEN NEW.id = 'wf-1' AND NEW.wake_reported = 1
          BEGIN
            SELECT RAISE(ABORT, 'forced acknowledgement failure');
          END
        `).pipe(Effect.orDie)

        expect(Exit.isFailure(yield* Effect.exit(acknowledgeBatch(store)))).toBe(true)
        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(2)
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("does not acknowledge a newer attempt that reused the same node ID", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* DagStore.Service
        yield* seedBatch()
        const batch = yield* store.getWakeSnapshot("ses_parent")
        const original = batch.nodes.find((node) => node.id === "a")!
        yield* database.db
          .update(WorkflowNodeTable)
          .set({ seq: original.seq + 10, output: "new attempt", wake_reported: false })
          .where(sql`${WorkflowNodeTable.workflow_id} = 'wf-1' AND ${WorkflowNodeTable.id} = 'a'`)
          .run()
          .pipe(Effect.orDie)

        yield* store.markWakeBatchReported({
          nodes: batch.nodes,
          workflows: batch.workflows.filter((workflow) => !workflow.wakeReported),
        })

        expect((yield* store.getUnreportedWakeNodes("ses_parent")).map((node) => node.output)).toEqual([
          "new attempt",
        ])
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("discovers the full unacknowledged batch after reopening the database", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "dag-wake.sqlite")
    await Effect.runPromise(
      seedBatch().pipe(
        Effect.provide(storeLayer(filename)),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(2)
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)
        expect(yield* store.getSessionsWithUnreportedWakes()).toEqual(["ses_parent"])
      }).pipe(
        Effect.provide(storeLayer(filename)),
        Effect.scoped,
      ),
    )
  })
})

function projectedStoreLayer() {
  const database = Database.layerFromPath(":memory:")
  const eventLayer = EventV2.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventLayer)))
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(database, eventLayer, projector, store)
}

const episodeDagID = DagEvent.DagID.make("dag_wake_episode")

/** Create, start, and pause a workflow, then acknowledge its paused reminder as the loop's wake does. */
const pauseAndAcknowledgeReminder = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* DagStore.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: "project-1" as never, worktree: process.cwd() as never, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: "ses_parent" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* events.publish(DagEvent.WorkflowCreated, {
    dagID: episodeDagID,
    projectID: "project-1" as never,
    sessionID: "ses_parent" as never,
    title: "wake",
    config: "{}",
    status: "pending",
    timestamp: yield* DateTime.now,
    directory: process.cwd(),
  } as never)
  yield* events.publish(DagEvent.WorkflowStarted, { dagID: episodeDagID, timestamp: yield* DateTime.now })
  yield* events.publish(DagEvent.WorkflowPaused, { dagID: episodeDagID, timestamp: yield* DateTime.now })
  const paused = (yield* store.getWorkflow(episodeDagID))!
  expect(paused.wakeReported).toBe(false)
  yield* store.markWakeBatchReported({ nodes: [], workflows: [paused] })
  expect((yield* store.getWorkflow(episodeDagID))!.wakeReported).toBe(true)
})

describe("workflow wake episodes", () => {
  test("resuming after a reported pause reminder starts a fresh wake episode", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pauseAndAcknowledgeReminder
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.publish(DagEvent.WorkflowResumed, { dagID: episodeDagID, timestamp: yield* DateTime.now })
        expect(yield* store.getWorkflow(episodeDagID)).toMatchObject({ status: "running", wakeReported: false })
      }).pipe(Effect.provide(projectedStoreLayer()), Effect.scoped),
    )
  })

  test("completion after a reported pause reminder is still reported to the parent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pauseAndAcknowledgeReminder
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.publish(DagEvent.WorkflowResumed, { dagID: episodeDagID, timestamp: yield* DateTime.now })
        yield* events.publish(DagEvent.WorkflowCompleted, {
          dagID: episodeDagID,
          durationMs: 0 as never,
          timestamp: yield* DateTime.now,
        })
        expect((yield* store.getWorkflow(episodeDagID))!.status).toBe("completed")
        expect((yield* store.getUnreportedWakeWorkflows("ses_parent")).map((w) => w.id)).toEqual([episodeDagID])
        expect(yield* store.getSessionsWithUnreportedWakes()).toEqual(["ses_parent"])
      }).pipe(Effect.provide(projectedStoreLayer()), Effect.scoped),
    )
  })

  test("cancelling a paused workflow after its reminder was reported still wakes the parent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pauseAndAcknowledgeReminder
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.publish(DagEvent.WorkflowCancelled, { dagID: episodeDagID, timestamp: yield* DateTime.now })
        expect((yield* store.getWorkflow(episodeDagID))!.status).toBe("cancelled")
        expect((yield* store.getUnreportedWakeWorkflows("ses_parent")).map((w) => w.id)).toEqual([episodeDagID])
      }).pipe(Effect.provide(projectedStoreLayer()), Effect.scoped),
    )
  })

  test("a repeated terminal event does not re-arm an acknowledged terminal wake", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pauseAndAcknowledgeReminder
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.publish(DagEvent.WorkflowCancelled, { dagID: episodeDagID, timestamp: yield* DateTime.now })
        yield* store.markWakeBatchReported({ nodes: [], workflows: yield* store.getUnreportedWakeWorkflows("ses_parent") })
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toEqual([])

        yield* events.publish(DagEvent.WorkflowCancelled, { dagID: episodeDagID, timestamp: yield* DateTime.now })
        yield* events.publish(DagEvent.WorkflowFailed, {
          dagID: episodeDagID,
          reason: "late",
          failedNodes: [] as never,
          timestamp: yield* DateTime.now,
        })
        expect(yield* store.getWorkflow(episodeDagID)).toMatchObject({ status: "cancelled", wakeReported: true })
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toEqual([])
      }).pipe(Effect.provide(projectedStoreLayer()), Effect.scoped),
    )
  })
})
