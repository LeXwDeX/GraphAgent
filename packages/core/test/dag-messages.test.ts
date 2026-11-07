import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "../src/database/database"
import { DagMessages } from "../src/dag/messages"
import { tmpdir } from "./fixture/tmpdir"

const parent = { projectID: "p", directory: process.cwd(), sessionID: "parent" }
const child = { ...parent, sessionID: "child" }
const foreign = { ...parent, sessionID: "foreign" }
const layer = (filename = ":memory:") => {
  const db = Database.layerFromPath(filename)
  return Layer.merge(db, DagMessages.layer.pipe(Layer.provide(db)))
}
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | DagMessages.Service>, filename?: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
  )
  for (const id of ["parent", "child", "foreign"])
    yield* db.run(
      sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},'p',${id === "child" ? "parent" : null},${id},${process.cwd()},${id},'test',1,1)`,
    )
  yield* db.run(
    sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated) VALUES ('wf','p','parent',${process.cwd()},'W','running','{}',1,1,1)`,
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
function persist(snapshot: DagMessages.Snapshot, text?: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const m of snapshot.messages) {
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${m.transcriptID},${m.recipient.sessionID},1,1,'{}') ON CONFLICT(id) DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${m.partID},${m.transcriptID},${m.recipient.sessionID},1,1,${JSON.stringify({ type: "text", text: text ?? DagMessages.renderMessage(m) })}) ON CONFLICT(id) DO NOTHING`,
      )
    }
  }).pipe(Effect.orDie)
}

describe("durable DAG agent mailboxes", () => {
  test("identifies the authorized caller without creating a mailbox", async () =>
    run(Effect.gen(function* () {
      yield* seed
      const messages = yield* DagMessages.Service
      const { db } = yield* Database.Service
      const parentEndpoint = value(yield* messages.identify(parent))
      const childEndpoint = value(yield* messages.identify(child, "wf"))
      expect(parentEndpoint).toMatchObject({ kind: "main", sessionID: "parent" })
      expect(childEndpoint).toMatchObject({ kind: "node", sessionID: "child", workflowID: "wf", attemptID: "child:0" })
      expect(value(yield* messages.identify(child))).toEqual(childEndpoint)
      expect(yield* messages.identify(foreign, "wf")).toEqual({ ok: false, reason: "unauthorized" })
      expect(yield* messages.identify({ ...child, projectID: "wrong" })).toEqual({ ok: false, reason: "unauthorized" })
      expect(yield* messages.identify({ ...child, directory: "/wrong" })).toEqual({ ok: false, reason: "unauthorized" })
      expect((yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM agent_mailbox`))?.n).toBe(0)
      expect(value(yield* messages.identify(child)).id).toBe(childEndpoint.id)
      yield* db.run(sql`UPDATE session SET parent_id = 'foreign' WHERE id = 'child'`)
      expect(yield* messages.identify(child)).toEqual({ ok: false, reason: "unauthorized" })
      expect(yield* messages.receive(child)).toEqual({ ok: false, reason: "unauthorized" })
      yield* db.run(sql`UPDATE session SET parent_id = 'parent' WHERE id = 'child'`)
      yield* db.run(sql`UPDATE workflow_node SET status = 'queued' WHERE id = 'n'`)
      expect(yield* messages.identify(child)).toEqual({ ok: false, reason: "unauthorized" })
      yield* db.run(sql`UPDATE workflow_node SET status = 'running' WHERE id = 'n'`)
      value(yield* messages.send(parent, request()))
      yield* db.run(sql`UPDATE workflow_node SET child_session_id = NULL, replan_attempts = 1 WHERE id = 'n'`)
      expect(yield* messages.identify(child)).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(Effect.orDie)))

  test("only the authenticated owner can fail an orphaned current attempt", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        yield* db.run(sql`DELETE FROM session WHERE id = 'child'`)
        const guard = { workflowID: "wf", nodeID: "n", attemptID: DagMessages.nodeAttemptID("child", 0) }
        expect(yield* messages.guard(foreign, { ...guard, failureReason: "exec_failed" }, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.guard(child, { ...guard, failureReason: "exec_failed" }, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.guard(parent, { ...guard, attemptID: "child:1", failureReason: "exec_failed" }, Effect.void)).toEqual({ ok: false, reason: "stale_attempt" })
        expect(yield* messages.guard(parent, guard, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.guard(parent, { ...guard, failureReason: "exec_failed", close: false }, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.guard(parent, { ...guard, failureReason: "exec_failed", expectedAcceptedRevision: 1 }, Effect.void)).toEqual({ ok: false, reason: "stale_input" })
        value(yield* messages.guard(parent, { ...guard, failureReason: "exec_failed" }, db.run(sql`UPDATE workflow_node SET status = 'failed' WHERE id = 'n'`).pipe(Effect.orDie)))
        expect((yield* db.get<{ status: string }>(sql`SELECT status FROM workflow_node WHERE id = 'n'`))?.status).toBe("failed")
        expect(value(yield* messages.metadata(parent, "wf", "n", guard.attemptID)).closedReason).toBe("exec_failed")
      }),
    ))
  test("cross-worktree endpoints use durable parent and current child identities", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const workspace = path.join(process.cwd(), "linked-worktree")
        const worker = { ...child, directory: workspace }
        yield* db.run(sql`UPDATE session SET directory = ${workspace} WHERE id = 'child'`)
        yield* db.run(sql`UPDATE workflow_node SET directory = ${workspace} WHERE id = 'n'`)

        const inbound = value(yield* messages.send(parent, request()))
        expect(value(yield* messages.receive(worker)).map((m) => m.id)).toEqual([inbound.id])
        const frozen = value(yield* messages.freeze(worker, "turn"))
        expect(yield* messages.associate(worker, frozen.id)).toEqual({ ok: false, reason: "unassociated" })
        yield* persist(frozen)
        expect(value(yield* messages.associate(worker, frozen.id)).associated).toBe(true)
        const outbound = value(yield* messages.send(worker, {
          workflowID: "wf", idempotencyKey: "reply", content: "result", replyTo: inbound.id,
        }))
        expect(value(yield* messages.receive(parent)).map((m) => m.id)).toEqual([outbound.id])
        const capture = yield* messages.guard(worker, {
          workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: frozen.id, close: false,
        }, Effect.succeed("captured"))
        expect(value(capture)).toBe("captured")
        expect(yield* messages.guard({ ...worker, directory: parent.directory }, {
          workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: frozen.id,
        }, Effect.void)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.send({ ...worker, projectID: "other" }, {
          workflowID: "wf", idempotencyKey: "foreign", content: "no",
        })).toEqual({ ok: false, reason: "unauthorized" })
        yield* db.run(sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('other',${workspace},'[]',1,1)`)
        yield* db.run(sql`UPDATE session SET project_id = 'other' WHERE id = 'child'`)
        expect(yield* messages.freeze({ ...worker, projectID: "other" }, "foreign-project")).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.send(parent, request("foreign-project"))).toEqual({ ok: false, reason: "closed" })
        yield* db.run(sql`UPDATE session SET project_id = 'p' WHERE id = 'child'`)
        yield* db.run(sql`UPDATE session SET parent_id = 'foreign' WHERE id = 'child'`)
        expect(yield* messages.freeze(worker, "wrong-parent")).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.send(parent, request("wrong-parent"))).toEqual({ ok: false, reason: "closed" })
        yield* db.run(sql`UPDATE session SET parent_id = 'parent' WHERE id = 'child'`)
        yield* db.run(sql`UPDATE workflow_node SET directory = ${workspace + "-other"} WHERE id = 'n'`)
        expect(yield* messages.freeze(worker, "wrong-binding")).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.send(parent, request("wrong-binding"))).toEqual({ ok: false, reason: "closed" })
        yield* db.run(sql`UPDATE workflow_node SET directory = ${workspace} WHERE id = 'n'`)
        yield* db.run(sql`UPDATE session SET directory = ${workspace} WHERE id = 'parent'`)
        expect(yield* messages.freeze(worker, "wrong-owner")).toEqual({ ok: false, reason: "unauthorized" })
        yield* db.run(sql`UPDATE session SET directory = ${parent.directory} WHERE id = 'parent'`)
        yield* db.run(sql`UPDATE workflow_node SET superseded = 1 WHERE id = 'n'`)
        expect(yield* messages.freeze(worker, "superseded")).toEqual({ ok: false, reason: "unauthorized" })
        yield* db.run(sql`UPDATE workflow_node SET superseded = 0, replan_attempts = 1 WHERE id = 'n'`)
        expect(yield* messages.guard(worker, {
          workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: frozen.id,
        }, Effect.void)).toEqual({ ok: false, reason: "stale_attempt" })
        yield* messages.reconcile(worker)
        expect(value(yield* messages.metadata(parent, "wf", "n", request().attemptID)).closedReason).toBe("attempt_replaced")
        const next = value(yield* messages.freeze(worker, "next-turn"))
        value(yield* messages.associate(worker, next.id))
        expect(value(yield* messages.guard(worker, {
          workflowID: "wf", nodeID: "n", attemptID: DagMessages.nodeAttemptID("child", 1), snapshotID: next.id,
        }, Effect.succeed("settled")))).toBe("settled")
      }),
    ))
  test("a replaced child cannot reopen its historical mailbox as a main session", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        value(yield* messages.send(parent, request()))
        yield* db.run(sql`UPDATE workflow_node SET child_session_id = NULL, replan_attempts = 1 WHERE id = 'n'`)
        expect(yield* messages.freeze(child, "stale")).toEqual({ ok: false, reason: "unauthorized" })
        yield* messages.reconcile(child)
        expect(value(yield* messages.metadata(parent, "wf", "n", request().attemptID)).closedReason).toBe("attempt_replaced")
      }),
    ))
  test("a restarted node cannot authorize its previous child while pending or queued", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        for (const status of ["pending", "queued"]) {
          yield* db.run(sql`UPDATE workflow_node SET status = ${status}, replan_attempts = 1 WHERE id = 'n'`)
          expect(yield* messages.freeze(child, status)).toEqual({ ok: false, reason: "unauthorized" })
          expect(yield* messages.send(child, { workflowID: "wf", idempotencyKey: status, content: "old" })).toEqual({
            ok: false,
            reason: "unauthorized",
          })
        }
      }),
    ))
  test("separate processes claim one durable result nudge and reopen preserves exhaustion", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "nudge.sqlite")
    await run(seed, filename)
    const worker = path.join(import.meta.dirname, "fixture/dag-messages-race.ts")
    const outcomes = await Promise.all(
      [0, 1].map(async () => {
        const process = Bun.spawn([Bun.which("bun")!, "run", worker, filename, "nudge"], {
          cwd: child.directory,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, output, error] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ])
        expect(code, error).toBe(0)
        const result: DagMessages.Result<boolean> = JSON.parse(output)
        return value(result)
      }),
    )
    expect(outcomes.sort((a, b) => Number(a) - Number(b))).toEqual([false, true])
    await run(
      Effect.gen(function* () {
        const messages = yield* DagMessages.Service
        expect(value(yield* messages.claimResultNudge(child, 0))).toBe(false)
        value(yield* messages.send(parent, request()))
        expect(value(yield* messages.claimResultNudge(child, 1))).toBe(true)
        expect(value(yield* messages.claimResultNudge(child, 1))).toBe(false)
      }),
      filename,
    )
  })
  for (const ordering of ["accept-before-claim", "accept-after-spent-claim"] as const)
    test(`conditional retry exhaustion preserves new input: ${ordering}`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const messages = yield* DagMessages.Service
          const { db } = yield* Database.Service
          value(yield* messages.claimResultNudge(child, 0))
          if (ordering === "accept-before-claim") value(yield* messages.send(parent, request()))
          const claim = yield* messages.claimResultNudge(child, 0)
          expect(claim).toEqual(
            ordering === "accept-before-claim" ? { ok: false, reason: "stale_input" } : { ok: true, value: false },
          )
          if (ordering === "accept-after-spent-claim") value(yield* messages.send(parent, request()))
          const result = yield* messages.guard(
            child,
            {
              workflowID: "wf",
              nodeID: "n",
              attemptID: request().attemptID!,
              failureReason: "exec_failed",
              expectedAcceptedRevision: 0,
            },
            db.run(sql`UPDATE workflow_node SET status = 'failed' WHERE id = 'n'`).pipe(Effect.orDie),
          )
          expect(result).toEqual({ ok: false, reason: "stale_input" })
          expect(
            (yield* db.get<{ status: string }>(sql`SELECT status FROM workflow_node WHERE id = 'n'`))?.status,
          ).toBe("running")
          expect(value(yield* messages.receive(child))[0].state).toBe("queued")
        }),
      ))
  test("conditional retry exhaustion closes its unchanged revision atomically", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        value(yield* messages.send(parent, request()))
        value(
          yield* messages.guard(
            child,
            {
              workflowID: "wf",
              nodeID: "n",
              attemptID: request().attemptID!,
              failureReason: "exec_failed",
              expectedAcceptedRevision: 1,
            },
            db.run(sql`UPDATE workflow_node SET status = 'failed' WHERE id = 'n'`).pipe(Effect.orDie),
          ),
        )
        expect((yield* db.get<{ status: string }>(sql`SELECT status FROM workflow_node WHERE id = 'n'`))?.status).toBe(
          "failed",
        )
        expect(value(yield* messages.receive(child))[0]).toMatchObject({
          state: "undeliverable",
          reason: "exec_failed",
        })
      }),
    ))
  test("result nudge claims enforce authority, revision, and persisted stop boundaries", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        expect(yield* messages.claimResultNudge(parent, 0)).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* messages.claimResultNudge({ ...child, directory: "foreign" }, 0)).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        expect(yield* messages.claimResultNudge(child, -1)).toEqual({ ok: false, reason: "invalid" })
        expect(yield* messages.claimResultNudge(child, 1)).toEqual({ ok: false, reason: "stale_input" })
        const boundary = value(yield* messages.freeze(child, "budget"))
        yield* messages.markStopped(child, boundary.id, "budget_exhausted")
        expect(yield* messages.claimResultNudge(child, 0)).toEqual({ ok: false, reason: "stopped" })
        yield* messages.closeWorkflow("wf", "cancelled")
        expect(yield* messages.claimResultNudge(child, 0)).toEqual({ ok: false, reason: "closed" })
      }),
    ))
  test("latest snapshot includes unassociated preparation input with exact caller ownership", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        expect(value(yield* messages.latestSnapshot(child))).toBeUndefined()
        const consumed = value(yield* messages.freeze(child, "consumed"))
        value(yield* messages.associate(child, consumed.id))
        value(yield* messages.send(parent, request()))
        const latest = value(yield* messages.freeze(child, "preparation"))
        yield* messages.markStopped(child, latest.id, "preparation_failed")
        yield* db.run(
          sql`UPDATE agent_input_snapshot SET time_created = CASE WHEN id = ${latest.id} THEN 0 ELSE 999999 END`,
        )
        expect(value(yield* messages.latestSnapshot(child))).toMatchObject({
          id: latest.id,
          associated: false,
          stopReason: "preparation_failed",
        })
        expect(value(yield* messages.revisions(child)).snapshotID).toBe(consumed.id)
        expect(value(yield* messages.receive(child))[0].state).toBe("queued")
        expect(value(yield* messages.latestSnapshot(parent))).toBeUndefined()
        expect(value(yield* messages.latestSnapshot({ ...parent, sessionID: "foreign" }))).toBeUndefined()
        expect(yield* messages.latestSnapshot({ ...child, projectID: "foreign" })).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        expect(yield* messages.latestSnapshot({ ...child, directory: process.cwd() + "-foreign" })).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        yield* db.run(sql`UPDATE workflow_node SET replan_attempts = 1 WHERE id = 'n'`)
        expect(value(yield* messages.latestSnapshot(child))).toBeUndefined()
      }),
    ))
  test("hard interruption upgrades a clean budget boundary and cannot be downgraded", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const snapshot = value(yield* messages.freeze(child, "boundary"))
        value(yield* messages.associate(child, snapshot.id))
        yield* messages.markStopped(child, snapshot.id, "budget_exhausted")
        yield* messages.markStopped(child, snapshot.id, "cancelled")
        yield* messages.markStopped(child, snapshot.id, "budget_exhausted")
        expect(value(yield* messages.snapshotByID(child, snapshot.id))?.stopReason).toBe("cancelled")
        expect(
          yield* messages.guard(
            child,
            { workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: snapshot.id },
            Effect.void,
          ),
        ).toEqual({ ok: false, reason: "stopped" })
      }),
    ))
  test("failed workflow fence rolls back control and mailbox outcomes together", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        value(yield* messages.send(parent, request()))
        const failure = yield* Effect.exit(
          messages.fenceWorkflow(
            "wf",
            "cancelled",
            Effect.gen(function* () {
              yield* db.run(sql`UPDATE workflow SET status = 'cancelled' WHERE id = 'wf'`)
              yield* Effect.fail(new Error("projection failure"))
            }),
          ),
        )
        expect(Exit.isFailure(failure)).toBe(true)
        expect(yield* db.get(sql`SELECT status FROM workflow WHERE id = 'wf'`)).toEqual({ status: "running" })
        expect(value(yield* messages.receive(child))[0].state).toBe("queued")
      }),
    ))
  test("latest consumed turn remains deterministic when snapshots share a millisecond", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const first = value(yield* messages.freeze(child, "first"))
        value(yield* messages.associate(child, first.id))
        const next = value(yield* messages.freeze(child, "next"))
        value(yield* messages.associate(child, next.id))
        yield* messages.markStopped(child, next.id, "budget_exhausted")
        yield* db.run(sql`UPDATE agent_input_snapshot SET time_created = 1`)
        const latest = value(yield* messages.revisions(child))
        expect(latest.snapshotID).toBe(next.id)
        expect(value(yield* messages.snapshotByID(child, latest.snapshotID!))?.stopReason).toBe("budget_exhausted")
      }),
    ))
  for (const reason of ["turn_blocked", "model_error", "cancelled"])
    test(`stopped input cannot capture or complete (${reason})`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const messages = yield* DagMessages.Service
          const snap = value(yield* messages.freeze(child, "stop"))
          value(yield* messages.associate(child, snap.id))
          yield* messages.markStopped(child, snap.id, reason)
          const input = { workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: snap.id }
          expect(yield* messages.guard(child, input, Effect.void)).toEqual({ ok: false, reason: "stopped" })
          expect(yield* messages.guard(child, { ...input, close: false }, Effect.void)).toEqual({
            ok: false,
            reason: "stopped",
          })
          value(yield* messages.guard(child, { ...input, failureReason: reason }, Effect.void))
        }),
      ))
  test("a clean final step may settle its same snapshot at the budget boundary", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        value(yield* messages.send(parent, request()))
        const snap = value(yield* messages.freeze(child, "final"))
        yield* persist(snap)
        value(yield* messages.associate(child, snap.id))
        yield* messages.markStopped(child, snap.id, "budget_exhausted")
        value(
          yield* messages.guard(
            child,
            { workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: snap.id },
            Effect.void,
          ),
        )
        expect(value(yield* messages.revisions(child)).closedReason).toBe("completed")
      }),
    ))
  test("missing snapshot ledger content is corruption and never silently delivered", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const m = value(yield* messages.send(parent, request()))
        const snap = value(yield* messages.freeze(child, "missing"))
        yield* db.run(sql`DELETE FROM agent_message WHERE id = ${m.id}`)
        expect(Exit.isFailure(yield* Effect.exit(messages.associate(child, snap.id)))).toBe(true)
        expect(yield* db.get(sql`SELECT associated FROM agent_input_snapshot WHERE id = ${snap.id}`)).toEqual({
          associated: 0,
        })
      }),
    ))
  test("budget rejection ends queued input without closing an ordinary parent mailbox", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        value(yield* m.send(child, { workflowID: "wf", idempotencyKey: "old", content: "finding" }))
        yield* m.discardPending(parent, "budget_exhausted")
        expect(value(yield* m.receive(parent))[0]).toMatchObject({ state: "undeliverable", reason: "budget_exhausted" })
        expect(value(yield* m.receive(parent, { queuedOnly: true }))).toEqual([])
        value(yield* m.send(child, { workflowID: "wf", idempotencyKey: "new", content: "later" }))
        expect(value(yield* m.receive(parent, { queuedOnly: true, limit: 1 }))[0].content).toBe("later")
        const frozen = value(yield* m.freeze(parent, "parent-turn"))
        expect(value(yield* m.snapshotForTurn(parent, "parent-turn"))).toEqual(frozen)
        expect(value(yield* m.snapshotForTurn(parent, "absent"))).toBeUndefined()
        expect(yield* m.pendingRecipients({ ...parent, afterSessionID: "parent" })).toEqual([])
        expect((yield* m.pendingRecipients(parent)).map((x) => x.sessionID)).toEqual(["parent"])
      }),
    ))
  test("separate processes order acceptance against settlement at SQLite", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "race.sqlite")
    await run(seed, filename)
    const worker = path.join(import.meta.dirname, "fixture/dag-messages-race.ts")
    const processes = ["send", "complete"].map((action) =>
      Bun.spawn([process.execPath, "run", worker, filename, action], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const outcomes = await Promise.all(
      processes.map(async (p) => {
        const [code, out, err] = await Promise.all([
          p.exited,
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ])
        expect(code, err).toBe(0)
        const parsed: DagMessages.Result<unknown> = JSON.parse(out)
        return parsed
      }),
    )
    expect(outcomes.filter((x) => x.ok)).toHaveLength(1)
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const node = (yield* db.get<{ status: string }>(sql`SELECT status FROM workflow_node WHERE id = 'n'`))!
        const count = (yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM agent_message`))!.n
        if (outcomes[0].ok) {
          expect(outcomes[1]).toEqual({ ok: false, reason: "stale_input" })
          expect(node.status).toBe("running")
          expect(count).toBe(1)
        } else {
          expect(outcomes[0]).toEqual({ ok: false, reason: "closed" })
          expect(node.status).toBe("completed")
          expect(count).toBe(0)
        }
      }),
      filename,
    )
  }, 15000)

  test("rejects foreign session, project/directory impersonation and peer sends", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        expect(yield* m.send({ ...parent, sessionID: "foreign" }, request())).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        expect(yield* m.send({ ...parent, projectID: "other" }, request())).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        expect(yield* m.send({ ...parent, directory: "/elsewhere" }, request())).toEqual({
          ok: false,
          reason: "unauthorized",
        })
        expect(yield* m.send(child, request())).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* m.send(parent, { ...request(), attemptID: undefined })).toEqual({
          ok: false,
          reason: "stale_attempt",
        })
      }),
    ))

  test("retry IDs and original destination are stable; changed content or attempt conflicts", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const accepted = value(yield* m.send(parent, request()))
        expect(value(yield* m.send(parent, request()))).toEqual(accepted)
        expect(yield* m.send(parent, request("key", "changed"))).toEqual({ ok: false, reason: "conflict" })
        expect(yield* m.send(parent, { ...request(), attemptID: DagMessages.nodeAttemptID("new", 1) })).toEqual({
          ok: false,
          reason: "conflict",
        })
        expect(value(yield* m.revisions(child)).accepted).toBe(1)
        const { db } = yield* Database.Service
        yield* db.run(sql`UPDATE workflow SET session_id = 'foreign' WHERE id = 'wf'`)
        expect(yield* m.send(parent, request())).toEqual({ ok: false, reason: "unauthorized" })
      }),
    ))

  test("concurrent acceptance is durably sequenced and receive does not deliver", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const sent = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => m.send(parent, request(`k${i}`))),
          { concurrency: "unbounded" },
        )
        expect(
          sent
            .map(value)
            .map((x) => x.recipientSequence)
            .sort((a, b) => a - b),
        ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        const inbox = value(yield* m.receive(child, { limit: 3, afterSequence: 2 }))
        expect(inbox.map((x) => x.recipientSequence)).toEqual([3, 4, 5])
        expect(inbox.every((x) => x.state === "queued")).toBe(true)
        expect(value(yield* m.revisions(child)).queued).toBe(8)
      }),
    ))

  test("freezing is stable, delivered requires exact durable parts, late input stays queued", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        yield* m.send(parent, request())
        const frozen = value(yield* m.freeze(child, "turn"))
        expect(value(yield* m.freeze(child, "turn"))).toEqual(frozen)
        expect(yield* m.associate(child, frozen.id)).toEqual({ ok: false, reason: "unassociated" })
        yield* persist(frozen)
        yield* m.send(parent, request("late", "next turn"))
        const associated = value(yield* m.associate(child, frozen.id))
        expect(associated.revision).toBe(1)
        expect(associated.messages[0].state).toBe("delivered")
        expect(value(yield* m.revisions(child))).toMatchObject({ accepted: 2, snapshot: 1, queued: 1, delivered: 1 })
        expect(value(yield* m.freeze(child, "next")).messages).toHaveLength(1)
      }),
    ))

  test("a persisted part with different content is not delivery proof", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        yield* m.send(parent, request())
        const frozen = value(yield* m.freeze(child, "turn"))
        yield* persist(frozen, "other text")
        expect(yield* m.associate(child, frozen.id)).toEqual({ ok: false, reason: "unassociated" })
        expect(value(yield* m.revisions(child)).queued).toBe(1)
      }),
    ))

  test("acceptance wins: old snapshot cannot capture/complete; next input continues", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const old = value(yield* m.freeze(child, "old"))
        yield* m.associate(child, old.id)
        yield* m.send(parent, request())
        const commit = db
          .run(sql`UPDATE workflow_node SET status = 'completed' WHERE workflow_id = 'wf' AND id = 'n'`)
          .pipe(Effect.orDie)
        const guard = { workflowID: "wf", nodeID: "n", attemptID: request().attemptID!, snapshotID: old.id }
        expect(yield* m.guard(child, guard, commit)).toEqual({ ok: false, reason: "stale_input" })
        const next = value(yield* m.freeze(child, "next"))
        yield* persist(next)
        yield* m.associate(child, next.id)
        value(yield* m.guard(child, { ...guard, snapshotID: next.id, close: false }, Effect.void))
        expect(value(yield* m.send(parent, request("still-open"))).state).toBe("queued")
        expect(yield* m.guard(child, { ...guard, snapshotID: next.id }, commit)).toEqual({
          ok: false,
          reason: "stale_input",
        })
        const last = value(yield* m.freeze(child, "last"))
        yield* persist(last)
        yield* m.associate(child, last.id)
        value(yield* m.guard(child, { ...guard, snapshotID: last.id }, commit))
        expect(yield* m.send(parent, request("too-late"))).toEqual({ ok: false, reason: "closed" })
      }),
    ))

  test("completion wins on legacy rev zero and closed retries return original evidence", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        value(yield* m.guard(child, { workflowID: "wf", nodeID: "n", attemptID: request().attemptID! }, Effect.void))
        expect(yield* m.send(parent, request())).toEqual({ ok: false, reason: "closed" })
      }),
    ))

  test("failed settlement rolls back closure and nested transaction effects", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const commit = db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`UPDATE workflow_node SET status = 'completed' WHERE id = 'n'`)
            return yield* Effect.fail("injected failure")
          }),
        )
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              m.guard(child, { workflowID: "wf", nodeID: "n", attemptID: request().attemptID! }, commit),
            ),
          ),
        ).toBe(true)
        expect((yield* db.get<{ status: string }>(sql`SELECT status FROM workflow_node WHERE id = 'n'`))!.status).toBe(
          "running",
        )
        expect(value(yield* m.send(parent, request())).state).toBe("queued")
      }),
    ))

  test("parent receives source message after source completes and ordinary workflow ends", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const out = { workflowID: "wf", idempotencyKey: "out", content: "finding" }
        const accepted = value(yield* m.send(child, out))
        value(
          yield* m.guard(
            child,
            { workflowID: "wf", nodeID: "n", attemptID: request().attemptID! },
            db.run(sql`UPDATE workflow_node SET status = 'completed' WHERE id = 'n'`).pipe(Effect.orDie),
          ),
        )
        yield* db.run(sql`UPDATE workflow SET status = 'completed' WHERE id = 'wf'`)
        yield* m.closeWorkflow("wf", "completed")
        expect(value(yield* m.receive(parent))[0].id).toBe(accepted.id)
        expect(value(yield* m.receive(parent))[0].state).toBe("queued")
        expect(value(yield* m.send(child, out)).id).toBe(accepted.id)
        const frozen = value(yield* m.freeze(parent, "parent-next"))
        yield* persist(frozen)
        yield* m.associate(parent, frozen.id)
        expect(value(yield* m.revisions(parent)).delivered).toBe(1)
      }),
    ))

  test("explicit parent closure orders acceptance and preserves terminal delivery reason", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const out = { workflowID: "wf", idempotencyKey: "out", content: "finding" }
        const accepted = value(yield* m.send(child, out))
        yield* m.closeSession("parent", "detached")
        expect(value(yield* m.send(child, out))).toMatchObject({
          id: accepted.id,
          state: "undeliverable",
          reason: "detached",
        })
        expect(yield* m.send(child, { ...out, idempotencyKey: "new" })).toEqual({ ok: false, reason: "closed" })
      }),
    ))

  test("latestMessageAt authorizes workflow scope in the same transaction", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const latest = messages.latestMessageAt!
        expect(yield* latest(parent, "wf")).toEqual({ ok: true, value: undefined })
        value(yield* messages.send(parent, request()))
        expect(value(yield* latest(child, "wf"))).toBeGreaterThan(0)
        expect(yield* latest(parent, "missing")).toEqual({ ok: false, reason: "unauthorized" })
        expect(yield* latest(foreign, "wf")).toEqual({ ok: false, reason: "unauthorized" })
      }),
    ))

  test("replaced attempt is never retargeted and historical metadata remains readable", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        const { db } = yield* Database.Service
        const accepted = value(yield* m.send(parent, request()))
        yield* db.run(sql`UPDATE workflow_node SET replan_attempts = 1 WHERE id = 'n'`)
        yield* m.reconcile(child)
        expect(value(yield* m.send(parent, request()))).toMatchObject({
          id: accepted.id,
          state: "undeliverable",
          reason: "attempt_replaced",
        })
        expect(yield* m.send(parent, request("new"))).toEqual({ ok: false, reason: "stale_attempt" })
        expect(value(yield* m.metadata(parent, "wf", "n", request().attemptID))).toMatchObject({
          undeliverable: 1,
          closedReason: "attempt_replaced",
        })
        expect(value(yield* m.receive(child))).toEqual([])
        yield* db.run(sql`UPDATE workflow_node SET child_session_id = NULL, status = 'pending' WHERE id = 'n'`)
        expect(value(yield* m.metadata(parent, "wf", "n", request().attemptID))).toMatchObject({
          undeliverable: 1,
          closedReason: "attempt_replaced",
        })
      }),
    ))

  test("bounded payload/queue rejects explicitly and duplicate does not consume capacity", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        expect(yield* m.send(parent, request("long", "界".repeat(6000)))).toEqual({ ok: false, reason: "invalid" })
        for (let i = 0; i < 64; i++) value(yield* m.send(parent, request(`k${i}`)))
        expect(yield* m.send(parent, request("overflow"))).toEqual({ ok: false, reason: "capacity" })
        expect(value(yield* m.send(parent, request("k0"))).recipientSequence).toBe(1)
        expect(value(yield* m.revisions(child)).accepted).toBe(64)
      }),
    ))

  test("acceptance and unassociated delivery intent survive process reopen with stable IDs", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "messages.sqlite")
    let first!: DagMessages.Snapshot
    await run(
      Effect.gen(function* () {
        yield* seed
        const m = yield* DagMessages.Service
        yield* m.send(parent, request())
        first = value(yield* m.freeze(child, "turn"))
        yield* persist(first)
      }),
      filename,
    )
    await run(
      Effect.gen(function* () {
        const m = yield* DagMessages.Service
        expect(value(yield* m.freeze(child, "turn"))).toEqual(first)
        expect(value(yield* m.send(parent, request())).id).toBe(first.messages[0].id)
        expect(value(yield* m.revisions(child)).queued).toBe(1)
        yield* m.associate(child, first.id)
      }),
      filename,
    )
    await run(
      Effect.gen(function* () {
        const m = yield* DagMessages.Service
        expect(value(yield* m.freeze(child, "turn")).associated).toBe(true)
        expect(value(yield* m.send(parent, request()))).toMatchObject({
          id: first.messages[0].id,
          state: "delivered",
          snapshotID: first.id,
        })
        expect(value(yield* m.revisions(child))).toMatchObject({ accepted: 1, delivered: 1, queued: 0 })
      }),
      filename,
    )
  })
})
