// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Train A rev-view — projector marking (implementation-side proof for
 * workflows/dag-engine-optimization.md, v1.0.15 ledger A4 decision M1).
 *
 * Pins the projection seams directly on the real projector SQL:
 * - NodeCancelled marks the row superseded (plan.cancel + explicit cancel).
 * - WorkflowReplanned marks its optional superseded list (terminal rows the
 *   fragment bypassed, which the engine never cancels) and bumps graph_rev.
 * - Legacy WorkflowReplanned events WITHOUT the superseded field still decode
 *   and project (replay safety — the field is optional, dag-event.ts pattern).
 * - The NodeRegistered upsert never resets the marker (replace/restart
 *   re-registration must not resurrect a superseded row).
 * - The reopen leg (completed → running) bumps graph_rev as well.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"

function projectorLayer() {
  const database = Database.layerFromPath(":memory:")
  const eventLayer = EventV2.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventLayer)))
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(database, eventLayer, projector, store)
}

const projectID = ProjectV2.ID.make("project-1")
const sessionID = SessionSchema.ID.create()

function seed(workflowStatus: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: projectID,
      worktree: AbsolutePath.make(process.cwd()),
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({
      id: sessionID,
      project_id: projectID,
      slug: "parent",
      directory: process.cwd(),
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* db.insert(WorkflowTable).values({
      id: "dag_rev",
      project_id: projectID,
      session_id: sessionID,
      title: "Rev projection",
      status: workflowStatus,
      config: "{}",
      seq: 1,
      wake_reported: false,
    }).run().pipe(Effect.orDie)
    yield* db.insert(WorkflowNodeTable).values([
      {
        id: "n1",
        workflow_id: "dag_rev",
        name: "n1",
        worker_type: "build",
        status: "completed",
        required: true,
        depends_on: [],
        wake_eligible: false,
        wake_reported: false,
        seq: 1,
      },
      {
        id: "n2",
        workflow_id: "dag_rev",
        name: "n2",
        worker_type: "build",
        status: "failed",
        required: true,
        depends_on: ["n1"],
        error_reason: "simulated exec failure",
        error_class: "exec_failed",
        wake_eligible: false,
        wake_reported: false,
        seq: 2,
      },
      {
        id: "n3",
        workflow_id: "dag_rev",
        name: "n3",
        worker_type: "build",
        status: "pending",
        required: true,
        depends_on: ["n1"],
        wake_eligible: false,
        wake_reported: false,
        seq: 3,
      },
    ]).run().pipe(Effect.orDie)
  })
}

function replan(input: { dagID: string; superseded?: string[]; added?: number }) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowReplanned, {
      dagID: DagEvent.DagID.make(input.dagID),
      added: input.added ?? 1,
      removed: 0,
      replaced: 0,
      restarted: 0,
      ...(input.superseded
        ? { superseded: input.superseded.map((id) => DagEvent.NodeID.make(id)) }
        : {}),
      timestamp: yield* DateTime.now,
    })
  })
}

describe("Train A rev-view — projector marking", () => {
  test("NodeCancelled marks superseded; WorkflowReplanned marks its supersede list and bumps graph_rev", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed("running")
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        // plan.cancel seam: cancel pending n3 via NodeCancelled.
        yield* events.publish(DagEvent.NodeCancelled, {
          dagID: DagEvent.DagID.make("dag_rev"),
          nodeID: DagEvent.NodeID.make("n3"),
          timestamp: yield* DateTime.now,
        })
        expect((yield* store.getNode("dag_rev", "n3"))?.superseded).toBe(true)
        expect((yield* store.getNode("dag_rev", "n3"))?.status).toBe("failed")

        // Bypassed-failure seam: n2 is terminal-failed and never cancelled —
        // the WorkflowReplanned supersede list marks it. Legacy n1 stays.
        yield* replan({ dagID: "dag_rev", superseded: ["n2"] })
        expect((yield* store.getNode("dag_rev", "n2"))?.superseded).toBe(true)
        expect((yield* store.getNode("dag_rev", "n1"))?.superseded).toBe(false)
        expect((yield* store.getWorkflow("dag_rev"))?.graphRev).toBe(2)

        // Replay-safe legacy shape: NO superseded field still decodes,
        // bumps the revision, and marks nothing new.
        yield* replan({ dagID: "dag_rev" })
        expect((yield* store.getWorkflow("dag_rev"))?.graphRev).toBe(3)
        expect((yield* store.getNode("dag_rev", "n1"))?.superseded).toBe(false)

        // The NodeRegistered upsert must NOT reset the marker — replace and
        // restart re-publish definitions for the same id.
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: DagEvent.DagID.make("dag_rev"),
          nodeID: DagEvent.NodeID.make("n2"),
          name: "n2-renamed",
          workerType: "build",
          dependsOn: ["n1"].map((id) => DagEvent.NodeID.make(id)),
          required: true,
          timestamp: yield* DateTime.now,
        })
        const n2 = yield* store.getNode("dag_rev", "n2")
        expect(n2?.superseded).toBe(true)
        expect(n2?.name).toBe("n2-renamed")

        // View reads see only the current revision; durable reads see all.
        expect((yield* store.getCurrentNodes("dag_rev")).map((n) => n.id)).toEqual(["n1"])
        expect((yield* store.getNodes("dag_rev")).map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })

  test("NodeRestarted preserves the worktree pointer until the replacement starts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed("running")
        const { db } = yield* Database.Service
        yield* db
          .update(WorkflowNodeTable)
          .set({
            status: "running",
            child_session_id: SessionSchema.ID.create(),
            worktree_directory: "/repo/.worktrees/wt",
            worktree_branch: "opencode/wt",
            worktree_state: "active",
            touched_paths: ["src/a.ts"],
          })
          .where(and(eq(WorkflowNodeTable.workflow_id, "dag_rev"), eq(WorkflowNodeTable.id, "n1")))
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID: DagEvent.DagID.make("dag_rev"),
          nodeID: DagEvent.NodeID.make("n1"),
          childSessionID: SessionSchema.ID.create(),
          timestamp: yield* DateTime.now,
        })
        const node = yield* (yield* DagStore.Service).getNode("dag_rev", "n1")
        expect(node?.status).toBe("pending")
        expect(node?.worktreeDirectory).toBe("/repo/.worktrees/wt")
        expect(node?.worktreeBranch).toBe("opencode/wt")
        expect(node?.worktreeState).toBe("active")
        expect(node?.touchedPaths).toEqual(["src/a.ts"])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })

  test("the reopen leg (completed workflow) bumps graph_rev too", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed("completed")
        const store = yield* DagStore.Service
        yield* replan({ dagID: "dag_rev" })
        const wf = yield* store.getWorkflow("dag_rev")
        expect(wf?.status).toBe("running")
        expect(wf?.graphRev).toBe(2)
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })
})
