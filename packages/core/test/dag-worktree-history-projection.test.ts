// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"

function layer(filename: string) {
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
        id: "dag_history",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Worktree history",
        status: "running",
        config: "{}",
        seq: 0,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        id: "node",
        workflow_id: "dag_history",
        name: "Node",
        worker_type: "build",
        status: "pending",
        required: true,
        depends_on: [],
        seq: 0,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("DAG worktree history projection (#946)", () => {
  test("a replacement NodeStarted archives the prior worktree before overwriting the pointer", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_history")
        const nodeID = DagEvent.NodeID.make("node")

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionSchema.ID.make("ses_first"),
          worktree: {
            directory: "/repo/.worktrees/first",
            branch: "opencode/dag-node-first",
            touchedPaths: ["src/first.ts"],
            state: "active",
            conflictsWith: [],
          },
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID,
          nodeID,
          childSessionID: SessionSchema.ID.make("ses_first"),
          timestamp: yield* DateTime.now,
        })
        // NodeRestarted keeps the pointer; the replacement start is the seam
        // that overwrites it and must archive it first.
        expect((yield* store.getNode("dag_history", "node"))?.worktreeDirectory).toBe("/repo/.worktrees/first")

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionSchema.ID.make("ses_second"),
          worktree: {
            directory: "/repo/.worktrees/second",
            branch: "opencode/dag-node-second",
            touchedPaths: ["src/second.ts"],
            state: "active",
            conflictsWith: [],
          },
          timestamp: yield* DateTime.now,
        })

        expect(yield* store.getNode("dag_history", "node")).toEqual(
          expect.objectContaining({
            worktreeDirectory: "/repo/.worktrees/second",
            worktreeState: "active",
            worktreeHistory: [
              {
                directory: "/repo/.worktrees/first",
                branch: "opencode/dag-node-first",
                touchedPaths: [],
                state: "active",
                conflictsWith: [],
              },
            ],
          }),
        )
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })

  test("repeated starts of the same worktree do not duplicate history", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_history")
        const nodeID = DagEvent.NodeID.make("node")
        const worktree: DagEvent.NodeWorktree = {
          directory: "/repo/.worktrees/same",
          touchedPaths: [],
          state: "active",
          conflictsWith: [],
        }

        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionSchema.ID.make("ses_first"),
          worktree,
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID,
          nodeID,
          childSessionID: SessionSchema.ID.make("ses_second"),
          worktree,
          timestamp: yield* DateTime.now,
        })

        expect((yield* store.getNode("dag_history", "node"))?.worktreeHistory ?? []).toEqual([])
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })

  test("a failed replacement archives the previous pointer and ignores stale failures", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_history")
        const nodeID = DagEvent.NodeID.make("node")
        const first: DagEvent.NodeWorktree = {
          directory: "/repo/.worktrees/first",
          branch: "opencode/first",
          baseHead: "first-base",
          touchedPaths: [],
          state: "active",
          conflictsWith: [],
        }
        const second: DagEvent.NodeWorktree = {
          directory: "/repo/.worktrees/second",
          branch: "opencode/second",
          baseHead: "second-base",
          touchedPaths: [],
          state: "kept",
          conflictsWith: [],
        }
        yield* events.publish(DagEvent.NodeStarted, {
          dagID, nodeID, childSessionID: SessionSchema.ID.make("ses_first"),
          baseHead: first.baseHead, worktree: first, timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID, nodeID, childSessionID: SessionSchema.ID.make("ses_first"), timestamp: yield* DateTime.now,
        })
        const failure = {
          dagID, nodeID, reason: "session create and cleanup failed", trigger: "exec_failed" as const,
          worktree: second, timestamp: yield* DateTime.now,
        }
        yield* events.publish(DagEvent.NodeFailed, failure)
        yield* events.publish(DagEvent.NodeFailed, failure)
        yield* events.publish(DagEvent.NodeFailed, {
          ...failure, worktree: { ...second, directory: "/repo/.worktrees/stale" },
        })

        expect(yield* store.getNode("dag_history", "node")).toEqual(expect.objectContaining({
          status: "failed",
          worktreeDirectory: second.directory,
          worktreeState: "kept",
          baseHead: "second-base",
          worktreeHistory: [first],
        }))
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })

  test("a failure of the current worktree does not archive the same pointer", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_history")
        const nodeID = DagEvent.NodeID.make("node")
        const worktree: DagEvent.NodeWorktree = {
          directory: "/repo/.worktrees/same", touchedPaths: [], state: "active", conflictsWith: [],
        }
        yield* events.publish(DagEvent.NodeStarted, {
          dagID, nodeID, childSessionID: SessionSchema.ID.make("ses_first"), worktree, timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.NodeFailed, {
          dagID, nodeID, reason: "failed", trigger: "exec_failed", worktree: { ...worktree, state: "kept" },
          timestamp: yield* DateTime.now,
        })
        expect((yield* store.getNode("dag_history", "node"))?.worktreeHistory ?? []).toEqual([])
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })
})
