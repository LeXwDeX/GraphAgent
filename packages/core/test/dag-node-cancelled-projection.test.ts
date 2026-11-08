/**
 * Regression guard for the NodeCancelled projection contract (ticket A,
 * method-A: align to implementation).
 *
 * NodeCancelled has NO independent terminal status. It projects to
 * `status="failed"` carrying the cancellation marker in `error_reason`
 * ("cancelled via replan") and clears `escalation_pending` (cancel is an
 * adjudication). The NodeStatus enum has no CANCELLED value and
 * getValidNextNodeStatuses never returns cancelled, so a node row can never
 * hold status="cancelled". This test exercises the real projector SQL
 * (projector.ts NodeCancelled handler) end-to-end at the core layer so the
 * semantic cannot silently drift back to a phantom node-level "cancelled"
 * status.
 *
 * The end-to-end canonical proof lives in
 * packages/graphagent/test/dag/dag-escalation-clear-flag.test.ts:130-148; this
 * core-level test mirrors it without depending on the opencode Dag command
 * layer.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"

function projectorLayer() {
  const database = Database.layerFromPath(":memory:")
  const eventLayer = EventV2.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventLayer)))
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(database, eventLayer, projector, store)
}

function seed() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({
      id: "ses_parent" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* db.insert(WorkflowTable).values({
      id: "dag_cancel",
      project_id: "project-1" as never,
      session_id: "ses_parent" as never,
      title: "Cancel projection",
      status: "running",
      config: "{}",
      seq: 1,
      wake_reported: false,
      directory: "/project",
      target_fingerprint: { kind: "none" },
    }).run().pipe(Effect.orDie)
    yield* db.insert(WorkflowNodeTable).values({
      id: "n1",
      workflow_id: "dag_cancel",
      name: "N1",
      worker_type: "build",
      status: "running",
      required: true,
      depends_on: [],
      wake_eligible: false,
      wake_reported: false,
      // Pre-set an adjudication flag so the projection's clear is observable.
      escalation_pending: true,
      seq: 1,
    }).run().pipe(Effect.orDie)
  })
}

describe("NodeCancelled projection (no phantom node-level cancelled status)", () => {
  test("projects NodeCancelled to status=failed + error_reason='cancelled via replan' and clears escalation_pending", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service

        yield* events.publish(DagEvent.NodeCancelled, {
          dagID: DagEvent.DagID.make("dag_cancel"),
          nodeID: DagEvent.NodeID.make("n1"),
          timestamp: yield* DateTime.now,
        })

        const row = yield* store.getNode("dag_cancel", "n1")
        // NodeCancelled has no independent terminal status: it lands on failed
        // with the cancellation carried by error_reason, never status="cancelled".
        expect(row?.status).toBe("failed")
        expect(row?.errorReason).toBe("cancelled via replan")
        // Cancel is an adjudication — the pending-escalation flag must clear.
        expect(row?.escalationPending).toBe(false)
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })
})
