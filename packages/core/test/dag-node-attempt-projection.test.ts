// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * `dag_node_attempt` is the per-attempt usage ledger (#1027 D6). The DAG
 * projector derives it from `dag.node.started`; the attempt ordinal is the
 * node's restart count at start time (the same `(child session, attempts)`
 * identity the mailbox uses), so a retried node accumulates one row per
 * attempt.
 *
 * These tests exercise the real projector SQL: only an attempt that actually
 * started earns a row (a stale or racing start projects zero rows and must
 * not create a phantom attempt), and replay/repeat stays idempotent on the
 * `(workflow_id, node_id, attempt)` primary key.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagNodeAttemptTable, WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
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
    yield* db
      .insert(ProjectTable)
      .values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd() as never,
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowTable)
      .values({
        id: "dag_attempt",
        project_id: "project-1" as never,
        session_id: "ses_parent" as never,
        title: "Attempt ledger",
        status: "running",
        config: "{}",
        seq: 1,
        wake_reported: false,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        id: "n1",
        workflow_id: "dag_attempt",
        name: "N1",
        worker_type: "build",
        status: "pending",
        required: true,
        depends_on: [],
        wake_eligible: false,
        wake_reported: false,
        seq: 1,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const rows = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(DagNodeAttemptTable).orderBy(DagNodeAttemptTable.attempt).all().pipe(Effect.orDie)
  })

const started = (childSessionID: string, timestamp: DateTime.Utc) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.NodeStarted, {
      dagID: DagEvent.DagID.make("dag_attempt"),
      nodeID: DagEvent.NodeID.make("n1"),
      childSessionID: childSessionID as never,
      timestamp,
    })
  })

describe("dag_node_attempt projection (#1027 D6)", () => {
  test("a first start records attempt 0 with its child session and start time", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const at = yield* DateTime.now
        yield* started("ses_first", at)

        expect(yield* rows()).toEqual([
          {
            workflow_id: "dag_attempt",
            node_id: "n1",
            attempt: 0,
            child_session_id: "ses_first",
            started_at: DateTime.toEpochMillis(at),
          },
        ])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })

  test("a restarted node records one row per attempt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const events = yield* EventV2.Service
        const dagID = DagEvent.DagID.make("dag_attempt")
        const nodeID = DagEvent.NodeID.make("n1")

        yield* started("ses_first", yield* DateTime.now)
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID,
          nodeID,
          childSessionID: "ses_first" as never,
          timestamp: yield* DateTime.now,
        })
        yield* started("ses_second", yield* DateTime.now)

        expect((yield* rows()).map((row) => [row.attempt, row.child_session_id])).toEqual([
          [0, "ses_first"],
          [1, "ses_second"],
        ])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })

  test("a repeated start without a restart does not duplicate the attempt row", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        yield* started("ses_first", yield* DateTime.now)
        yield* started("ses_second", yield* DateTime.now)

        // Same (workflow, node, attempt) identity: the projection updates the
        // node row but the ledger keeps the attempt's first observation.
        expect((yield* rows()).map((row) => row.child_session_id)).toEqual(["ses_first"])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })

  test("a stale start after the node terminalized records nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        const { db } = yield* Database.Service
        yield* db
          .update(WorkflowNodeTable)
          .set({ status: "failed" })
          .run()
          .pipe(Effect.orDie)

        yield* started("ses_stale", yield* DateTime.now)

        expect(yield* rows()).toEqual([])
      }).pipe(Effect.provide(projectorLayer()), Effect.scoped),
    )
  })
})
