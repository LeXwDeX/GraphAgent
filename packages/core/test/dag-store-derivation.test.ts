// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1027 D6b: the two reads that let the summary publisher derive coverage and
 * review quality without scanning a session's history on every emission.
 *
 * - `getWorkflowRevisions` is the change marker a derived value is valid for.
 *   It must move for every projected event that can change coverage or quality
 *   and stay put when nothing happened.
 * - `getSummaryNodes` returns the current graph in one statement and loads an
 *   output only where a computation reads it, so a large report node never
 *   rides along.
 */
import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DatabaseMetrics } from "@graphagent/core/database/metrics"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore, summaryNodeKey } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { ProjectTable } from "@graphagent/core/project/sql"
import { Project } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"

function layer() {
  const database = Database.layerFromPath(":memory:")
  const eventLayer = EventV2.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventLayer)))
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(database, eventLayer, projector, store)
}

const workflow = (id: string, seq: number) => ({
  id,
  project_id: Project.ID.make("project-1"),
  session_id: SessionSchema.ID.make("ses_parent"),
  title: id,
  status: "running",
  config: "{}",
  seq,
  wake_reported: false,
  directory: "/project",
  target_fingerprint: { kind: "none" as const },
})

const node = (
  workflowId: string,
  id: string,
  status: string,
  seq: number,
  output?: unknown,
  superseded = false,
  dependsOn: string[] = [],
) => ({
  id,
  workflow_id: workflowId,
  name: id,
  worker_type: "build",
  status,
  required: true,
  depends_on: dependsOn,
  wake_eligible: false,
  wake_reported: false,
  superseded,
  seq,
  ...(output === undefined ? {} : { output }),
})

function seed(rows: (workflowId: string) => ReturnType<typeof node>[] = (id) => [node(id, "n1", "pending", 1)]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(process.cwd()),
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowTable)
      .values([workflow("dag_a", 1), workflow("dag_b", 1)])
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values([...rows("dag_a"), ...rows("dag_b")])
      .run()
      .pipe(Effect.orDie)
  })
}

const at = (n: number) => DateTime.makeUnsafe(n)

const eqNode = (workflowId: string, id: string) =>
  and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.id, id))

describe("DagStore.getWorkflowRevisions (#1027 D6b)", () => {
  test("is stable while nothing changes and differs per workflow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()
        const first = yield* store.getWorkflowRevisions("ses_parent")
        const second = yield* store.getWorkflowRevisions("ses_parent")
        expect([...first.keys()].toSorted()).toEqual(["dag_a", "dag_b"])
        expect(second).toEqual(first)
        expect((yield* store.getWorkflowRevisions("ses_missing")).size).toBe(0)
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("moves for every projected event that can change coverage or quality, and only for its workflow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        const events = yield* EventV2.Service
        yield* seed()
        const dagID = DagEvent.DagID.make("dag_a")
        const nodeID = DagEvent.NodeID.make("n1")
        const marker = (id: string) => store.getWorkflowRevisions("ses_parent").pipe(Effect.map((all) => all.get(id)))
        const untouched = yield* marker("dag_b")

        const steps: ReadonlyArray<readonly [string, Effect.Effect<unknown>]> = [
          [
            "node started",
            events.publish(DagEvent.NodeStarted, {
              dagID,
              nodeID,
              childSessionID: SessionSchema.ID.make("ses_child"),
              timestamp: at(10),
            }),
          ],
          [
            "safety denial",
            events.publish(DagEvent.NodeSafetyDenied, {
              dagID,
              nodeID,
              attempt: 0,
              ruleID: "SF-3",
              permission: "bash",
              summary: "git reset --hard",
              timestamp: at(20),
            }),
          ],
          [
            "node completed",
            events.publish(DagEvent.NodeCompleted, {
              dagID,
              nodeID,
              output: { not_examined: ["unread"] },
              durationMs: 1,
              timestamp: at(30),
            }),
          ],
          [
            "workflow config update",
            events.publish(DagEvent.WorkflowConfigUpdated, {
              dagID,
              config: '{"name":"x","nodes":[]}',
              timestamp: at(40),
            }),
          ],
          [
            "workflow paused",
            events.publish(DagEvent.WorkflowPaused, { dagID, reason: "budget_exhausted", timestamp: at(50) }),
          ],
        ]
        let previous = yield* marker("dag_a")
        for (const [label, step] of steps) {
          yield* step
          const next = yield* marker("dag_a")
          expect(next, label).not.toBe(previous)
          previous = next
        }
        expect(yield* marker("dag_b")).toBe(untouched)
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("ignores superseded rows, whose changes never reach the current graph", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        const { db } = yield* Database.Service
        yield* seed((id) => [node(id, "n1", "pending", 1), node(id, "old", "failed", 2, undefined, true)])
        const before = yield* store.getWorkflowRevisions("ses_parent")
        yield* db
          .update(WorkflowNodeTable)
          .set({ seq: 99, time_updated: 99_999 })
          .where(
            // The superseded row only.
            eqNode("dag_a", "old"),
          )
          .run()
          .pipe(Effect.orDie)
        expect(yield* store.getWorkflowRevisions("ses_parent")).toEqual(before)
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })
})

describe("DagStore.getSummaryNodes (#1027 D6b)", () => {
  const big = { text: "x".repeat(50_000) }
  const rows = (id: string) => [
    node(id, "lane", "completed", 1, { required_actions: ["fix it"] }),
    node(id, "child", "completed", 2, { verdict: "ACCEPT" }, false, ["lane"]),
    node(id, "report", "completed", 3, big),
    node(id, "gap", "completed", 4, { summary: "partial", not_examined: ["unread package"] }),
    node(id, "running", "running", 5),
    node(id, "old", "failed", 6, { text: "replaced" }, true),
  ]

  test("returns the current graph of every requested workflow in one call", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed(rows)
        const result = yield* store.getSummaryNodes({ workflowIds: ["dag_a", "dag_b"], outputs: new Set() })
        expect(
          result
            .filter((row) => row.workflowId === "dag_a")
            .map((row) => row.id)
            .toSorted(),
        ).toEqual(["child", "gap", "lane", "report", "running"])
        expect(result.some((row) => row.id === "old")).toBe(false)
        expect(result.some((row) => row.superseded)).toBe(false)
        expect(result.find((row) => row.workflowId === "dag_b" && row.id === "child")?.dependsOn).toEqual(["lane"])
        expect(yield* store.getSummaryNodes({ workflowIds: [], outputs: new Set() })).toEqual([])
        expect(yield* store.getSummaryNodes({ workflowIds: ["dag_missing"], outputs: new Set() })).toEqual([])
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("loads an output only for a named node of its own workflow or one that mentions not_examined", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed(rows)
        const result = yield* store.getSummaryNodes({
          workflowIds: ["dag_a", "dag_b"],
          // Named for dag_a only: the same node id in dag_b must not load.
          outputs: new Set([summaryNodeKey("dag_a", "lane"), summaryNodeKey("dag_a", "child")]),
        })
        const out = (workflowId: string, id: string) =>
          result.find((row) => row.workflowId === workflowId && row.id === id)
        expect(out("dag_a", "lane")?.output).toEqual({ required_actions: ["fix it"] })
        expect(out("dag_a", "child")?.output).toEqual({ verdict: "ACCEPT" })
        expect(out("dag_b", "lane")?.output).toBeUndefined()
        // A report nobody named stays out; a node that mentions not_examined comes
        // along because coverage reads it from any node.
        expect(out("dag_a", "report")?.output).toBeUndefined()
        expect(out("dag_a", "gap")?.output).toEqual({ summary: "partial", not_examined: ["unread package"] })
        expect(out("dag_b", "gap")?.output).toEqual({ summary: "partial", not_examined: ["unread package"] })
        expect(out("dag_a", "running")?.output).toBeUndefined()
        // No output key at all, not a present-but-undefined one, for unloaded rows.
        expect("output" in out("dag_a", "report")!).toBe(false)
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("carries the columns coverage reads", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        const { db } = yield* Database.Service
        yield* seed((id) => [node(id, "n1", "failed", 1)])
        yield* db
          .update(WorkflowNodeTable)
          .set({
            error_reason: "boom",
            error_class: "exec_failed",
            stale_target: true,
            safety_denials: {
              items: [{ attempt: 0, ruleID: "SF-3", permission: "bash", summary: "reset", at: 1 }],
              total: 1,
            },
          })
          .where(eqNode("dag_a", "n1"))
          .run()
          .pipe(Effect.orDie)
        const row = (yield* store.getSummaryNodes({ workflowIds: ["dag_a"], outputs: new Set() }))[0]
        expect(row).toMatchObject({
          id: "n1",
          workflowId: "dag_a",
          status: "failed",
          errorReason: "boom",
          errorClass: "exec_failed",
          staleTarget: true,
          safetyDenials: { total: 1 },
        })
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })
})

describe("derivation reads stay constant in size (#1027 D6b)", () => {
  // N workflows of M nodes each, all in one session.
  const seedMany = (workflows: number, nodes: number) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make("ses_parent"),
          project_id: Project.ID.make("project-1"),
          slug: "parent",
          directory: AbsolutePath.make(process.cwd()),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const ids = Array.from({ length: workflows }, (_, index) => `dag_${index}`)
      yield* db
        .insert(WorkflowTable)
        .values(ids.map((id) => workflow(id, 1)))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowNodeTable)
        .values(
          ids.flatMap((id) =>
            Array.from({ length: nodes }, (_, index) => node(id, `n${index}`, "completed", index + 1, { text: "x" })),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return ids
    })

  const statements = async (workflows: number, nodes: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        const ids = yield* seedMany(workflows, nodes)
        // Warm the statement cache so the count reflects the read itself.
        yield* store.getWorkflowRevisions("ses_parent")
        yield* store.getSummaryNodes({ workflowIds: ids, outputs: new Set() })
        const start = DatabaseMetrics.snapshot().sqlCount
        const revisions = yield* store.getWorkflowRevisions("ses_parent")
        const middle = DatabaseMetrics.snapshot().sqlCount
        const rows = yield* store.getSummaryNodes({
          workflowIds: ids,
          outputs: new Set([summaryNodeKey(ids[0], "n0")]),
        })
        const end = DatabaseMetrics.snapshot().sqlCount
        expect(revisions.size).toBe(workflows)
        expect(rows).toHaveLength(workflows * nodes)
        return { revisions: middle - start, nodes: end - middle }
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )

  test("one statement per read whatever the workflow and node counts", async () => {
    const small = await statements(1, 5)
    const large = await statements(20, 50)
    expect(small).toEqual({ revisions: 1, nodes: 1 })
    expect(large).toEqual(small)
  })
})
