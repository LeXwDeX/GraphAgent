// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMetrics } from "../src/database/metrics"
import { DagMessages } from "../src/dag/messages"

const parent = { projectID: "p", directory: process.cwd(), sessionID: "parent" }
const child = (index: number) => ({ ...parent, sessionID: `child${index}` })
const foreign = { ...parent, sessionID: "foreign" }
const layer = (filename = ":memory:") => {
  const db = Database.layerFromPath(filename)
  return Layer.merge(db, DagMessages.layer.pipe(Layer.provide(db)))
}
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | DagMessages.Service>, filename?: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
const value = <A>(r: DagMessages.Result<A>): A => {
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(r.reason)
  return r.value
}
/** Seed one workflow with `count` running nodes plus one superseded node. */
const seed = (count: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
    )
    for (const id of ["parent", "foreign", ...Array.from({ length: count }, (_, index) => `child${index}`)])
      yield* db.run(
        sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},'p',${id.startsWith("child") ? "parent" : null},${id},${process.cwd()},${id},'test',1,1)`,
      )
    yield* db.run(
      sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES ('wf','p','parent',${process.cwd()},'{"kind":"none"}','W','running','{}',1,1,1)`,
    )
    for (let index = 0; index < count; index++)
      yield* db.run(
        sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,replan_attempts,seq,time_created,time_updated) VALUES (${`n${index}`},'wf',${`N${index}`},'task','running','[]',${`child${index}`},0,${index},1,1)`,
      )
    yield* db.run(
      sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,superseded,seq,time_created,time_updated) VALUES ('old','wf','OLD','task','completed','[]',NULL,1,99,1,1)`,
    )
  }).pipe(Effect.orDie)
const send = (sessionID: string, nodeID: string, attemptID: string, key: string) =>
  Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    value(
      yield* messages.send({ ...parent, sessionID }, {
        workflowID: "wf",
        nodeID,
        attemptID,
        idempotencyKey: key,
        content: `payload-${key}`,
      }),
    )
  })

describe("batch mailbox metadata", () => {
  test("matches the single-node read for every current node", async () =>
    run(
      Effect.gen(function* () {
        yield* seed(3)
        const messages = yield* DagMessages.Service
        yield* send("parent", "n0", DagMessages.nodeAttemptID("child0", 0), "k0")
        const batch = value(yield* messages.metadataForWorkflow(parent, "wf"))
        expect([...batch.keys()].sort()).toEqual(["n0", "n1", "n2"])
        for (const nodeID of ["n0", "n1", "n2"])
          expect(batch.get(nodeID)).toEqual(value(yield* messages.metadata(parent, "wf", nodeID)))
        // The superseded node is not part of the current view.
        expect(batch.has("old")).toBe(false)
        expect(batch.get("n0")?.queued).toBe(1)
        expect(batch.get("n1")?.queued).toBe(0)
      }),
    ))

  test("narrows to nodeIDs and accepts pre-read node rows", async () =>
    run(
      Effect.gen(function* () {
        yield* seed(4)
        const messages = yield* DagMessages.Service
        const all = value(yield* messages.metadataForWorkflow(parent, "wf"))
        const subset = value(yield* messages.metadataForWorkflow(parent, "wf", ["n1", "n3"]))
        expect([...subset.keys()].sort()).toEqual(["n1", "n3"])
        const rows = [
          { id: "n2", workflow_id: "wf", child_session_id: "child2", replan_attempts: 0 },
          { id: "n3", workflow_id: "wf", child_session_id: "child3", replan_attempts: 0 },
        ]
        const preRead = value(yield* messages.metadataForWorkflow(parent, "wf", undefined, rows))
        expect([...preRead.keys()].sort()).toEqual(["n2", "n3"])
        for (const nodeID of ["n2", "n3"]) expect(preRead.get(nodeID)).toEqual(all.get(nodeID))
      }),
    ))

  test("a node caller only sees its own mailbox", async () =>
    run(
      Effect.gen(function* () {
        yield* seed(3)
        const messages = yield* DagMessages.Service
        expect([...value(yield* messages.metadataForWorkflow(child(1), "wf")).keys()]).toEqual(["n1"])
        expect(value(yield* messages.metadataForWorkflow(child(1), "wf", ["n1"])).size).toBe(1)
        expect(value(yield* messages.metadataForWorkflow(child(1), "wf", ["n0"])).size).toBe(0)
        expect(yield* messages.metadataForWorkflow(foreign, "wf")).toEqual({ ok: false, reason: "unauthorized" })
      }),
    ))

  test("SQL count is constant and bounded for 5, 50 and 200 nodes", async () => {
    const measure = (count: number) =>
      run(
        Effect.gen(function* () {
          yield* seed(count)
          const messages = yield* DagMessages.Service
          // Warm the statement cache so the count reflects the read itself.
          value(yield* messages.metadataForWorkflow(parent, "wf", ["n0"]))
          const before = DatabaseMetrics.snapshot().sqlCount
          const batch = value(yield* messages.metadataForWorkflow(parent, "wf"))
          const delta = DatabaseMetrics.snapshot().sqlCount - before
          expect(batch.size).toBe(count)
          return delta
        }),
        `:memory:`,
      )
    const counts = [await measure(5), await measure(50), await measure(200)]
    expect(new Set(counts).size).toBe(1)
    // BEGIN + authorization + node rows + mailbox/snapshot join + message
    // aggregates + COMMIT.
    expect(counts[0]).toBe(6)
  })
})
