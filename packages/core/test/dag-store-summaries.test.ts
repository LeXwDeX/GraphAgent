// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagNodeAttemptTable, WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { ProjectTable } from "@graphagent/core/project/sql"
import { Project } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"

function storeLayer() {
  const database = Database.layerFromPath(":memory:")
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

function node(workflowId: string, id: string, status: string, seq: number) {
  return {
    id,
    workflow_id: workflowId,
    name: id,
    worker_type: "build",
    status,
    required: true,
    depends_on: [],
    wake_eligible: false,
    wake_reported: false,
    seq,
  }
}

function seed() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.make("project-1"),
      worktree: AbsolutePath.make(process.cwd()),
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: SessionSchema.ID.make("ses_parent"),
      project_id: Project.ID.make("project-1"),
      slug: "parent",
      directory: AbsolutePath.make(process.cwd()),
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowTable).values([
      {
        id: "wf-mixed",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Mixed",
        status: "running",
        config: "{}",
        seq: 1,
        wake_reported: false,
        time_created: 2,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
      {
        id: "wf-empty",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Empty",
        status: "running",
        config: "{}",
        seq: 2,
        wake_reported: false,
        time_created: 1,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      node("wf-mixed", "c1", "completed", 1),
      node("wf-mixed", "c2", "completed", 2),
      node("wf-mixed", "r1", "running", 3),
      node("wf-mixed", "f1", "failed", 4),
      node("wf-mixed", "p1", "pending", 5),
      node("wf-mixed", "s1", "skipped", 6),
      node("wf-mixed", "q1", "queued", 7),
      node("wf-mixed", "a1", "aborted", 8),
    ]).run().pipe(Effect.orDie)
  })
}

describe("DagStore.getWorkflowSummaries (SQL aggregation)", () => {
  test("counts mixed node statuses per workflow and defaults empty workflows to zero", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const summaries = yield* store.getWorkflowSummaries("ses_parent")

        // Ordered by time_created DESC: wf-mixed (2) before wf-empty (1).
        expect(summaries.map((s) => s.id)).toEqual(["wf-mixed", "wf-empty"])
        expect(summaries[0]).toEqual({
          id: "wf-mixed",
          title: "Mixed",
          status: "running",
          graphRev: 1,
          nodeCount: 8,
          completedNodes: 2,
          runningNodes: 1,
          failedNodes: 1,
          skippedNodes: 1,
          abortedNodes: 1,
          queuedNodes: 1,
          escalatedNodes: 0,
          tokens: 0,
          tokensCacheRead: 0,
          checkpointPending: false,
        })
        expect(summaries[1]).toEqual({
          id: "wf-empty",
          title: "Empty",
          status: "running",
          graphRev: 1,
          nodeCount: 0,
          completedNodes: 0,
          runningNodes: 0,
          failedNodes: 0,
          skippedNodes: 0,
          abortedNodes: 0,
          queuedNodes: 0,
          escalatedNodes: 0,
          tokens: 0,
          tokensCacheRead: 0,
          checkpointPending: false,
        })
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("returns an empty list for a session with no workflows", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        expect(yield* store.getWorkflowSummaries("ses_missing")).toEqual([])
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("listSummariesByParent returns the same parent-scoped aggregation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const summaries = yield* store.listSummariesByParent("ses_parent")
        expect(summaries).toEqual(yield* store.getWorkflowSummaries("ses_parent"))
        expect(summaries.map((summary) => summary.id)).toEqual(["wf-mixed", "wf-empty"])
        expect(summaries[0].abortedNodes).toBe(1)
        expect(yield* store.listSummariesByParent("ses_missing")).toEqual([])
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })
})

function usageSession(
  id: string,
  tokens: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number },
) {
  return {
    id: SessionSchema.ID.make(id),
    project_id: Project.ID.make("project-1"),
    slug: id,
    directory: AbsolutePath.make("/project"),
    title: id,
    version: "test",
    tokens_input: tokens.input ?? 0,
    tokens_output: tokens.output ?? 0,
    tokens_reasoning: tokens.reasoning ?? 0,
    tokens_cache_read: tokens.cacheRead ?? 0,
    tokens_cache_write: tokens.cacheWrite ?? 0,
  }
}

function seedUsage() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.make("project-1"),
      worktree: AbsolutePath.make(process.cwd()),
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values([
      usageSession("ses_parent", {}),
      usageSession("ses_child_a", { input: 10, cacheWrite: 3, output: 5, reasoning: 1, cacheRead: 7 }),
      usageSession("ses_child_b", { input: 2, output: 4, cacheRead: 11 }),
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowTable).values([
      {
        id: "wf-retry",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Retry",
        status: "running",
        config: "{}",
        seq: 1,
        wake_reported: false,
        time_created: 2,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
      {
        id: "wf-checkpoint",
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Checkpoint",
        status: "paused",
        pause_reason: "checkpoint",
        config: "{}",
        seq: 2,
        wake_reported: false,
        time_created: 1,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      },
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      node("wf-retry", "r1", "running", 1),
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(DagNodeAttemptTable).values([
      { workflow_id: "wf-retry", node_id: "r1", attempt: 0, child_session_id: "ses_child_a", started_at: 10 },
      { workflow_id: "wf-retry", node_id: "r1", attempt: 1, child_session_id: "ses_child_b", started_at: 20 },
      // Simulates a child session cleaned up before its ledger row: the
      // attempt still counts (zero usage) and must not drop the workflow.
      { workflow_id: "wf-retry", node_id: "r1", attempt: 2, child_session_id: "ses_child_c", started_at: 30 },
    ]).run().pipe(Effect.orDie)
  })
}

describe("DagStore summary usage (#1027 D6)", () => {
  test("sums every attempt's session tokens and keeps cache reads separate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seedUsage()

        const summaries = yield* store.getWorkflowSummaries("ses_parent")
        const byID = new Map(summaries.map((summary) => [summary.id, summary]))

        // 19 (a) + 6 (b) + 0 (cleaned-up child). History stays counted even
        // though the node row names only the latest attempt.
        expect(byID.get("wf-retry")!.tokens).toBe(25)
        expect(byID.get("wf-retry")!.tokensCacheRead).toBe(18)
        expect(byID.get("wf-retry")!.checkpointPending).toBe(false)
        expect(byID.get("wf-checkpoint")!.tokens).toBe(0)
        expect(byID.get("wf-checkpoint")!.checkpointPending).toBe(true)
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("resolves a child session to its owning workflow for event routing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seedUsage()

        expect(yield* store.getWorkflowByChildSession!("ses_child_a")).toEqual({
          workflowId: "wf-retry",
          sessionId: "ses_parent",
          projectId: "project-1",
          directory: "/project",
        })
        // The ledger row exists even when the session row is gone.
        expect((yield* store.getWorkflowByChildSession!("ses_child_c"))?.workflowId).toBe("wf-retry")
        expect(yield* store.getWorkflowByChildSession!("ses_unknown")).toBeUndefined()
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })
})
