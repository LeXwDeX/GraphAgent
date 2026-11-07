// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Train A probe A-p4 (PIN, green before and after) — legacy no-rev workflows
 * render unchanged (workflows/dag-engine-optimization.md, v1.0.15 ledger A4;
 * evidence §7 legacy policy).
 *
 * Rows written before the rev-view feature carry no rev marker. The migration
 * defaults (workflow.graph_rev = 1, workflow_node.superseded = false) must
 * keep EVERY legacy row visible and counted exactly as v1.0.14 rendered it —
 * including legacy cancelled-via-replan rows (status failed, error_reason
 * "cancelled via replan"), which today appear in getNodes and count toward
 * failedNodes in getWorkflowSummaries.
 *
 * The seed deliberately omits the new columns so the DB defaults apply, the
 * same state a migrated install carries.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"

function storeLayer() {
  const database = Database.layerFromPath(":memory:")
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

const projectID = ProjectV2.ID.make("project-1")
const sessionID = SessionSchema.ID.create()

function node(workflowId: string, id: string, status: string, seq: number, errorReason?: string, errorClass?: string) {
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
    ...(errorReason !== undefined ? { error_reason: errorReason } : {}),
    ...(errorClass !== undefined ? { error_class: errorClass } : {}),
  }
}

function seed() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: projectID,
      worktree: AbsolutePath.make(process.cwd()),
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: sessionID,
      project_id: projectID,
      slug: "parent",
      directory: process.cwd(),
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowTable).values({
      id: "wf-legacy",
      project_id: projectID,
      session_id: sessionID,
      title: "Legacy",
      status: "running",
      config: "{}",
      seq: 1,
      wake_reported: false,
      time_created: 1,
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      node("wf-legacy", "a", "completed", 1),
      node("wf-legacy", "b", "completed", 2),
      // Legacy cancelled-via-replan row: v1.0.14 renders it visible and
      // counts it in failedNodes. That rendering must survive the feature.
      node("wf-legacy", "old_cancelled", "failed", 3, "cancelled via replan"),
      node("wf-legacy", "f1", "failed", 4, "boom", "exec_failed"),
    ]).run().pipe(Effect.orDie)
  })
}

describe("Train A rev-view — legacy rows render unchanged (A-p4 PIN)", () => {
  test("legacy workflow (no rev markers) keeps every row visible and counted as in v1.0.14", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const summaries = yield* store.getWorkflowSummaries(sessionID)
        expect(summaries).toHaveLength(1)
        expect(summaries[0]).toEqual({
          id: "wf-legacy",
          title: "Legacy",
          status: "running",
          graphRev: 1,
          nodeCount: 4,
          completedNodes: 2,
          runningNodes: 0,
          failedNodes: 2,
          skippedNodes: 0,
          abortedNodes: 0,
          queuedNodes: 0,
          escalatedNodes: 0,
        })

        const rows = yield* store.getNodes("wf-legacy")
        expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "f1", "old_cancelled"])
        const cancelled = rows.find((r) => r.id === "old_cancelled")!
        expect(cancelled.status).toBe("failed")
        expect(cancelled.errorReason).toBe("cancelled via replan")

        // Migration defaults (the legacy policy itself): rows that predate the
        // feature carry superseded=false, and the workflow carries graph_rev=1.
        // Any other default would change the rendering pinned above.
        expect(rows.every((r) => !r.superseded)).toBe(true)
        const wf = yield* store.getWorkflow("wf-legacy")
        expect(wf?.graphRev).toBe(1)
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })
})
