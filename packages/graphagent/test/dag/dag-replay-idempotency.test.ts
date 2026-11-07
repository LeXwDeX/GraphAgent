import { describe, expect, it } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent, DagID } from "@opencode-ai/schema/dag-event"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"

const projectorLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: "ses_replay" as never, project_id: Project.ID.global, slug: "replay", directory: "/project", title: "replay", version: "test" }).run().pipe(Effect.orDie)
  })
}

function serializeAndWipe(dagID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID}`)
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    const serialized = rows.map((r) => ({
      id: r.id as EventV2.ID,
      type: r.type,
      seq: r.seq,
      aggregateID: r.aggregate_id,
      data: r.data as Record<string, unknown>,
    }))
    yield* db.delete(EventTable).where(sql`${EventTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.delete(EventSequenceTable).where(sql`${EventSequenceTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`).pipe(Effect.orDie)
    return serialized
  })
}

function snapshotState(dagID: string, nodeIDs: string[]) {
  return Effect.gen(function* () {
    const store = yield* DagStore.Service
    const wf = yield* store.getWorkflow(dagID)
    const nodes = yield* Effect.forEach(nodeIDs, (id) => store.getNode(dagID, id))
    return {
      workflowStatus: wf?.status,
      nodes: nodes.map((n) => ({
        id: n?.id,
        status: n?.status,
        output: n?.output ?? null,
        capturedOutput: n?.capturedOutput ?? null,
        replanAttempts: n?.replanAttempts ?? 0,
        childSessionId: n?.childSessionId ?? null,
      })),
    }
  })
}

describe("DagProjector: replay idempotency", () => {
  it("normal completion flow produces identical read-model on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_complete" as never
        const receipt = { type: "file", path: "/managed/report.md", managed: true, sha256: "a".repeat(64), byte_size: 4, workflow_id: dagID, node_id: "a", child_session_id: "ses_child", replan_attempt: 0 }

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "replay-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_child" as never, timestamp: ts(3) })
        const rejected = yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: "a" as never, output: "done", capturedOutput: receipt, durationMs: 0, timestamp: ts(4) }, { commit: () => Effect.die("injected completion failure") }).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        const afterFailure = yield* snapshotState(dagID, ["a"])
        expect(afterFailure.nodes[0]?.status).toBe("running")
        expect(afterFailure.nodes[0]?.capturedOutput).toBeNull()
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: "a" as never, output: "done", capturedOutput: receipt, durationMs: 0, timestamp: ts(4) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.workflowStatus).toBe("completed")
        expect(replayed.nodes[0]?.status).toBe("completed")
        expect(replayed.nodes[0]?.output).toBe("done")
        expect(replayed.nodes[0]?.capturedOutput).toEqual(receipt)
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("cancellation flow produces identical read-model on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_cancel" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "cancel-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_child" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.WorkflowCancelled, { dagID, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeSkipped, { dagID, nodeID: "a" as never, reason: "workflow_cancelled", timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.workflowStatus).toBe("cancelled")
        expect(replayed.nodes[0]?.status).toBe("skipped")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("stale NodeStarted after NodeCancelled is rejected on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_stale" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "stale-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeCancelled, { dagID, nodeID: "a" as never, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_B" as never, timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.nodes[0]?.status).toBe("failed")
        expect(replayed.nodes[0]?.childSessionId).toBe("ses_A")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("replan restart preserves replan_attempts on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_restart" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "restart-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeRestarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_B" as never, timestamp: ts(5) })
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: "a" as never, output: "restarted-done", durationMs: 0, timestamp: ts(6) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(7) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.nodes[0]?.status).toBe("completed")
        expect(replayed.nodes[0]?.replanAttempts).toBe(1)
        expect(replayed.nodes[0]?.output).toBe("restarted-done")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("re-materializing a dag aggregate without its session row dies on the workflow FK (#524 zombie shape)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const sessionID = SessionID.make("ses_doomed")

        yield* db
          .insert(SessionTable)
          .values({ id: sessionID, project_id: Project.ID.global, slug: "doomed", directory: "/project", title: "doomed", version: "test" })
          .run()
          .pipe(Effect.orDie)
        const dagID = DagID.make("dag_replay_zombie")
        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: ProjectID.global, sessionID, title: "zombie-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(1) })

        const serialized = yield* serializeAndWipe(dagID)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

        // Crash/in-flight zombie shape (#524): the aggregate's session row is
        // gone, so the WorkflowCreated read-model INSERT dies on the
        // workflow.session_id FK — a wiped dag aggregate whose session was
        // removed can never be re-materialized. This is why Session.remove
        // scrubs the dag event aggregates instead of relying on replay.
        const exit = yield* events.replayAll(serialized).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("FOREIGN KEY constraint failed")

        // The FK death aborts the replay transaction — no partial-commit garbage.
        const residue = yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, dagID))
          .all()
          .pipe(Effect.orDie)
        expect(residue).toEqual([])
      }).pipe(Effect.provide(projectorLayer)),
    )
  })
})
