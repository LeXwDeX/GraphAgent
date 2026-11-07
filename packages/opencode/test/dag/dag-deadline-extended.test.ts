import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Session } from "@opencode-ai/schema/session"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"

// ============================================================================
// Harness A — full Dag command → event → projector → store (in-memory DB).
// Mirrors dag-escalation-clear-flag.test.ts. Exercises the command-layer guard
// and proves the extension lands as a durable event (not a direct write).
// ============================================================================

function node(id: string, timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...(timeoutMs !== undefined ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

const harness = (() => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
})()

function runTest<A>(
  test: (services: { readonly dag: Dag.Interface; readonly store: DagStore.Interface; readonly db: Database.Interface["db"] }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: Session.ID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(process.cwd()),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      return yield* test({ dag, store, db: database.db })
    }).pipe(
      Effect.provide(harness),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: Project.ID.make("project-1"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

function createWorkflow(dag: Dag.Interface, title: string, nodeID = "a") {
  return dag.create({
    projectID: "project-1",
    sessionID: "ses_parent",
    title,
    config: { name: title, nodes: [node(nodeID)] },
  })
}

// Count durable NodeDeadlineExtended rows in the event log for a node. The
// stored type is versioned (`dag.node.deadline_extended.1`), so match the prefix.
function deadlineExtendedCount(db: Database.Interface["db"], dagID: string, nodeID: string) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID} AND ${EventTable.type} LIKE 'dag.node.deadline_extended.%'`)
      .all()
      .pipe(Effect.orDie)
    return rows.filter((row) => (row.data as { nodeID?: string }).nodeID === nodeID).length
  })
}

// ============================================================================
// Harness B — projector replay (file DB). Mirrors dag-replay-idempotency.
// Proves the deadline survives event-log replay (the direct-write bug fixed).
// ============================================================================

const projectorLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: Session.ID.make("ses_replay"), project_id: Project.ID.global, slug: "replay", directory: "/project", title: "replay", version: "test" }).run().pipe(Effect.orDie)
  })
}

function serializeAndWipe(dagID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID}`)
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    const serialized = rows.map((r) => ({
      id: r.id,
      type: r.type,
      seq: r.seq,
      aggregateID: r.aggregate_id,
      data: r.data,
    }))
    yield* db.delete(EventTable).where(sql`${EventTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.delete(EventSequenceTable).where(sql`${EventSequenceTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`).pipe(Effect.orDie)
    return serialized
  })
}

// ============================================================================
// Tests
// ============================================================================

describe("nodeExtendTimeout command-layer guard (Q3)", () => {
  it("adjudicates a running node: returns 1, appends NodeDeadlineExtended, projector moves the deadline and clears escalation_pending", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-running")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          // Escalate so the adjudication clears a real pending flag.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.escalationPending).toBe(true)
          expect(escalated?.wakeReported).toBe(false)

          // Q2 (ADR-0002): adjudication must follow delivery. The escalation
          // wake is delivered before the main agent re-times — only then may
          // the extension land.
          yield* store.markNodeWakeReported(dagID, "a")

          const written = yield* dag.nodeExtendTimeout(dagID, "a", 99_999)
          // Command sync return: 1 = success (guard 前移, 错误即状态 — the
          // orchestrator observes 1/0/-2 directly, not via the publish chain).
          expect(written).toBe(1)

          // The extension is a durable event now, not a direct write.
          const eventCount = yield* deadlineExtendedCount(db, dagID, "a")
          expect(eventCount).toBe(1)

          // Projector pure fold: deadline moved, adjudication flag cleared,
          // cumulative extension count preserved, wake consumed (harmless no-op
          // once the Q2 gate is in effect).
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("running")
          expect(row?.deadlineMs).toBe(99_999)
          expect(row?.escalationPending).toBe(false)
          expect(row?.wakeReported).toBe(true)
          expect(row?.timeoutExtensions).toBe(1)
        }),
      ),
    )
  })

  it("running-guard rejection is NOT an event: returns 0 and appends nothing when the node already terminalized", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-after-terminal")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          yield* dag.nodeCompleted(dagID, "a", "done")

          const written = yield* dag.nodeExtendTimeout(dagID, "a", 99_999)
          // Guard 拒绝 = 命令同步返回 0（非转移，不入事件日志）。
          expect(written).toBe(0)

          const eventCount = yield* deadlineExtendedCount(db, dagID, "a")
          expect(eventCount).toBe(0)

          // Terminal state untouched.
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("completed")
          expect(row?.deadlineMs).not.toBe(99_999)
        }),
      ),
    )
  })

  it("Q2 delivery gate rejection is NOT an event: returns -2 (NOT 0 — the node is still running) when the escalation wake is undelivered", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-before-delivery")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          // Escalated but NOT yet delivered: escalation_pending ∧ ¬wakeReported.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          const undelivered = yield* store.getNode(dagID, "a")
          expect(undelivered?.escalationPending).toBe(true)
          expect(undelivered?.wakeReported).toBe(false)

          // Defense-in-depth: the command refuses to re-time an escalation the
          // main agent has not seen (primary gate is loop.ts:800). C1: the
          // rejection returns -2, NOT 0 — the node is STILL running, so the
          // caller must keep its watcher (N1). Returning 0 here made the
          // handler kill the watcher on a running node under the T8↔T9
          // interleave.
          const written = yield* dag.nodeExtendTimeout(dagID, "a", 99_999)
          expect(written).toBe(-2)

          const eventCount = yield* deadlineExtendedCount(db, dagID, "a")
          expect(eventCount).toBe(0)

          // State frozen — adjudication cannot precede delivery.
          const row = yield* store.getNode(dagID, "a")
          expect(row?.escalationPending).toBe(true)
          expect(row?.wakeReported).toBe(false)
          expect(row?.deadlineMs).not.toBe(99_999)
        }),
      ),
    )
  })
})

describe("NodeDeadlineExtended projector fold + replay (Q3)", () => {
  it("replay restores the EXTENDED deadline (the direct-write replay bug is abolished)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.descending("dag_replay_extend")

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global, sessionID: Session.ID.make("ses_replay"), title: "extend-replay", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: DagEvent.NodeID.make("a"), name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: DagEvent.NodeID.make("a"), childSessionID: Session.ID.make("ses_child"), deadlineMs: 5_000, wakeEligible: true, timestamp: ts(3) })
        // Escalate, then adjudicate by extending the deadline.
        yield* events.publish(DagEvent.NodeTimeoutEscalated, { dagID, nodeID: DagEvent.NodeID.make("a"), childSessionID: Session.ID.make("ses_child"), timeoutExtensions: 1, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeDeadlineExtended, { dagID, nodeID: DagEvent.NodeID.make("a"), deadlineMs: 99_999, timeoutExtensions: 1, timestamp: ts(5) })

        const before = yield* store.getNode(dagID, "a")
        expect(before?.deadlineMs).toBe(99_999)
        expect(before?.escalationPending).toBe(false)

        // Wipe the read model AND the event log, then rebuild purely from the
        // serialized event stream.
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* store.getNode(dagID, "a")

        // The decisive assertion: under the old direct-write path the deadline
        // reverted to the pre-extension value on replay (no event carried it).
        // With NodeDeadlineExtended in the log, replay restores 99_999.
        expect(replayed?.deadlineMs).toBe(99_999)
        expect(replayed?.escalationPending).toBe(false)
        expect(replayed?.wakeReported).toBe(true)
        expect(replayed?.timeoutExtensions).toBe(1)
      }).pipe(Effect.provide(projectorLayer)),
    )
  })

  it("a stale NodeDeadlineExtended after terminalization is a benign no-op (idempotent fold, status='running' guard)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const dagID = DagEvent.DagID.descending("dag_replay_stale_extend")

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global, sessionID: Session.ID.make("ses_replay"), title: "stale-extend", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: DagEvent.NodeID.make("a"), name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: DagEvent.NodeID.make("a"), childSessionID: Session.ID.make("ses_child"), deadlineMs: 5_000, wakeEligible: true, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeDeadlineExtended, { dagID, nodeID: DagEvent.NodeID.make("a"), deadlineMs: 50_000, timeoutExtensions: 1, timestamp: ts(4) })
        // Node completes AFTER the extension was logged...
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: DagEvent.NodeID.make("a"), output: "done", durationMs: 0, timestamp: ts(5) })
        // ...then a stale/late extension races in (crash-recovery replay order).
        yield* events.publish(DagEvent.NodeDeadlineExtended, { dagID, nodeID: DagEvent.NodeID.make("a"), deadlineMs: 99_999, timeoutExtensions: 1, timestamp: ts(6) })

        const row = yield* store.getNode(dagID, "a")
        // The projector's status='running' WHERE guard means the stale fold is a
        // 0-row benign skip — terminal state is preserved, the late deadline
        // does not resurrect or corrupt the completed node.
        expect(row?.status).toBe("completed")
        expect(row?.deadlineMs).toBe(50_000)
        expect(row?.output).toBe("done")
      }).pipe(Effect.provide(projectorLayer)),
    )
  })
})

describe("extendTimeout dedicated control command (P0-A)", () => {
  it("audit #3/#4: extends an escalated, delivered running node — deadline moves, escalation cleared, attempt + child session + replanAttempts preserved", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-timeout-running")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 500, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          // Q2: adjudication follows delivery.
          yield* store.markNodeWakeReported(dagID, "a")

          const before = yield* store.getNode(dagID, "a")
          const verdict = yield* dag.extendTimeout(dagID, "a", 60_000)
          expect(verdict.status).toBe("extended")
          if (verdict.status !== "extended") return

          const after = yield* store.getNode(dagID, "a")
          // Deadline recomputed from now and landed as ONE durable event.
          expect(after?.deadlineMs).toBe(verdict.deadlineMs)
          expect(verdict.deadlineMs).toBeGreaterThan(Date.now())
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(1)
          // Adjudication consumed the escalation.
          expect(after?.escalationPending).toBe(false)
          expect(after?.wakeReported).toBe(true)
          // audit #4: no restart, no replan attempt, child session preserved.
          expect(after?.status).toBe("running")
          expect(after?.replanAttempts).toBe(before?.replanAttempts)
          expect(after?.replanAttempts).toBe(0)
          expect(after?.childSessionId).toBe("ses_child_1")
          // An extend grants time; it does NOT bump the cumulative extension count.
          expect(after?.timeoutExtensions).toBe(before?.timeoutExtensions)
          expect(yield* dag.extendTimeout(dagID, "a", 60_000)).toEqual({ status: "no_escalation" })
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(1)
        }),
      ),
    )
  })

  it("refuses a running node without a formal escalation before its deadline, no event", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-timeout-healthy")
          yield* dag.nodeQueued(dagID, "a", Date.now() + 120_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 120_000, true)

          const before = yield* store.getNode(dagID, "a")
          const verdict = yield* dag.extendTimeout(dagID, "a", 60_000)
          expect(verdict).toEqual({ status: "no_escalation" })

          const after = yield* store.getNode(dagID, "a")
          expect(after?.deadlineMs).toBe(before?.deadlineMs)
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(0)
        }),
      ),
    )
  })

  it("refuses an elapsed deadline before the watcher publishes a formal escalation", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-timeout-elapsed")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 5000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 1000, true)

          const before = yield* store.getNode(dagID, "a")
          const verdict = yield* dag.extendTimeout(dagID, "a", 30_000)
          expect(verdict).toEqual({ status: "no_escalation" })
          const after = yield* store.getNode(dagID, "a")
          expect(after?.status).toBe("running")
          expect(after?.deadlineMs).toBe(before?.deadlineMs)
          expect(after?.timeoutExtensions).toBe(0)
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(0)
        }),
      ),
    )
  })

  it("Q2 delivery gate: an undelivered escalation is escalation_undelivered, state frozen, no event", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-timeout-undelivered")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 500, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          // NOT delivered: escalation_pending ∧ ¬wakeReported.

          const verdict = yield* dag.extendTimeout(dagID, "a", 60_000)
          expect(verdict).toEqual({ status: "escalation_undelivered" })

          const after = yield* store.getNode(dagID, "a")
          expect(after?.escalationPending).toBe(true)
          expect(after?.wakeReported).toBe(false)
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(0)
        }),
      ),
    )
  })

  it("refuses a delivered escalation at the workflow cap without moving the deadline", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "extend-timeout-cap",
            config: { name: "extend-timeout-cap", max_timeout_extensions: 2, nodes: [node("a")] },
          })
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 500, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          yield* store.markNodeWakeReported(dagID, "a")
          expect((yield* dag.extendTimeout(dagID, "a", 30_000)).status).toBe("extended")

          // The second delivered escalation reaches this workflow's cap. The
          // command must not defer the watcher's terminal verdict by 24 hours.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 2)
          yield* store.markNodeWakeReported(dagID, "a")
          const before = yield* store.getNode(dagID, "a")
          expect(yield* dag.extendTimeout(dagID, "a", 86_400_000)).toEqual({ status: "cap_exhausted" })
          const after = yield* store.getNode(dagID, "a")
          expect(after?.deadlineMs).toBe(before?.deadlineMs)
          expect(after?.timeoutExtensions).toBe(2)
          expect(after?.escalationPending).toBe(true)
          expect(yield* dag.nodeExtendTimeout(dagID, "a", Date.now() + 86_400_000)).toBe(-3)
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(1)
        }),
      ),
    )
  })

  it("not_running: a terminal node and a missing node both refuse extension, no event", async () => {
    await Effect.runPromise(
      runTest(({ dag, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "extend-timeout-terminal")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          yield* dag.nodeCompleted(dagID, "a", "done")

          expect(yield* dag.extendTimeout(dagID, "a", 60_000)).toEqual({ status: "not_running" })
          expect(yield* dag.extendTimeout(dagID, "does-not-exist", 60_000)).toEqual({ status: "not_running" })
          expect(yield* deadlineExtendedCount(db, dagID, "a")).toBe(0)
        }),
      ),
    )
  })
})
