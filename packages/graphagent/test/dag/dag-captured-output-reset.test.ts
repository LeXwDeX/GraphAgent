import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const dagID = "dag_test" as never
const nodeID = "node-1" as never
const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: "ses_test" as never, project_id: Project.ID.global, slug: "test", directory: "/project", title: "test", version: "test" }).run().pipe(Effect.orDie)
  })
}

function createWorkflowAndNode() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_test" as never, title: "test", config: "", status: "pending", timestamp: ts(0) })
    yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID, name: "Test", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
  })
}

describe("DagProjector: captured_output reset on NodeStarted", () => {
  it("resets captured_output to null on NodeStarted after replan-restart (no-resubmit → verdict_fail safe)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // Run #1: start node with child session A, agent submits P1
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(2) })
        yield* store.setCapturedOutput("ses_A", { value: "P1" })
        expect((yield* store.getNode(dagID, "node-1"))?.capturedOutput).toEqual({ value: "P1" })

        // Replan restart: NodeRestarted → NodeStarted (child session B)
        yield* events.publish(DagEvent.NodeRestarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_B" as never, timestamp: ts(4) })

        // THE FIX: captured_output must be null — stale P1 must not survive the restart.
        // Without the fix, this would still be { value: "P1" }, defeating verdict_fail.
        expect((yield* store.getNode(dagID, "node-1"))?.capturedOutput).toBeNull()
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<never>,
    )
  })

  it("new submit_result after restart stores the new payload, not the stale one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // Run #1: start + submit P1
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(2) })
        yield* store.setCapturedOutput("ses_A", { value: "P1" })

        // Replan restart
        yield* events.publish(DagEvent.NodeRestarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_B" as never, timestamp: ts(4) })

        // Run #2: agent calls submit_result with P2
        yield* store.setCapturedOutput("ses_B", { value: "P2" })
        const node = yield* store.getNode(dagID, "node-1")
        expect(node?.capturedOutput).toEqual({ value: "P2" })
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<never>,
    )
  })
})
