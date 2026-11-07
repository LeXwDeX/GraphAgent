import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Session } from "@opencode-ai/schema/session"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"

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
  test: (services: { readonly dag: Dag.Interface; readonly store: DagStore.Interface }) => Effect.Effect<A, Error>,
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
      return yield* test({ dag, store })
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

function createWorkflow(dag: Dag.Interface, title: string, timeoutMs?: number, nodeID = "a") {
  return dag.create({
    projectID: "project-1",
    sessionID: "ses_parent",
    title,
    config: { name: title, nodes: [node(nodeID, timeoutMs)] },
  })
}

// Drive a node to a running+escalated state: escalation_pending=true,
// wake_reported=false (re-armed), timeout_extensions=1. Every clear-flag test
// starts from here so the subsequent assertion proves the flag actually moved.
function escalate(dag: Dag.Interface, dagID: string) {
  return Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
    yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
    yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
  })
}

describe("escalation_pending clears on terminal/cancel transitions (Q1)", () => {
  it("clears escalation_pending when an escalated node completes", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "clear-on-completed", 60_000)
          yield* escalate(dag, dagID)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.status).toBe("running")
          expect(escalated?.escalationPending).toBe(true)

          yield* dag.nodeCompleted(dagID, "a", "done")

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("completed")
          // Q1: a dead node has no adjudication to await — clear the flag.
          expect(row?.escalationPending).toBe(false)
        }),
      ),
    )
  })

  it("clears escalation_pending when an escalated node fails", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "clear-on-failed", 60_000)
          yield* escalate(dag, dagID)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.escalationPending).toBe(true)

          yield* dag.nodeFailed(dagID, "a", "provider exploded", "exec_failed")

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.escalationPending).toBe(false)
        }),
      ),
    )
  })

  it("clears escalation_pending when an escalated node is cancelled (cancel = adjudication)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "clear-on-cancelled", 60_000)
          yield* escalate(dag, dagID)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.escalationPending).toBe(true)

          yield* dag.nodeCancelled(dagID, "a")

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.errorReason).toBe("cancelled via replan")
          expect(row?.escalationPending).toBe(false)
        }),
      ),
    )
  })

  it("clears escalation_pending when an escalated node is skipped", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "clear-on-skipped", 60_000)
          yield* escalate(dag, dagID)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.escalationPending).toBe(true)

          yield* dag.nodeSkipped(dagID, "a", "condition_false")

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("skipped")
          expect(row?.escalationPending).toBe(false)
        }),
      ),
    )
  })
})

describe("two-flag orthogonality: clearing escalation_pending does not suppress wake_reported (Q1)", () => {
  it("re-arms wake_reported on completion of an escalated node so its result is re-delivered", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "orthogonal-completed", 60_000)
          yield* escalate(dag, dagID)
          // The escalation wake was delivered to the main agent.
          yield* store.markNodeWakeReported(dagID, "a")
          const delivered = yield* store.getNode(dagID, "a")
          expect(delivered?.escalationPending).toBe(true)
          expect(delivered?.wakeReported).toBe(true)

          yield* dag.nodeCompleted(dagID, "a", "done")

          const row = yield* store.getNode(dagID, "a")
          // Q1 clears the adjudication flag...
          expect(row?.escalationPending).toBe(false)
          // ...without touching the delivery flag's independent behavior: the
          // F2b re-arm keeps the result wake pending so the adjudicated node's
          // completion is still delivered (falsifier: an escalated-then-
          // completed node must re-enter the wake snapshot).
          expect(row?.wakeReported).toBe(false)
          const unreported = yield* store.getUnreportedWakeNodes("ses_parent")
          expect(unreported.map((candidate) => candidate.id)).toContain("a")
        }),
      ),
    )
  })
})

describe("existing clear-flag points not regressed (Q1)", () => {
  it("NodeRestarted and NodeStarted still clear escalation_pending from a prior escalation", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "regression-started-restarted", 60_000)
          yield* escalate(dag, dagID)
          const escalated = yield* store.getNode(dagID, "a")
          expect(escalated?.escalationPending).toBe(true)

          // NodeRestarted (running→pending) clears the flag — a new attempt is
          // not awaiting adjudication.
          yield* dag.nodeRestarted(dagID, "a", "ses_child_2")
          const restarted = yield* store.getNode(dagID, "a")
          expect(restarted?.status).toBe("pending")
          expect(restarted?.escalationPending).toBe(false)

          // NodeStarted (pending→running) clears again on the fresh attempt.
          yield* dag.nodeStarted(dagID, "a", "ses_child_2", Date.now() + 60_000, true)
          const started = yield* store.getNode(dagID, "a")
          expect(started?.status).toBe("running")
          expect(started?.escalationPending).toBe(false)
        }),
      ),
    )
  })
})

describe("replay/recovery consistency: clear-flag survives event reordering (Q1)", () => {
  it("a stale escalation landing after a terminal event does not resurrect escalation_pending", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "replay-stale-escalation", 60_000)
          yield* escalate(dag, dagID)
          // The node terminalizes (clearing the flag), THEN a stale escalate
          // from the watcher fiber races in afterwards.
          yield* dag.nodeFailed(dagID, "a", "provider exploded", "exec_failed")
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 2).pipe(Effect.ignore)

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          // The F2a running-guard rejects the stale escalate (0 rows), so the
          // terminal clear-flag state is the replay-consistent truth.
          expect(row?.escalationPending).toBe(false)
          expect(row?.timeoutExtensions).toBe(1)
        }),
      ),
    )
  })
})
