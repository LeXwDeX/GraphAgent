// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"

function storeLayer() {
  const database = Database.layerFromPath(":memory:")
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

function node(workflowId: string, id: string, status: string, seq: number) {
  return {
    id,
    workflow_id: workflowId,
    name: id,
    worker_type: "build",
    status,
    required: true,
    depends_on: [],
    wake_eligible: false,
    wake_reported: false,
    seq,
  }
}

function seed() {
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
    yield* database.db.insert(WorkflowTable).values([
      {
        id: "wf-mixed",
        project_id: "project-1" as never,
        session_id: "ses_parent" as never,
        title: "Mixed",
        status: "running",
        config: "{}",
        seq: 1,
        wake_reported: false,
        time_created: 2,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
      {
        id: "wf-empty",
        project_id: "project-1" as never,
        session_id: "ses_parent" as never,
        title: "Empty",
        status: "running",
        config: "{}",
        seq: 2,
        wake_reported: false,
        time_created: 1,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      node("wf-mixed", "c1", "completed", 1),
      node("wf-mixed", "c2", "completed", 2),
      node("wf-mixed", "r1", "running", 3),
      node("wf-mixed", "f1", "failed", 4),
      node("wf-mixed", "p1", "pending", 5),
      node("wf-mixed", "s1", "skipped", 6),
      node("wf-mixed", "q1", "queued", 7),
      node("wf-mixed", "a1", "aborted", 8),
    ]).run().pipe(Effect.orDie)
  })
}

describe("DagStore.getWorkflowSummaries (SQL aggregation)", () => {
  test("counts mixed node statuses per workflow and defaults empty workflows to zero", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const summaries = yield* store.getWorkflowSummaries("ses_parent")

        // Ordered by time_created DESC: wf-mixed (2) before wf-empty (1).
        expect(summaries.map((s) => s.id)).toEqual(["wf-mixed", "wf-empty"])
        expect(summaries[0]).toEqual({
          id: "wf-mixed",
          title: "Mixed",
          status: "running",
          graphRev: 1,
          nodeCount: 8,
          completedNodes: 2,
          runningNodes: 1,
          failedNodes: 1,
          skippedNodes: 1,
          abortedNodes: 1,
          queuedNodes: 1,
          escalatedNodes: 0,
        })
        expect(summaries[1]).toEqual({
          id: "wf-empty",
          title: "Empty",
          status: "running",
          graphRev: 1,
          nodeCount: 0,
          completedNodes: 0,
          runningNodes: 0,
          failedNodes: 0,
          skippedNodes: 0,
          abortedNodes: 0,
          queuedNodes: 0,
          escalatedNodes: 0,
        })
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("returns an empty list for a session with no workflows", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        expect(yield* store.getWorkflowSummaries("ses_missing")).toEqual([])
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("listSummariesByParent returns the same parent-scoped aggregation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const summaries = yield* store.listSummariesByParent("ses_parent")
        expect(summaries).toEqual(yield* store.getWorkflowSummaries("ses_parent"))
        expect(summaries.map((summary) => summary.id)).toEqual(["wf-mixed", "wf-empty"])
        expect(summaries[0].abortedNodes).toBe(1)
        expect(yield* store.listSummariesByParent("ses_missing")).toEqual([])
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })
})
