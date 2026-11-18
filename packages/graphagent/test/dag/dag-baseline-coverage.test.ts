// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, parseWorkflowConfig, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
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

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function setup(sessionID: string, directory = "/project") {
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
        directory: AbsolutePath.make(directory),
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function create(dag: Dag.Interface, sessionID: string, nodes: NodeConfig[], overrides: Partial<WorkflowConfig> = {}) {
  return dag.create({
    projectID: Project.ID.global,
    sessionID,
    title: sessionID,
    config: { name: sessionID, nodes, ...overrides },
  })
}

function start(dag: Dag.Interface, dagID: string, nodeID: string, childSessionID: string) {
  return Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, nodeID, Date.now() + 60_000)
    yield* dag.nodeStarted(dagID, nodeID, childSessionID, Date.now() + 60_000)
  })
}

function setWorkflowStatus(dagID: string, status: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowTable)
      .set({ status })
      .where(eq(WorkflowTable.id, dagID))
      .run()
      .pipe(Effect.orDie)
  })
}

function setNodeReplanAttempts(dagID: string, nodeID: string, attempts: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowNodeTable)
      .set({ replan_attempts: attempts })
      .where(and(eq(WorkflowNodeTable.workflow_id, dagID), eq(WorkflowNodeTable.id, nodeID)))
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

/**
 * Runs `action` just before the `nth` read made after `arm()`: the gap between
 * a command's first read and the guard that acts on it.
 */
function readHook(nth: number, action: Effect.Effect<void, never, Database.Service>) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    let armed = false
    let reads = 0
    return {
      arm: () => {
        armed = true
        reads = 0
      },
      before: <A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.suspend(() =>
          armed && ++reads === nth
            ? Effect.andThen(action.pipe(Effect.provideService(Database.Service, database)), read)
            : read,
        ),
    }
  })
}

describe("DAG baseline branch coverage", () => {
  it.effect("pauseForCheckpoint classifies terminal, pending, paused and running workflows", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_pause_checkpoint"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])

      expect(yield* dag.pauseForCheckpoint(dagID, 1)).toBe("paused")
      expect(yield* dag.pauseForCheckpoint(dagID, 1)).toBe("paused")

      yield* setWorkflowStatus(dagID, "completed")
      expect(yield* dag.pauseForCheckpoint(dagID, 2)).toBe("inactive")

      yield* setWorkflowStatus(dagID, "pending")
      expect(yield* dag.pauseForCheckpoint(dagID, 3)).toBe("inactive")
    }),
  )

  it.effect("failUnrecoverable takes the pending->running leg before failing", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_fail_unrecoverable"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* setWorkflowStatus(dagID, "pending")
      // EventV2 deduplicates an adjacent event with the same type and payload
      // hash. The test clock is frozen, so advance it before re-publishing
      // WorkflowStarted; otherwise the byte-identical event from `create` is
      // dropped and the row never leaves pending.
      yield* TestClock.adjust("1 millis")

      const verdict = yield* dag.failUnrecoverable(dagID, "workspace_missing: pending")
      expect(verdict).toBe("failed")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("failed")
    }),
  )

  it.effect("exclusive serializes an external critical section with guarded commands", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_exclusive"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const exclusive = yield* dag
        .exclusive(
          dagID,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      // A guarded command on the same workflow waits for the external section
      // to release the per-workflow mutex.
      const paused = yield* dag.pause(dagID, "budget_exhausted").pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(exclusive)
      yield* Fiber.join(paused)
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("paused")
    }),
  )

  it.effect("rejects replacing a node whose current definition is unavailable", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_replan_unavailable"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service
      const dagID = yield* create(dag, sessionID, [node("a"), node("b")])
      yield* dag.nodeQueued(dagID, "b", Date.now() + 60_000)

      const config = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)!
      yield* db
        .update(WorkflowTable)
        .set({ config: JSON.stringify({ ...config, nodes: config.nodes.filter((entry) => entry.id !== "b") }) })
        .where(eq(WorkflowTable.id, dagID))
        .run()

      const failure = yield* dag.replan(dagID, { nodes: [node("b")] }).pipe(Effect.flip)
      expect(failure.message).toContain('Node "b" is queued, but its current execution definition is unavailable')
    }),
  )

  it.effect("fails restarts that reached the replan attempt ceiling instead of restarting", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_replan_ceiling"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")], { max_node_replan_attempts: 0 })
      yield* start(dag, dagID, "n", "ses_baseline_replan_ceiling_child")

      const result = yield* dag.replan(dagID, { nodes: [{ ...node("n"), restart: true }] })
      expect(result.restart).toEqual([])
      const row = yield* dag.store.getNode(dagID, "n")
      expect(row?.status).toBe("failed")
      expect(row?.errorReason).toBe("replan attempt ceiling exceeded")
    }),
  )

  it.effect("honors a restarted node's stored replan attempt count", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_replan_ceiling_rows"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* start(dag, dagID, "n", "ses_baseline_replan_ceiling_rows_child")
      yield* setNodeReplanAttempts(dagID, "n", 99)

      const result = yield* dag.replan(dagID, { nodes: [{ ...node("n"), restart: true }] })
      expect(result.restart).toEqual([])
      expect((yield* dag.store.getNode(dagID, "n"))?.errorReason).toBe("replan attempt ceiling exceeded")
    }),
  )

  it.effect("rejects fenced extends whose writer is missing or no longer pending", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_extend_fence"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* start(dag, dagID, "n", "ses_baseline_extend_fence_child")

      const missing = yield* dag
        .extend(dagID, [node("m")], { nodeID: "missing", attempt: { replanAttempts: 0 } })
        .pipe(Effect.flip)
      expect(missing.message).toContain("Node not found: missing")

      const stale = yield* dag
        .extend(dagID, [node("m")], { nodeID: "n", attempt: { replanAttempts: 0 } })
        .pipe(Effect.flip)
      expect(stale.name).toBe("StaleNodeAttemptError")
    }),
  )

  it.effect("rejects extends that would silently cancel pending nodes under an unparseable config", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_extend_config"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service
      const dagID = yield* create(dag, sessionID, [node("n")])

      yield* db.update(WorkflowTable).set({ config: "not-json" }).where(eq(WorkflowTable.id, dagID)).run()
      const failure = yield* dag.extend(dagID, [node("m")]).pipe(Effect.flip)
      expect(failure.message).toContain("Cannot extend: workflow config is unparseable")
    }),
  )

  it.effect("rejects extends on failed workflows with the immutable denial", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_extend_archived"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* setWorkflowStatus(dagID, "failed")

      const failure = yield* dag.extend(dagID, [node("m")]).pipe(Effect.flip)
      expect(failure.message).toContain("failed and cancelled workflows are immutable")
    }),
  )

  it.effect("rejects cancelling missing or terminal nodes", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_cancel_guards"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* start(dag, dagID, "n", "ses_baseline_cancel_guards_child")
      yield* dag.nodeCompleted(dagID, "n", "done")

      const missing = yield* dag.nodeCancelled(dagID, "missing").pipe(Effect.flip)
      expect(missing.message).toContain("Node not found: missing")

      const terminal = yield* dag.nodeCancelled(dagID, "n").pipe(Effect.flip)
      expect(terminal.name).toBe("TerminalViolationError")
    }),
  )

  it.effect("records conflicting worktree paths on completion", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_worktree_conflicts"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n1"), node("n2")])
      yield* start(dag, dagID, "n1", "ses_baseline_conflict_n1")
      yield* start(dag, dagID, "n2", "ses_baseline_conflict_n2")

      yield* dag.nodeCompleted(dagID, "n1", "one", undefined, undefined, {
        directory: "/worktrees/n1",
        touchedPaths: ["a.txt", "b.txt"],
        state: "kept",
        conflictsWith: [],
      })
      yield* dag.nodeCompleted(dagID, "n2", "two", undefined, undefined, {
        directory: "/worktrees/n2",
        touchedPaths: ["b.txt"],
        state: "kept",
        conflictsWith: [],
      })

      const second = yield* dag.store.getNode(dagID, "n2")
      expect(second?.worktreeState).toBe("kept")
      expect(second?.touchedPaths).toEqual(["b.txt"])
      expect(second?.worktreeConflictsWith).toEqual(["n1"])
    }),
  )

  it.effect("records no conflicts when the sibling listing is unavailable on an isolated completion", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_worktree_listing"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n1"), node("n2")])
      yield* start(dag, dagID, "n1", "ses_baseline_listing_n1")
      yield* start(dag, dagID, "n2", "ses_baseline_listing_n2")
      yield* dag.nodeCompleted(dagID, "n1", "one", undefined, undefined, {
        directory: "/worktrees/n1",
        touchedPaths: ["a.txt", "b.txt"],
        state: "kept",
        conflictsWith: [],
      })

      // The conflict report is advisory: a failing sibling listing must not
      // block the completion that carries it.
      const degraded = yield* dagOverStore(() => ({
        getCurrentNodes: () => Effect.die(new Error("sibling listing unavailable")),
      }))
      yield* degraded.nodeCompleted(dagID, "n2", "two", undefined, undefined, {
        directory: "/worktrees/n2",
        touchedPaths: ["b.txt"],
        state: "kept",
        conflictsWith: [],
      })

      const second = yield* dag.store.getNode(dagID, "n2")
      expect(second?.status).toBe("completed")
      expect(second?.touchedPaths).toEqual(["b.txt"])
      expect(second?.worktreeConflictsWith).toEqual([])
    }),
  )

  it.effect("reports not_running when the node terminalizes between extendTimeout's read and its re-time", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_extend_race"
      const child = "ses_baseline_extend_race_child"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* dag.nodeQueued(dagID, "n", Date.now() - 1000)
      yield* dag.nodeStarted(dagID, "n", child, Date.now() + 60_000, true)
      yield* dag.nodeTimeoutEscalated(dagID, "n", child, 1)
      yield* markNodeWakeReported(store, dagID, "n")

      // extendTimeout reads the node, then nodeExtendTimeout reads it again
      // before writing. Another writer completes the node in between.
      const hook = yield* readHook(2, setNodeStatus(dagID, "n", "completed"))
      const racing = yield* dagOverStore((real) => ({
        getNode: (id, nodeID) => hook.before(real.getNode(id, nodeID)),
      }))
      hook.arm()

      expect(yield* racing.extendTimeout(dagID, "n", 60_000)).toEqual({ status: "not_running" })
      expect((yield* store.getNode(dagID, "n"))?.status).toBe("completed")
    }),
  )

  it.effect("failUnrecoverable ignores a workflow that terminalizes between its read and its transition", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_fail_unrecoverable_race"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])

      // The workflow's directory does not exist, so the command goes on to fail
      // it; a concurrent cancel lands before that transition is guarded.
      const hook = yield* readHook(2, setWorkflowStatus(dagID, "cancelled"))
      const racing = yield* dagOverStore((real) => ({ getWorkflow: (id) => hook.before(real.getWorkflow(id)) }))
      hook.arm()

      expect(yield* racing.failUnrecoverable(dagID, "workspace_missing: gone")).toBe("ignored")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("cancelled")
    }),
  )

  it.effect("settleCompletion ignores a workflow that terminalizes between its read and its transition", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_settle_race"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* start(dag, dagID, "n", "ses_baseline_settle_race_child")
      yield* dag.nodeFailed(dagID, "n", "boom", "exec_failed")

      // The failed required node would fail the workflow; a concurrent cancel
      // lands before that transition is guarded.
      const hook = yield* readHook(2, setWorkflowStatus(dagID, "cancelled"))
      const racing = yield* dagOverStore((real) => ({ getWorkflow: (id) => hook.before(real.getWorkflow(id)) }))
      hook.arm()

      expect(yield* racing.settleCompletion(dagID)).toEqual({ status: "ignored" })
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("cancelled")
    }),
  )

  it.effect("recover rejects when a concurrent command changes the workflow during artifact verification", () =>
    Effect.gen(function* () {
      const sessionID = "ses_baseline_recover_race"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("n")])
      yield* dag.pause(dagID)
      const before = (yield* dag.store.getWorkflow(dagID))!

      // Recovery reads the nodes before it hashes artifacts, outside the
      // workflow lock; a concurrent resume lands in that window.
      const hook = yield* readHook(1, dag.resume(dagID).pipe(Effect.orDie))
      const racing = yield* dagOverStore((real) => ({ getNodes: (id) => hook.before(real.getNodes(id)) }))
      hook.arm()

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