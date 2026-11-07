import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import { SessionID } from "@graphagent/schema/session-id"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TerminalViolationError, type NodeStatus } from "@graphagent/core/dag/core/types"

// Projector-only layer (for tests that publish events directly)
const projectorLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const dagID = "dag_guard" as never
const nodeID = "node-guard" as never
const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: "ses_guard" as never, project_id: Project.ID.global, slug: "guard", directory: "/project", title: "guard", version: "test" }).run().pipe(Effect.orDie)
  })
}

function createWorkflowAndNode() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_guard" as never, title: "guard", config: "", status: "pending", timestamp: ts(0) })
    yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID, name: "Guard", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
  })
}

describe("DagProjector: NodeStarted status guard", () => {
  it("does NOT resurrect a failed node (concurrent replan-cancel during spawn window)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // Start the node (pending → running)
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(2) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("running")

        // Concurrent replan(cancel) terminalizes the node (running → failed via NodeCancelled)
        yield* events.publish(DagEvent.NodeCancelled, { dagID, nodeID, timestamp: ts(3) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("failed")

        // The stale/racing NodeStarted (spawn fiber resuming after cancel) MUST NOT resurrect it
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_B" as never, timestamp: ts(4) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("failed")
        expect((yield* store.getNode(dagID, nodeID))?.childSessionId).toBe("ses_A")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("keeps matching node IDs isolated between workflows", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const otherDagID = "dag_guard_other" as never

        yield* events.publish(DagEvent.WorkflowCreated, {
          dagID: otherDagID,
          projectID: Project.ID.global as never,
          sessionID: "ses_guard" as never,
          title: "other guard",
          config: "",
          status: "pending",
          timestamp: ts(2),
        })
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: otherDagID,
          nodeID,
          name: "Other Guard",
          workerType: "review",
          dependsOn: [],
          required: true,
          timestamp: ts(3),
        })

        expect((yield* store.getNode(dagID, nodeID))?.name).toBe("Guard")
        expect((yield* store.getNode(otherDagID, nodeID))?.name).toBe("Other Guard")

        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(4) })

        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("running")
        expect((yield* store.getNode(otherDagID, nodeID))?.status).toBe("pending")
        const summaries = (yield* store.getWorkflowSummaries("ses_guard")).slice().sort((a, b) => a.id.localeCompare(b.id))
        expect(summaries).toEqual([
          {
            id: dagID,
            title: "guard",
            status: "pending",
            graphRev: 1,
            nodeCount: 1,
            completedNodes: 0,
            runningNodes: 1,
            failedNodes: 0,
            skippedNodes: 0,
            abortedNodes: 0,
            queuedNodes: 0,
            escalatedNodes: 0,
          },
          {
            id: otherDagID,
            title: "other guard",
            status: "pending",
            graphRev: 1,
            nodeCount: 1,
            completedNodes: 0,
            runningNodes: 0,
            failedNodes: 0,
            skippedNodes: 0,
            abortedNodes: 0,
            queuedNodes: 0,
            escalatedNodes: 0,
          },
        ])
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("restart re-spawn path still transitions pending → running via NodeStarted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // First run: start + running
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(2) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("running")

        // Replan restart: NodeRestarted (running → pending)
        yield* events.publish(DagEvent.NodeRestarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(3) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("pending")

        // Re-spawn: NodeStarted on the pending row MUST still work (guard set includes pending)
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_B" as never, timestamp: ts(4) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("running")
        expect((yield* store.getNode(dagID, nodeID))?.childSessionId).toBe("ses_B")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("archives the replaced worktree when a restarted node starts a new one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionID.make("ses_A"),
          worktree: {
            directory: "/repo/.worktrees/first",
            touchedPaths: [],
            state: "active",
            conflictsWith: [],
          },
          timestamp: ts(2),
        })
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID,
          nodeID,
          childSessionID: SessionID.make("ses_A"),
          timestamp: ts(3),
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionID.make("ses_B"),
          worktree: {
            directory: "/repo/.worktrees/second",
            touchedPaths: [],
            state: "active",
            conflictsWith: [],
          },
          timestamp: ts(4),
        })

        const node = yield* store.getNode(dagID, nodeID)
        expect(node?.worktreeDirectory).toBe("/repo/.worktrees/second")
        expect(node?.worktreeHistory?.map((worktree) => worktree.directory)).toEqual(["/repo/.worktrees/first"])
      }).pipe(Effect.provide(projectorLayer)),
    )
  })

  it("NodeStarted on a completed node does not flip it back to running", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // Start then complete the node
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_A" as never, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID, output: { ok: true }, durationMs: 0, timestamp: ts(3) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("completed")

        // A stale NodeStarted MUST NOT resurrect the completed node
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_B" as never, timestamp: ts(4) })
        expect((yield* store.getNode(dagID, nodeID))?.status).toBe("completed")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })
})

describe("DagProjector: workflow status guard", () => {
  it("does NOT overwrite a cancelled workflow with a stale completion", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflowAndNode()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.WorkflowCancelled, { dagID, timestamp: ts(3) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(4) })

        expect((yield* store.getWorkflow(dagID))?.status).toBe("cancelled")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })
})

describe("Dag.Service guardNode: terminal-origin rejection", () => {
  it("nodeStarted on a failed node returns TerminalViolationError and publishes no event", async () => {
    // Mock DagStore: returns a "failed" node
    const published: string[] = []
    const mockStore = Layer.mock(DagStore.Service, {
      getNode: () => Effect.succeed({ id: "n1", status: "failed" as NodeStatus }) as never,
      getWorkflow: () => Effect.succeed({ id: "wf1", status: "running" }) as never,
    })
    // Mock EventV2Bridge: tracks publishes
    const mockBridge = Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: () =>
          Effect.sync(() => {
            published.push("event")
            return { seq: 1 }
          }),
      } as never),
    )
    const testLayer = Dag.layer.pipe(Layer.provide(mockBridge), Layer.provide(mockStore))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const error = yield* dag.nodeStarted("wf1", "n1", "ses_B").pipe(
          Effect.catch((e: Error) => Effect.succeed(e)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
        expect(published).toEqual([]) // no event was published
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects node updates addressed to a different workflow", async () => {
    const published: string[] = []
    const lookedUp: [string, string][] = []
    const mockStore = Layer.mock(DagStore.Service, {
      getWorkflow: () => Effect.succeed({ id: "wf2", status: "running" }) as never,
      getNode: (workflowID, nodeID) =>
        Effect.sync(() => {
          lookedUp.push([workflowID, nodeID])
          return undefined
        }) as never,
    })
    const mockBridge = Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: () =>
          Effect.sync(() => {
            published.push("event")
            return { seq: 1 }
          }),
      } as never),
    )
    const testLayer = Dag.layer.pipe(Layer.provide(mockBridge), Layer.provide(mockStore))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const error = yield* dag.nodeStarted("wf2", "n1", "ses_B").pipe(
          Effect.catch((e: Error) => Effect.succeed(e)),
        )
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("Node not found")
        expect(lookedUp).toEqual([["wf2", "n1"]])
        expect(published).toEqual([])
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects replanning a terminal workflow", async () => {
    const published: string[] = []
    const mockStore = Layer.mock(DagStore.Service, {
      getWorkflow: () => Effect.succeed({ id: "wf1", status: "completed" }) as never,
    })
    const mockBridge = Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: () =>
          Effect.sync(() => {
            published.push("event")
            return { seq: 1 }
          }),
      } as never),
    )
    const testLayer = Dag.layer.pipe(Layer.provide(mockBridge), Layer.provide(mockStore))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const error = yield* dag.replan("wf1", { nodes: [] }).pipe(
          Effect.catch((e: Error) => Effect.succeed(e)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
        expect(published).toEqual([])
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<never>,
    )
  })
})
