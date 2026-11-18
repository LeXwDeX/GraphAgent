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
import { rootUsage } from "@graphagent/core/session/usage"

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
          tokensInput: 0,
          tokensOutput: 0,
          tokensReasoning: 0,
          tokensCacheWrite: 0,
          cost: 0,
          costUnknown: false,
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
          tokensInput: 0,
          tokensOutput: 0,
          tokensReasoning: 0,
          tokensCacheWrite: 0,
          cost: 0,
          costUnknown: false,
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
  tokens: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
  },
) {
  return {
    id: SessionSchema.ID.make(id),
    project_id: Project.ID.make("project-1"),
    slug: id,
    directory: AbsolutePath.make("/project"),
    title: id,
    version: "test",
    cost: tokens.cost ?? 0,
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
      usageSession("ses_child_a", { input: 10, cacheWrite: 3, output: 5, reasoning: 1, cacheRead: 7, cost: 0.5 }),
      usageSession("ses_child_b", { input: 2, output: 4, cacheRead: 11, cost: 0.25 }),
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

  test("itemises the same attempts' tokens and prices them, leaving the budget total as it was (#1475)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seedUsage()

        const summaries = yield* store.getWorkflowSummaries("ses_parent")
        const retry = summaries.find((summary) => summary.id === "wf-retry")!
        const checkpoint = summaries.find((summary) => summary.id === "wf-checkpoint")!

        // 10 + 2 input, 5 + 4 output, 1 reasoning, 3 cache write; the cleaned-up attempt adds nothing.
        expect(retry.tokensInput).toBe(12)
        expect(retry.tokensOutput).toBe(9)
        expect(retry.tokensReasoning).toBe(1)
        expect(retry.tokensCacheWrite).toBe(3)
        // `tokens` keeps its definition: the four itemised figures, without cache reads.
        expect(retry.tokens).toBe(
          retry.tokensInput + retry.tokensCacheWrite + retry.tokensOutput + retry.tokensReasoning,
        )
        expect(retry.tokensCacheRead).toBe(18)
        expect(retry.cost).toBeCloseTo(0.75, 10)
        expect(retry.costUnknown).toBe(false)

        // A workflow with no attempts reads as zero and priced.
        expect(checkpoint.tokensInput).toBe(0)
        expect(checkpoint.tokensCacheWrite).toBe(0)
        expect(checkpoint.cost).toBe(0)
        expect(checkpoint.costUnknown).toBe(false)
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

describe("DagStore summary cost (#1475)", () => {
  const parent = SessionSchema.ID.make("ses_parent")

  /** An attempt session: a child of the parent, the way `spawn` creates one. */
  const attemptSession = (name: string, usage: Parameters<typeof usageSession>[1]) => ({
    ...usageSession(name, usage),
    parent_id: parent,
  })

  /**
   * One workflow per key, one attempt per entry. A string names an attempt whose
   * session row is already gone (the ledger row outlives it).
   */
  function seedCases(cases: Record<string, ReadonlyArray<ReturnType<typeof attemptSession> | string>>) {
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const names = Object.keys(cases)
      yield* db.insert(ProjectTable).values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values(usageSession("ses_parent", {})).run().pipe(Effect.orDie)
      const sessions = Object.values(cases).flat().filter((entry) => typeof entry !== "string")
      yield* db.insert(SessionTable).values(sessions).run().pipe(Effect.orDie)
      yield* db.insert(WorkflowTable).values(
        names.map((id, index) => ({
          id,
          project_id: Project.ID.make("project-1"),
          session_id: parent,
          title: id,
          status: "running",
          config: "{}",
          seq: index + 1,
          wake_reported: false,
          time_created: index + 1,
          directory: "/project",
          target_fingerprint: { kind: "none" as const },
        })),
      ).run().pipe(Effect.orDie)
      yield* db.insert(DagNodeAttemptTable).values(
        names.flatMap((id) =>
          cases[id].map((entry, attempt) => ({
            workflow_id: id,
            node_id: "n1",
            attempt,
            child_session_id: typeof entry === "string" ? entry : entry.id,
            started_at: attempt,
          })),
        ),
      ).run().pipe(Effect.orDie)
    })
  }

  const summarize = (cases: Parameters<typeof seedCases>[0]) =>
    Effect.gen(function* () {
      const store = yield* DagStore.Service
      yield* seedCases(cases)
      return new Map((yield* store.getWorkflowSummaries("ses_parent")).map((summary) => [summary.id, summary]))
    })

  const run = <A>(effect: Effect.Effect<A, never, DagStore.Service | Database.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(storeLayer()), Effect.scoped))

  test("sums a workflow's priced attempts and does not mark it unknown", async () => {
    const byID = await run(
      summarize({
        "wf-priced": [
          attemptSession("ses_a", { input: 10, cost: 0.5 }),
          attemptSession("ses_b", { output: 4, cost: 0.25 }),
        ],
      }),
    )
    const priced = byID.get("wf-priced")!
    expect(priced.cost).toBeCloseTo(0.75, 10)
    expect(priced.costUnknown).toBe(false)
    expect(priced.tokensInput).toBe(10)
    expect(priced.tokensOutput).toBe(4)
  })

  test("an attempt with tokens at zero cost marks only its own workflow unknown and adds nothing to cost", async () => {
    const byID = await run(
      summarize({
        "wf-partial": [
          attemptSession("ses_paid", { output: 10, cost: 1.5 }),
          attemptSession("ses_free", { input: 100 }),
        ],
        "wf-priced": [attemptSession("ses_other", { input: 3, cost: 0.1 })],
      }),
    )
    const partial = byID.get("wf-partial")!
    expect(partial.costUnknown).toBe(true)
    expect(partial.cost).toBe(1.5)
    // The unpriced attempt's tokens still count; only its price is missing.
    expect(partial.tokensInput).toBe(100)
    expect(partial.tokens).toBe(110)
    // The flag belongs to the workflow: its priced neighbour stays priced.
    expect(byID.get("wf-priced")!.costUnknown).toBe(false)
  })

  test("zero cost without tokens is not unknown, for an idle session or one that is already gone", async () => {
    const byID = await run(summarize({ "wf-idle": [attemptSession("ses_idle", {}), "ses_gone"] }))
    const idle = byID.get("wf-idle")!
    expect(idle.cost).toBe(0)
    expect(idle.costUnknown).toBe(false)
    expect(idle.tokens).toBe(0)
  })

  test("cache reads alone count as usage for the unknown flag, though not for the token total", async () => {
    const byID = await run(summarize({ "wf-cache": [attemptSession("ses_cache", { cacheRead: 40 })] }))
    const cache = byID.get("wf-cache")!
    expect(cache.costUnknown).toBe(true)
    expect(cache.tokensCacheRead).toBe(40)
    expect(cache.tokens).toBe(0)
  })

  test("a negative recorded cost reads as zero and is not unknown", async () => {
    const byID = await run(summarize({ "wf-negative": [attemptSession("ses_negative", { input: 5, cost: -2 })] }))
    const negative = byID.get("wf-negative")!
    expect(negative.cost).toBe(0)
    expect(negative.costUnknown).toBe(false)
    expect(negative.tokensInput).toBe(5)
  })

  test("agrees with rootUsage over the same sessions, so the panel and the usage endpoint match", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const byID = yield* summarize({
          "wf-priced": [
            attemptSession("ses_a", { input: 10, cacheWrite: 3, cacheRead: 7, cost: 0.5 }),
            attemptSession("ses_b", { output: 4, reasoning: 2, cost: 0.25 }),
          ],
          "wf-partial": [
            attemptSession("ses_paid", { output: 10, cost: 1.5 }),
            attemptSession("ses_free", { input: 100 }),
          ],
          "wf-idle": [attemptSession("ses_idle", {}), "ses_gone"],
        })
        // The parent holds no usage of its own, so its tree is exactly the attempt sessions;
        // the session that is gone contributes nothing to either side.
        const usage = yield* rootUsage(db, parent)
        const sum = (pick: (summary: DagStore.WorkflowSummary) => number) =>
          [...byID.values()].reduce((total, summary) => total + pick(summary), 0)

        expect(sum((summary) => summary.cost)).toBeCloseTo(usage.cost, 10)
        expect([...byID.values()].some((summary) => summary.costUnknown)).toBe(usage.costUnknown)
        expect(sum((summary) => summary.tokensInput)).toBe(usage.tokens.input)
        expect(sum((summary) => summary.tokensOutput)).toBe(usage.tokens.output)
        expect(sum((summary) => summary.tokensReasoning)).toBe(usage.tokens.reasoning)
        expect(sum((summary) => summary.tokensCacheWrite)).toBe(usage.tokens.cache.write)
        expect(sum((summary) => summary.tokensCacheRead)).toBe(usage.tokens.cache.read)
      }),
    )
  })
})
