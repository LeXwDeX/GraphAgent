// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowTable } from "@graphagent/core/dag/sql"
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
        id: "dag_worktree",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Workflow worktree",
        status: "completed",
        config: "{}",
        seq: 7,
        directory: "/project",
        target_fingerprint: { kind: "none" },
        completed_at: 1000,
        time_updated: 1000,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const settled: DagEvent.WorkflowWorktree = {
  directory: "/repo/.agents/worktree/dag-dag-worktree-workflow",
  branch: "opencode/dag-dag-worktree-workflow",
  baseHead: "base-sha",
  head: "head-sha",
  patchPath: "/reports/dag_worktree/workflow.patch",
  patchSha256: "patch-sha",
  touchedPaths: ["src/a.ts"],
  state: "removed",
}

describe("workflow worktree settlement projection (#1030)", () => {
  test("settlement writes the read-model pointer without advancing seq or time_updated", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const before = yield* store.getWorkflow("dag_worktree")

        yield* events.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID: DagEvent.DagID.make("dag_worktree"),
          worktree: settled,
          timestamp: yield* DateTime.now,
        })

        expect(yield* store.getWorkflow("dag_worktree")).toEqual(
          expect.objectContaining({ worktree: settled, seq: before?.seq, timeUpdated: before?.timeUpdated }),
        )
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })

  test("a duplicate settlement folds to a no-op and keeps the first outcome", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_worktree")

        yield* events.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID,
          worktree: settled,
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID,
          worktree: { ...settled, state: "kept", reason: "later settlement" },
          timestamp: yield* DateTime.now,
        })

        expect((yield* store.getWorkflow("dag_worktree"))?.worktree).toEqual(settled)
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })

  test("a workflow without a workflow-level worktree keeps NULL after settlement events for others", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.make("dag_worktree")

        // A stale settlement for a different workflow cannot touch this row.
        yield* events.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID: DagEvent.DagID.make("dag_other"),
          worktree: settled,
          timestamp: yield* DateTime.now,
        })

        expect((yield* store.getWorkflow("dag_worktree"))?.worktree ?? null).toBeNull()
        expect((yield* store.getWorkflow(dagID))?.worktree ?? null).toBeNull()
      }).pipe(Effect.provide(layer(":memory:")), Effect.scoped),
    )
  })
})