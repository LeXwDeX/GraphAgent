// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Train A probe A-p5(b) (PIN, green before and after) — reopen wash by
 * workflow status (workflows/dag-engine-optimization.md, v1.0.15 ledger A4;
 * evidence §7 U3).
 *
 * A completed workflow reopened by an additive extend (WorkflowReplanned
 * projection's sanctioned completed→running exception) stops re-waking
 * because the wake read filters on TERMINAL workflow status. This pin locks
 * the observable part of A-p5(b): after the reopen projection the workflow
 * is no longer returned as an unreported wake, regardless of rev semantics.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowTable } from "@graphagent/core/dag/sql"
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

function seed() {
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
      id: "dag_reopen",
      project_id: projectID,
      session_id: sessionID,
      title: "Reopen wash",
      status: "completed",
      config: "{}",
      seq: 1,
      wake_reported: true,
      started_at: 1,
      completed_at: 2,
    }).run().pipe(Effect.orDie)
  })
}

describe("Train A rev-view — reopen wash (A-p5(b) PIN)", () => {
  test("WorkflowReplanned reopen puts the workflow back to running and out of the terminal wake read", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.WorkflowReplanned, {
          dagID: DagEvent.DagID.make("dag_reopen"),
          added: 1,
          removed: 0,
          replaced: 0,
          restarted: 0,
          timestamp: yield* DateTime.now,
        })

        const wf = yield* store.getWorkflow("dag_reopen")
        expect(wf?.status).toBe("running")
        expect(wf?.wakeReported).toBe(false)
        expect(wf?.completedAt).toBeNull()

        // Washed by status: the terminal wake read only returns workflows in
        // a terminal status — a reopened (running) workflow is not among the
        // unreported wakes, so it stops re-waking the parent.
        const unreported = yield* store.getUnreportedWakeWorkflows(sessionID)
        expect(unreported.map((w) => w.id)).toEqual([])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })
})
