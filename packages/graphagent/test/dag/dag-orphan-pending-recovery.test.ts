// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Option } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { ReconcileDecide } from "@/dag/runtime/reconcile-decide"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess } from "@/session/engine-process"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

const ORPHAN_REASON = "orphan pending workflow recovered at startup"

function orphanRecoveryLayer(input: { promptCalls: string[] }) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status, AgentScheduler.defaultLayer)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    create: Effect.fn("test.Session.create")((_value?: unknown) => Effect.sync(() => ({}) as never)),
    get: Effect.fn("test.Session.get")(() => Effect.succeed({} as never)),
    messages: Effect.fn("test.Session.messages")(() => Effect.succeed([])),
  })
  const prompt = mockSessionPrompt(
    withIdleAdmission({
      cancel: Effect.fn("test.SessionPrompt.cancel")(() => Effect.void),
      prompt: Effect.fn("test.SessionPrompt.prompt")(() => {
        input.promptCalls.push("prompt")
        return Effect.never
      }),
      deliver: () => Effect.succeed(Option.none()),
    }),
  )
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.merge(base, loop)
}

function runOrphanRecovery<A>(
  test: (services: {
    dag: Dag.Interface
    database: Database.Interface
    loop: DagLoop.Interface
    events: EventV2.Interface
    store: DagStore.Interface
    promptCalls: string[]
  }) => Effect.Effect<A, Error>,
) {
  const promptCalls: string[] = []
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const database = yield* Database.Service
    const loop = yield* DagLoop.Service
    const events = yield* EventV2.Service
    const store = yield* DagStore.Service
    return yield* test({ dag, database, loop, events, store, promptCalls })
  }).pipe(
    Effect.provide(orphanRecoveryLayer({ promptCalls })),
    Effect.provideService(InstanceRef, {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )
}

function seedProjectAndSession(database: Database.Interface) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: "ses_parent1" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd() as never,
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/**
 * The row an older version left behind: created longer ago than the grace period
 * (`ORPHAN_PENDING_GRACE_MS`), which the reconciler waits out before it disposes
 * of a `pending` workflow (ADR-0008 decision 6, row 8). `Dag.create` is one
 * transaction now, so the tests fake the age of the row, not a crash.
 */
function backdate(
  database: Database.Interface,
  dagID: string,
  ageMs = ReconcileDecide.ORPHAN_PENDING_GRACE_MS + 1_000,
) {
  return database.db
    .run(sql`UPDATE workflow SET time_created = ${Date.now() - ageMs} WHERE id = ${dagID}`)
    .pipe(Effect.orDie, Effect.asVoid)
}

// Publish the exact durable prefix Dag.create would write, then stop before
// WorkflowStarted — simulating a process crash between the create transactions.
function publishInterruptedCreate(
  events: EventV2.Interface,
  dagID: DagEvent.DagID,
  ts: DateTime.Utc,
  nodeCount: number,
  directory = process.cwd(),
) {
  return Effect.gen(function* () {
    yield* events.publish(DagEvent.WorkflowCreated, {
      dagID,
      projectID: "project-1" as never,
      sessionID: "ses_parent1" as never,
      title: "Orphan",
      config: JSON.stringify({ name: "orphan", nodes: [] }),
      status: "pending",
      timestamp: ts,
      directory,
    })
    for (let i = 1; i <= nodeCount; i++) {
      yield* events.publish(DagEvent.NodeRegistered, {
        dagID,
        nodeID: `n${i}` as never,
        name: `Node ${i}`,
        workerType: "build",
        dependsOn: [],
        required: true,
        timestamp: ts,
      })
    }
  })
}

describe("DagLoop orphan pending recovery", () => {
  it("terminalizes a pending workflow whose create crashed before WorkflowStarted", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store, promptCalls }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 2)
          yield* backdate(database, dagID)
          const logged = database.db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, dagID))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.map((row) => row.type.replace(/\.\d+$/, ""))),
            )
          const created = (yield* logged).length

          const failures: Array<{ reason: string }> = []
          const unsubscribe = yield* events.listen((event) =>
            event.type === DagEvent.WorkflowFailed.type
              ? Effect.sync(() => failures.push(event.data as never))
              : Effect.void,
          )

          yield* loop.init()
          // Listener fan-out is async-ordered relative to publish (never rely
          // on it having run by the time init returns) — wait for the durable
          // failure to surface before unsubscribing.
          yield* pollWithTimeout(
            Effect.sync(() => (failures.some((f) => f.reason === ORPHAN_REASON) ? failures : undefined)),
            "WorkflowFailed recovery reason was not observed",
          )
          yield* unsubscribe

          const wf = yield* store.getWorkflow(dagID)
          expect(wf?.status).toBe("failed")
          expect((yield* store.getNodes(dagID)).map((n) => n.status)).toEqual(["skipped", "skipped"])
          expect(failures).toContainEqual(expect.objectContaining({ reason: ORPHAN_REASON }))
          // ADR-0008 Amendment 3, 4b-C: the terminalization is one command, so the log holds the two legs back to back
          // and then the nodes it ends. The WorkflowStarted for the legalizing leg is committed together with the
          // failure, so the first-wave handler (reconcileAfter) finds the workflow failed and no node is scheduled
          // on a dead workflow.
          expect((yield* logged).slice(created)).toEqual([
            DagEvent.WorkflowStarted.type,
            DagEvent.WorkflowFailed.type,
            DagEvent.NodeSkipped.type,
            DagEvent.NodeSkipped.type,
          ])
          expect(promptCalls).toEqual([])
        }),
      ),
    )
  })

  // ADR-0008 decisions 4 and 6: failing the orphan is a runner write, so the runner claims the workflow
  // first, writes under that claim, and gives it back once the workflow ended (nothing would renew it).
  it("terminalizes the orphan under a lease claim of its own, and gives the claim back", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 1)
          yield* backdate(database, dagID)
          const lease = () =>
            database.db.get<{ runner_id: string; epoch: number; expires_at: number }>(
              sql`SELECT runner_id, epoch, expires_at FROM dag_runner WHERE dag_id = ${dagID}`,
            )
          expect(yield* lease()).toBeUndefined()

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
          const row = yield* lease()
          expect(row).toMatchObject({ runner_id: EngineProcess.runner.id, epoch: 1 })
          // Given back: expired now, so a runner that reopens the workflow does not wait out a TTL.
          expect(row?.expires_at).toBeLessThanOrEqual(Date.now())
        }),
      ),
    )
  })

  it("leaves an orphan alone while another runner holds a live lease on it", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store, promptCalls }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 1)
          yield* backdate(database, dagID)
          // Somebody drives it: this runner may not terminalize what it does not hold.
          yield* database.db.run(
            sql`INSERT INTO dag_runner (dag_id, runner_id, epoch, expires_at) VALUES (${dagID}, '99:other', 1, ${Date.now() + 3_600_000})`,
          )

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")
          expect((yield* store.getNode(dagID, "n1"))?.status).toBe("pending")
          const row = yield* database.db.get<{ runner_id: string; epoch: number }>(
            sql`SELECT runner_id, epoch FROM dag_runner WHERE dag_id = ${dagID}`,
          )
          expect(row).toEqual({ runner_id: "99:other", epoch: 1 })
          expect(promptCalls).toEqual([])
        }),
      ),
    )
  })

  it("terminalizes a zero-node orphan pending workflow", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 0)
          yield* backdate(database, dagID)

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
        }),
      ),
    )
  })

  // ADR-0008 decision 6, row 9: a `pending` row is an orphan only once the grace period is over. `Dag.create`
  // is one transaction, so such a row comes from an older version; a writer that is still at it is not interrupted.
  it("leaves a young pending workflow alone: nothing is claimed, failed or scheduled within the grace period", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store, promptCalls }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 2)
          // Five seconds short of the end of the grace period.
          yield* backdate(database, dagID, ReconcileDecide.ORPHAN_PENDING_GRACE_MS - 5_000)

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")
          expect((yield* store.getNodes(dagID)).map((n) => n.status)).toEqual(["pending", "pending"])
          // Not even claimed: it is not this runner's to dispose of yet.
          expect(
            yield* database.db.get(sql`SELECT dag_id FROM dag_runner WHERE dag_id = ${dagID}`).pipe(Effect.orDie),
          ).toBeUndefined()
          expect(promptCalls).toEqual([])
        }),
      ),
    )
  })

  // An owner-less (empty-directory) row has no owner under `ownsWorkflow`, which fails closed, so no instance
  // would ever dispose of it: the reconciler treats a `pending` one as its own. Its location is unusable, which
  // ends it at once (row 4), as the sweep that came before the reconciler did.
  it("disposes of an owner-less pending workflow (an empty directory stamp) without waiting for the grace period", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store, promptCalls }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 1, "")
          expect((yield* store.getWorkflow(dagID))?.directory).toBe("")

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
          expect(yield* store.getWorkflowFailureReason?.(dagID) ?? Effect.succeed(undefined)).toContain(
            "workspace_invalid",
          )
          expect(promptCalls).toEqual([])
        }),
      ),
    )
  })

  it("leaves a pending workflow with a non-pending node untouched", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          const ts = yield* DateTime.now
          yield* publishInterruptedCreate(events, dagID, ts, 1)
          yield* backdate(database, dagID)
          // A node that already progressed proves the workflow was adopted and
          // mid-flight — the defensive criterion must not terminalize it.
          yield* events.publish(DagEvent.NodeStarted, {
            dagID,
            nodeID: "n1" as never,
            childSessionID: "ses_child1" as never,
            timestamp: yield* DateTime.now,
          })

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")
          expect((yield* store.getNode(dagID, "n1"))?.status).toBe("running")
        }),
      ),
    )
  })
})
