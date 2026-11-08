import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect"
import { Database } from "../src/database/database"
import { DagMessages } from "../src/dag/messages"

const parent = { projectID: "p", directory: process.cwd(), sessionID: "parent" }
const child = { ...parent, sessionID: "child" }
const layer = (filename = ":memory:") => {
  const db = Database.layerFromPath(filename)
  return Layer.merge(db, DagMessages.layer.pipe(Layer.provide(db)))
}
const run = <A, E>(
  effect: Effect.Effect<A, E, Database.Service | DagMessages.Service | Scope.Scope>,
  filename?: string,
) => Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
  )
  for (const id of ["parent", "child"])
    yield* db.run(
      sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},'p',${id === "child" ? "parent" : null},${id},${process.cwd()},${id},'test',1,1)`,
    )
  yield* db.run(
    sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES ('wf','p','parent',${process.cwd()},'{"kind":"none"}','W','running','{}',1,1,1)`,
  )
  yield* db.run(
    sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('n','wf','N','task','running','[]','child',1,1,1)`,
  )
}).pipe(Effect.orDie)
const value = <A>(r: DagMessages.Result<A>): A => {
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(r.reason)
  return r.value
}
const request = (key = "key", content = "context"): DagMessages.Send => ({
  workflowID: "wf",
  nodeID: "n",
  attemptID: DagMessages.nodeAttemptID("child", 0),
  idempotencyKey: key,
  content,
})
function persist(snapshot: DagMessages.Snapshot) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const m of snapshot.messages) {
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${m.transcriptID},${m.recipient.sessionID},1,1,'{}') ON CONFLICT(id) DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${m.partID},${m.transcriptID},${m.recipient.sessionID},1,1,${JSON.stringify({ type: "text", text: DagMessages.renderMessage(m) })}) ON CONFLICT(id) DO NOTHING`,
      )
    }
  }).pipe(Effect.orDie)
}
/** Subscribe before the mutations under test; the stream has no replay. */
const record = (messages: DagMessages.Interface) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DagMessages.Change>()
    yield* messages.changed.pipe(
      Stream.runForEach((change) => Queue.offer(queue, change)),
      Effect.forkScoped,
    )
    yield* Effect.sleep("10 millis")
    return queue
  })
const drain = (queue: Queue.Queue<DagMessages.Change>) =>
  Effect.gen(function* () {
    yield* Effect.sleep("10 millis")
    const changes: DagMessages.Change[] = []
    for (;;) {
      const item = yield* Queue.poll(queue)
      if (Option.isNone(item)) return changes
      changes.push(item.value)
    }
  })

describe("DagMessages.changed", () => {
  test("send publishes one queued change after commit; a duplicate send is a no-op", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const queue = yield* record(m)

        const sent = value(yield* m.send(parent, request()))
        expect(sent.state).toBe("queued")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "queued",
            mailboxVersion: 1,
          },
        ])
        expect(
          yield* db.get<{ revision: number; change_seq: number }>(
            sql`SELECT revision,change_seq FROM agent_mailbox WHERE session_id = 'child'`,
          ),
        ).toEqual({ revision: 1, change_seq: 1 })

        // Idempotent replay returns the original message without touching the mailbox.
        value(yield* m.send(parent, request()))
        expect(yield* drain(queue)).toEqual([])
        expect(
          yield* db.get<{ revision: number; change_seq: number }>(
            sql`SELECT revision,change_seq FROM agent_mailbox WHERE session_id = 'child'`,
          ),
        ).toEqual({ revision: 1, change_seq: 1 })
      }),
    ))

  test("main mailbox changes omit workflowID and route by the parent directory", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(child, { workflowID: "wf", idempotencyKey: "result", content: "done" }))
        const changes = yield* drain(queue)
        expect(changes).toEqual([
          {
            recipientSessionID: "parent",
            directory: process.cwd(),
            kind: "queued",
            mailboxVersion: 1,
          },
        ])
        expect("workflowID" in changes[0]).toBe(false)
        expect("nodeID" in changes[0]).toBe(false)
      }),
    ))

  test("associate publishes delivered exactly once for a child session", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        const frozen = value(yield* m.freeze(child, "turn"))
        yield* persist(frozen)
        const associated = value(yield* m.associate(child, frozen.id))
        expect(associated.messages[0].state).toBe("delivered")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "queued",
            mailboxVersion: 1,
          },
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "delivered",
            mailboxVersion: 2,
          },
        ])

        // The snapshot is already associated: replaying the call changes nothing.
        value(yield* m.associate(child, frozen.id))
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("associate from the parent session publishes delivered for the main mailbox", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(child, { workflowID: "wf", idempotencyKey: "result", content: "done" }))
        const frozen = value(yield* m.freeze(parent, "turn"))
        yield* persist(frozen)
        value(yield* m.associate(parent, frozen.id))
        expect(yield* drain(queue)).toEqual([
          {
            recipientSessionID: "parent",
            directory: process.cwd(),
            kind: "queued",
            mailboxVersion: 1,
          },
          {
            recipientSessionID: "parent",
            directory: process.cwd(),
            kind: "delivered",
            mailboxVersion: 2,
          },
        ])
      }),
    ))

  test("discardPending publishes undeliverable once and only when it releases input", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        yield* m.discardPending(child, "cancelled")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "queued",
            mailboxVersion: 1,
          },
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "undeliverable",
            mailboxVersion: 2,
          },
        ])

        // Nothing queued anywhere: neither call commits a change.
        yield* m.discardPending(child, "cancelled")
        yield* m.discardPending(parent, "cancelled")
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("workflow fence closes each live mailbox exactly once", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        yield* drain(queue)
        expect(yield* m.fenceWorkflow("wf", "completed", Effect.succeed("done"))).toBe("done")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 2,
          },
        ])

        expect(yield* m.fenceWorkflow("wf", "completed", Effect.succeed("done"))).toBe("done")
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("closeSession and closeWorkflow publish one closed change per mailbox", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        value(yield* m.send(child, { workflowID: "wf", idempotencyKey: "result", content: "done" }))
        yield* drain(queue)

        yield* m.closeSession("child", "session_deleted")
        yield* m.closeSession("parent", "session_deleted")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 2,
          },
          // closeSession materializes and closes a main-identity tombstone for
          // the session even when that session only ever had a node mailbox.
          {
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 1,
          },
          {
            recipientSessionID: "parent",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 2,
          },
        ])

        // Every mailbox is already closed and empty: repeat calls are no-ops.
        yield* m.closeSession("child", "session_deleted")
        yield* m.closeSession("parent", "session_deleted")
        yield* m.closeWorkflow("wf", "cancelled")
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("closeWorkflow publishes one closed change per workflow mailbox", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        yield* drain(queue)
        yield* m.closeWorkflow("wf", "cancelled")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 2,
          },
        ])
        yield* m.closeWorkflow("wf", "cancelled")
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("reconcile closes a stale attempt exactly once", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        yield* drain(queue)
        // The live attempt is left open.
        yield* m.reconcile(parent)
        expect(yield* drain(queue)).toEqual([])
        yield* db.run(sql`UPDATE workflow_node SET status = 'completed' WHERE id = 'n'`)
        yield* m.reconcile(parent)
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 2,
          },
        ])
        yield* m.reconcile(parent)
        expect(yield* drain(queue)).toEqual([])
      }),
    ))

  test("a rolled-back transaction publishes nothing", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const queue = yield* record(m)

        const guard = { workflowID: "wf", nodeID: "n", attemptID: request().attemptID! }
        const failed = yield* Effect.exit(m.guard(child, guard, Effect.fail(new Error("injected failure"))))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* drain(queue)).toEqual([])
        // The mailbox creation and the close claim were rolled back together.
        expect(
          yield* db.get<{ closed_reason: string | null }>(
            sql`SELECT closed_reason FROM agent_mailbox WHERE session_id = 'child'`,
          ),
        ).toBeUndefined()

        value(yield* m.guard(child, guard, Effect.succeed("ok")))
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: process.cwd(),
            kind: "closed",
            mailboxVersion: 1,
          },
        ])
      }),
    ))

  test("guard close:false keeps the mailbox open and publishes nothing", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const queue = yield* record(m)

        value(
          yield* m.guard(
            child,
            {
              workflowID: "wf",
              nodeID: "n",
              attemptID: request().attemptID!,
              failureReason: "exec_failed",
              close: false,
            },
            Effect.void,
          ),
        )
        expect(yield* drain(queue)).toEqual([])
        expect(value(yield* m.send(parent, request("still-open"))).state).toBe("queued")
        expect((yield* drain(queue)).map((change) => change.kind)).toEqual(["queued"])
      }),
    ))

  test("events carry the recipient session directory for cross-worktree mailboxes", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const workspace = path.join(process.cwd(), "linked-worktree")
        yield* db.run(sql`UPDATE session SET directory = ${workspace} WHERE id = 'child'`)
        yield* db.run(sql`UPDATE workflow_node SET directory = ${workspace} WHERE id = 'n'`)
        const queue = yield* record(m)

        value(yield* m.send(parent, request()))
        yield* m.closeSession("child", "session_deleted")
        expect(yield* drain(queue)).toEqual([
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: workspace,
            kind: "queued",
            mailboxVersion: 1,
          },
          {
            workflowID: "wf",
            nodeID: "n",
            recipientSessionID: "child",
            directory: workspace,
            kind: "closed",
            mailboxVersion: 2,
          },
          {
            recipientSessionID: "child",
            directory: workspace,
            kind: "closed",
            mailboxVersion: 1,
          },
        ])
      }),
    ))
})
