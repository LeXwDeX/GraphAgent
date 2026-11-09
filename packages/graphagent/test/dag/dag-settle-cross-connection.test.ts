// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Database as NativeDatabase } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { layer as sqliteLayer } from "@graphagent/core/database/sqlite.bun"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Dag } from "@/dag/dag"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { EventV2Bridge } from "@/event-v2-bridge"

describe("Dag settlement transaction fence", () => {
  it("records recovery failure for an orphaned running attempt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-orphan-fence-"))
    try {
      const sqlite = sqliteLayer({ filename: path.join(dir, "orphan.sqlite") })
      const database = Database.layer.pipe(Layer.provide(sqlite))
      const persistence = Layer.mergeAll(database, EventV2.defaultLayer, DagProjector.defaultLayer, DagStore.defaultLayer,
        EventV2Bridge.defaultLayer, DagMessages.layer.pipe(Layer.provide(database)))
      const layer = Layer.mergeAll(sqlite, persistence, Dag.layer.pipe(Layer.provide(persistence)))
      await Effect.runPromise(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        yield* db.run(sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`)
        yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_orphan_owner','p',NULL,'ses_orphan_owner',${process.cwd()},'Owner','test',1,1)`)
        const dagID = yield* dag.create({ projectID: "p", sessionID: "ses_orphan_owner", title: "orphan", config: {
          name: "orphan", nodes: [{ id: "n", name: "n", worker_type: "build", depends_on: [], required: true, prompt_template: { inline: "work" } }],
        } })
        yield* dag.nodeQueued(dagID, "n", Date.now() + 60_000)
        yield* dag.nodeStarted(dagID, "n", "ses_missing", Date.now() + 60_000)
        const caller = { projectID: "p", directory: process.cwd(), sessionID: "ses_orphan_owner" }
        const guard = { workflowID: dagID, nodeID: "n", attemptID: DagMessages.nodeAttemptID("ses_missing", 0) }
        expect(yield* messages.guard(caller, guard, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.guard(caller, { ...guard, attemptID: "ses_missing:1", failureReason: "exec_failed" }, Effect.void)).toEqual({ ok: false, reason: "stale_attempt" })
        expect(yield* messages.guard({ ...caller, directory: "/foreign" }, { ...guard, failureReason: "exec_failed" }, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        const recovered = yield* reconcileWorkflow(dagID, () => Effect.succeed("unknown"))
        expect(recovered.reconciled).toBe(1)
        expect((yield* dag.store.getNode(dagID, "n"))?.status).toBe("failed")
      }).pipe(Effect.provide(layer), Effect.scoped))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it("holds the durable write lock across revision reads and terminal writes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-settle-fence-"))
    const file = path.join(dir, "fence.sqlite")
    try {
      const sqlite = sqliteLayer({ filename: file })
      const database = Database.layer.pipe(Layer.provide(sqlite))
      const messages = DagMessages.layer.pipe(Layer.provide(database))
      const layer = Layer.mergeAll(sqlite, database, messages)

      const program = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const mailbox = yield* DagMessages.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* db.run(
          sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_parent','p',NULL,'ses_parent',${process.cwd()},'Parent','test',1,1)`,
        )
        yield* db.run(
          sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES ('wf','p','ses_parent',${process.cwd()},'{"kind":"none"}','Fence','running','{}',0,1,1)`,
        )

        const fenced = yield* mailbox
          .fenceWorkflow(
            "wf",
            undefined,
            Effect.gen(function* () {
              const row = yield* db.get<{ graph_rev: number }>(sql`SELECT graph_rev FROM workflow WHERE id = 'wf'`)
              expect(row?.graph_rev).toBe(1)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkScoped)

        yield* Deferred.await(entered)
        const other = new NativeDatabase(file)
        try {
          // A short busy timeout keeps the synchronous check from hanging the
          // only JS thread while the fenced transaction holds its lock.
          other.run("PRAGMA busy_timeout = 1")
          // A second connection cannot write between the fence's revision read
          // and its terminal write.
          expect(() => other.run("UPDATE workflow SET title = 'other' WHERE id = 'wf'")).toThrow()
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(fenced)
          // After the immediate transaction commits, the second connection can
          // write again.
          other.run("UPDATE workflow SET title = 'other' WHERE id = 'wf'")
          expect(other.query("SELECT title FROM workflow WHERE id = 'wf'").get()).toEqual({ title: "other" })
        } finally {
          other.close()
        }
      })

      await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("re-checks the durable owner inside the real settlement path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-settle-owner-"))
    const file = path.join(dir, "fence.sqlite")
    try {
      const sqlite = sqliteLayer({ filename: file })
      const database = Database.layer.pipe(Layer.provide(sqlite))
      const persistence = Layer.mergeAll(
        database,
        EventV2.defaultLayer,
        DagProjector.defaultLayer,
        DagStore.defaultLayer,
        EventV2Bridge.defaultLayer,
        DagMessages.layer.pipe(Layer.provide(database)),
      )
      const layer = Layer.mergeAll(sqlite, persistence, Dag.layer.pipe(Layer.provide(persistence)))

      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const dag = yield* Dag.Service
          yield* db.run(
            sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
          )
          yield* db.run(
            sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_settle_owner','p',NULL,'ses_settle_owner',${process.cwd()},'Owner','test',1,1)`,
          )
          yield* db.run(
            sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_child','p','ses_settle_owner','ses_child',${process.cwd()},'Child','test',1,1)`,
          )
          const dagID = yield* dag.create({
            projectID: "p",
            sessionID: "ses_settle_owner",
            title: "owner",
            config: {
              name: "owner",
              nodes: [
                {
                  id: "required",
                  name: "required",
                  worker_type: "build",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "work" },
                },
              ],
            },
          })
          yield* dag.nodeQueued(dagID, "required", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "required", "ses_child", Date.now() + 60_000)
          yield* dag.nodeCompleted(dagID, "required", "done")

          // SessionEvent.Moved re-stamps the durable directory before the
          // waiting instance reaches settlement.
          const other = new NativeDatabase(file)
          try {
            other.run("UPDATE workflow SET directory = '/moved' WHERE id = ?", [dagID])
          } finally {
            other.close()
          }

          const settled = yield* dag.settleCompletion(dagID, {
            owner: { projectID: "p", directory: process.cwd() },
          })
          expect(settled.status).toBe("ignored")
          expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
