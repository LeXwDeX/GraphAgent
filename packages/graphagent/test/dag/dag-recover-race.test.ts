// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Scope } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

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

describe("recover fences against a concurrent command", () => {
  it.effect("rejects when the workflow changes during artifact verification", () =>
    Effect.gen(function* () {
      const sessionID = "ses_recover_race"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* dag.create({
        projectID: Project.ID.global,
        sessionID,
        title: sessionID,
        config: { name: sessionID, nodes: [node("n")] },
      })
      yield* dag.pause(dagID)
      const before = (yield* dag.store.getWorkflow(dagID))!

      // Recovery reads the nodes before it hashes artifacts, outside the
      // workflow lock; a concurrent resume lands in that window.
      let reads = 0
      const racing = yield* dagOverStore((real) => ({
        getNodes: (id) =>
          Effect.suspend(() => (++reads === 1 ? dag.resume(dagID).pipe(Effect.orDie) : Effect.void)).pipe(
            Effect.andThen(real.getNodes(id)),
          ),
      }))

      const rejected = yield* racing
        .recover(dagID, { nodeIDs: ["n"], expectedGraphRev: before.graphRev })
        .pipe(Effect.flip)
      expect(rejected.message).toBe(
        "Recovery rejected: workflow changed during artifact verification; inspect status and retry",
      )
      const after = (yield* dag.store.getWorkflow(dagID))!
      expect(after.status).toBe("running")
      expect(after.graphRev).toBe(before.graphRev)
      expect(yield* dag.store.getNodes(dagID)).toHaveLength(1)
    }),
  )
})
