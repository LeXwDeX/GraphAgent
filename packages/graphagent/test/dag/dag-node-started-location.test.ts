import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { Session } from "@graphagent/schema/session"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { DagLocation } from "@/dag/location"

const projectorLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const dagID = DagEvent.DagID.make("dag_location")
const nodeID = DagEvent.NodeID.make("node-location")
const ts = (n: number) => DateTime.makeUnsafe(n)

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make("ses_location"),
        project_id: Project.ID.global,
        slug: "location",
        directory: "/project",
        title: "location",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowCreated, {
      dagID,
      projectID: Project.ID.global,
      sessionID: Session.ID.make("ses_location"),
      title: "location",
      config: "",
      status: "pending",
      timestamp: ts(0),
    })
    yield* events.publish(DagEvent.NodeRegistered, {
      dagID,
      nodeID,
      name: "Location",
      workerType: "build",
      dependsOn: [],
      required: true,
      timestamp: ts(1),
    })
  })
}

describe("node execution location view", () => {
  it("projects directory, short HEAD, and the last activity time", () => {
    expect(
      DagLocation.nodeLocationView({
        directory: "/repo/.worktrees/a",
        baseHead: "0123456789abcdef",
        timeUpdated: 5,
      }),
    ).toEqual({
      directory: "/repo/.worktrees/a",
      head: "0123456789ab",
      last_activity_at: "1970-01-01T00:00:00.005Z",
    })
  })

  it("omits fields a legacy row does not carry", () => {
    expect(DagLocation.nodeLocationView({})).toEqual({})
    expect(DagLocation.nodeLocationView({ completedAt: 7 })).toEqual({
      last_activity_at: "1970-01-01T00:00:00.007Z",
    })
  })
})

describe("DagProjector: node execution location", () => {
  it("projects the attempt directory and starting HEAD", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: Session.ID.make("ses_first"),
          directory: "/repo/.worktrees/a",
          baseHead: "0123456789abcdef",
          timestamp: ts(2),
        })
        expect(yield* store.getNode(dagID, nodeID)).toMatchObject({
          directory: "/repo/.worktrees/a",
          baseHead: "0123456789abcdef",
          timeUpdated: 2,
        })
      }).pipe(Effect.provide(projectorLayer), Effect.orDie),
    )
  })

  it("does not carry a previous attempt's snapshot into a legacy restart", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: Session.ID.make("ses_first"),
          directory: "/repo/.worktrees/a",
          baseHead: "0123456789abcdef",
          timestamp: ts(2),
        })
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID,
          nodeID,
          childSessionID: Session.ID.make("ses_first"),
          timestamp: ts(3),
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: Session.ID.make("ses_second"),
          timestamp: ts(4),
        })
        expect(yield* store.getNode(dagID, nodeID)).toMatchObject({
          directory: null,
          baseHead: null,
          childSessionId: "ses_second",
        })
      }).pipe(Effect.provide(projectorLayer), Effect.orDie),
    )
  })
})

describe("node worktree view (#946)", () => {
  it("renders worktree evidence and falls back to touched paths", () => {
    expect(
      DagLocation.nodeLocationView({
        worktreeDirectory: "/data/worktree/wf/node",
        worktreeBranch: "opencode/dag-wf-node",
        worktreeCommit: "abcdef1234567890",
        worktreePatchPath: "/repo/.agents/workflow-reports/dag_wf/node.patch",
        worktreePatchSha256: "a".repeat(64),
        worktreeState: "kept",
        worktreeConflictsWith: ["other"],
        touchedPaths: ["src/a.ts"],
      }),
    ).toMatchObject({
      worktree: {
        directory: "/data/worktree/wf/node",
        branch: "opencode/dag-wf-node",
        commit: "abcdef1234567890",
        patch_path: "/repo/.agents/workflow-reports/dag_wf/node.patch",
        patch_sha256: "a".repeat(64),
        state: "kept",
        conflicts_with: ["other"],
        touched_paths: ["src/a.ts"],
      },
    })
    expect(DagLocation.nodeLocationView({ touchedPaths: ["src/a.ts"] })).toEqual({ touched_paths: ["src/a.ts"] })
  })

  it("projects started and completed worktree metadata", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: Session.ID.make("ses_first"),
          directory: "/data/worktree/wf/node",
          worktree: {
            directory: "/data/worktree/wf/node",
            branch: "opencode/dag-wf-node",
            touchedPaths: [],
            state: "active",
            conflictsWith: [],
          },
          timestamp: ts(2),
        })
        expect(yield* store.getNode(dagID, nodeID)).toMatchObject({
          directory: "/data/worktree/wf/node",
          worktreeDirectory: "/data/worktree/wf/node",
          worktreeBranch: "opencode/dag-wf-node",
          worktreeState: "active",
        })

        yield* events.publish(DagEvent.NodeCompleted, {
          dagID,
          nodeID,
          output: "done",
          durationMs: 1,
          touchedPaths: ["src/a.ts"],
          worktree: {
            directory: "/data/worktree/wf/node",
            branch: "opencode/dag-wf-node",
            commit: "abcdef1234567890",
            baseHead: "0123456789abcdef",
            patchPath: "/repo/.agents/workflow-reports/dag_wf/node.patch",
            patchSha256: "a".repeat(64),
            touchedPaths: ["src/a.ts"],
            state: "removed",
            conflictsWith: [DagEvent.NodeID.make("other")],
          },
          timestamp: ts(3),
        })
        expect(yield* store.getNode(dagID, nodeID)).toMatchObject({
          status: "completed",
          worktreeCommit: "abcdef1234567890",
          worktreePatchPath: "/repo/.agents/workflow-reports/dag_wf/node.patch",
          worktreePatchSha256: "a".repeat(64),
          worktreeState: "removed",
          worktreeConflictsWith: ["other"],
          touchedPaths: ["src/a.ts"],
        })
      }).pipe(Effect.provide(projectorLayer), Effect.orDie),
    )
  })
})
