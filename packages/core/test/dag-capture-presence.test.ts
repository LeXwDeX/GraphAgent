import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath, NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { tmpdir } from "./fixture/tmpdir"

function captureLayer(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  return Layer.mergeAll(database, events, store, projector)
}

function seed() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(process.cwd()),
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowTable)
      .values({
        id: "dag_capture",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Capture presence",
        status: "running",
        config: "{}",
        seq: 0,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        id: "node",
        workflow_id: "dag_capture",
        name: "Node",
        worker_type: "build",
        status: "running",
        required: true,
        depends_on: [],
        seq: 0,
        child_session_id: "ses_old",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("DAG null capture presence (#697)", () => {
  test("distinguishes absent capture from submitted null across database reopen", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "capture.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const store = yield* DagStore.Service
        const absent = yield* store.getNode("dag_capture", "node")
        expect(absent?.capturedOutput).toBeNull()
        expect(absent?.capturedOutputPresent).toBe(false)
        yield* store.setCapturedOutput("ses_old", null, "snapshot-null")
        expect(yield* store.getNode("dag_capture", "node")).toEqual(
          expect.objectContaining({
            capturedOutput: null,
            capturedOutputPresent: true,
            capturedSnapshotID: "snapshot-null",
          }),
        )
      }).pipe(Effect.provide(captureLayer(filename)), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        expect(yield* store.getNode("dag_capture", "node")).toEqual(
          expect.objectContaining({
            capturedOutput: null,
            capturedOutputPresent: true,
            capturedSnapshotID: "snapshot-null",
          }),
        )
      }).pipe(Effect.provide(captureLayer(filename)), Effect.scoped),
    )
  })

  test("starts a replacement attempt without old capture and ignores the old child's late capture", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const store = yield* DagStore.Service
        const events = yield* EventV2.Service
        yield* store.setCapturedOutput("ses_old", null, "snapshot-old")
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID: DagEvent.DagID.make("dag_capture"),
          nodeID: DagEvent.NodeID.make("node"),
          childSessionID: SessionSchema.ID.make("ses_old"),
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID: DagEvent.DagID.make("dag_capture"),
          nodeID: DagEvent.NodeID.make("node"),
          childSessionID: SessionSchema.ID.make("ses_new"),
          timestamp: yield* DateTime.now,
        })
        expect(yield* store.getNode("dag_capture", "node")).toEqual(
          expect.objectContaining({
            childSessionId: "ses_new",
            capturedOutput: null,
            capturedOutputPresent: false,
            capturedSnapshotID: null,
          }),
        )
        yield* store.setCapturedOutput("ses_old", "late old result", "snapshot-old")
        expect((yield* store.getNode("dag_capture", "node"))?.capturedOutputPresent).toBe(false)
        yield* store.setCapturedOutput("ses_new", null, "snapshot-new")
        expect(yield* store.getNode("dag_capture", "node")).toEqual(
          expect.objectContaining({
            capturedOutput: null,
            capturedOutputPresent: true,
            capturedSnapshotID: "snapshot-new",
          }),
        )
      }).pipe(Effect.provide(captureLayer(":memory:")), Effect.scoped),
    )
  })

  test("replays a completed null submission with presence independently of the original direct capture write", async () => {
    const serialized = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const store = yield* DagStore.Service
        const events = yield* EventV2.Service
        yield* store.setCapturedOutput("ses_old", null, "snapshot-original")
        const event = yield* events.publish(DagEvent.NodeCompleted, {
          dagID: DagEvent.DagID.make("dag_capture"),
          nodeID: DagEvent.NodeID.make("node"),
          output: null,
          capturedOutput: null,
          durationMs: NonNegativeInt.make(0),
          timestamp: yield* DateTime.now,
        })
        expect(yield* store.getNode("dag_capture", "node")).toEqual(
          expect.objectContaining({
            status: "completed",
            output: null,
            capturedOutput: null,
            capturedOutputPresent: true,
          }),
        )
        return [
          {
            id: event.id,
            type: EventV2.versionedType(event.type, event.durable!.version),
            seq: event.durable!.seq,
            aggregateID: event.durable!.aggregateID,
            data: Schema.encodeUnknownSync(DagEvent.NodeCompleted.data)(event.data),
          },
        ]
      }).pipe(Effect.provide(captureLayer(":memory:")), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.replayAll(serialized)
        const restored = yield* store.getNode("dag_capture", "node")
        expect(restored).toEqual(
          expect.objectContaining({
            status: "completed",
            output: null,
            capturedOutput: null,
            capturedOutputPresent: true,
          }),
        )
        yield* events.replayAll(serialized)
        expect(yield* store.getNode("dag_capture", "node")).toEqual(restored)
      }).pipe(Effect.provide(captureLayer(":memory:")), Effect.scoped),
    )
  })
})
