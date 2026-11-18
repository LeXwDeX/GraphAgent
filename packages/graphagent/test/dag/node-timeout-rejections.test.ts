// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { WorkflowNodeTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { markNodeWakeReported } from "./fixtures"

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  DagTransact.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const it = testEffect(Layer.provideMerge(Dag.layer, persistence))

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
  }
}

function setup(sessionID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(sessionID),
        project_id: Project.ID.global,
        slug: sessionID,
        directory: AbsolutePath.make("/project"),
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function setNodeStatus(dagID: string, nodeID: string, status: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowNodeTable)
      .set({ status })
      .where(and(eq(WorkflowNodeTable.workflow_id, dagID), eq(WorkflowNodeTable.id, nodeID)))
      .run()
      .pipe(Effect.orDie)
  })
}

/**
 * A second `Dag` over the same database whose store is partly replaced, so a
 * test can land a concurrent writer inside one command's read window. The two
 * instances share the database but not the in-process workflow lock. A fresh
 * memo map keeps the test environment's own `Dag` from being handed back.
 */
function dagOverStore(override: (store: DagStore.Interface) => Partial<DagStore.Interface>) {
  return Effect.gen(function* () {
    const store = yield* DagStore.Service
    const context = yield* Layer.buildWithMemoMap(
      Dag.layer.pipe(
        Layer.provide(Layer.succeed(DagStore.Service, DagStore.Service.of({ ...store, ...override(store) }))),
      ),
      yield* Layer.makeMemoMap,
      yield* Scope.Scope,
    )
    return Context.get(context, Dag.Service)
  })
}

describe("node timeout command rejections", () => {
  it.effect("nodeExtendTimeout leaves the deadline alone when the caller names another attempt", () =>
    Effect.gen(function* () {
      const sessionID = "ses_timeout_attempt"
      const child = "ses_timeout_attempt_child"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* dag.create({
        projectID: Project.ID.global,
        sessionID,
        title: sessionID,
        config: { name: sessionID, nodes: [node("n")] },
      })
      yield* dag.nodeQueued(dagID, "n", Date.now() + 60_000)
      yield* dag.nodeStarted(dagID, "n", child, Date.now() + 60_000)
      const armed = (yield* dag.store.getNode(dagID, "n"))?.deadlineMs

      // A watcher that outlived its attempt carries the identity it was armed
      // with: another child session or an older replan attempt is someone
      // else's run, so the node is not re-timed on its behalf.
      expect(
        yield* dag.nodeExtendTimeout(dagID, "n", 99_999, { replanAttempts: 0, childSessionID: "ses_timeout_other" }),
      ).toBe(0)
      expect(yield* dag.nodeExtendTimeout(dagID, "n", 99_999, { replanAttempts: 1, childSessionID: child })).toBe(0)
      expect((yield* dag.store.getNode(dagID, "n"))?.deadlineMs).toBe(armed)

      // The attempt that owns the node can still re-time it.
      expect(yield* dag.nodeExtendTimeout(dagID, "n", 99_999, { replanAttempts: 0, childSessionID: child })).toBe(1)
      expect((yield* dag.store.getNode(dagID, "n"))?.deadlineMs).toBe(99_999)
    }),
  )

  it.effect("extendTimeout reports not_running when the node terminalizes between its read and the re-time", () =>
    Effect.gen(function* () {
      const sessionID = "ses_timeout_race"
      const child = "ses_timeout_race_child"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      const dagID = yield* dag.create({
        projectID: Project.ID.global,
        sessionID,
        title: sessionID,
        config: { name: sessionID, nodes: [node("n")] },
      })
      yield* dag.nodeQueued(dagID, "n", Date.now() - 1000)
      yield* dag.nodeStarted(dagID, "n", child, Date.now() + 60_000, true)
      yield* dag.nodeTimeoutEscalated(dagID, "n", child, 1)
      yield* markNodeWakeReported(store, dagID, "n")

      // extendTimeout reads the node, then nodeExtendTimeout reads it again
      // before writing. Another writer completes the node in between.
      let reads = 0
      const racing = yield* dagOverStore((real) => ({
        getNode: (id, nodeID) =>
          Effect.suspend(() =>
            ++reads === 2
              ? setNodeStatus(id, nodeID, "completed").pipe(Effect.provideService(Database.Service, database))
              : Effect.void,
          ).pipe(Effect.andThen(real.getNode(id, nodeID))),
      }))

      expect(yield* racing.extendTimeout(dagID, "n", 60_000)).toEqual({ status: "not_running" })
      expect(reads).toBe(2)
      expect((yield* store.getNode(dagID, "n"))?.status).toBe("completed")
    }),
  )
})
