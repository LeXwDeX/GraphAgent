// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1027 D6b: coverage count and review quality for a summary. The derivation
// must give the numbers `inspect` computes from the full rows even though it
// loads almost no output text, and the memo must skip work without ever
// changing a result.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@graphagent/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore, type SummaryNodeRow } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagSummary } from "@graphagent/schema/dag-summary"
import { DagCoverage } from "@/dag/coverage"
import type { WorkflowConfig } from "@/dag/dag"
import { DagQuality } from "@/dag/quality"
import { DagSummaryDerived } from "@/dag/summary-derived"
import { testEffect } from "../lib/effect"
import { makeWorkflowRow } from "./fixtures"
import {
  accepted,
  chainsConfig,
  chainsOutputs,
  roundOne,
  rowsFor,
  strictConfig,
  WORKFLOW_ID,
  type Outputs,
} from "./review-fixtures"

const withExtras = (config: WorkflowConfig): WorkflowConfig => ({
  ...config,
  nodes: [
    ...config.nodes,
    {
      id: "report",
      name: "report",
      worker_type: "explore",
      depends_on: [],
      required: false,
      prompt_template: { inline: "r" },
    },
    {
      id: "scan",
      name: "scan",
      worker_type: "explore",
      depends_on: [],
      required: false,
      prompt_template: { inline: "s" },
    },
    {
      id: "broken",
      name: "broken",
      worker_type: "explore",
      depends_on: [],
      required: false,
      prompt_template: { inline: "b" },
    },
    {
      id: "guarded",
      name: "guarded",
      worker_type: "explore",
      depends_on: [],
      required: false,
      prompt_template: { inline: "g" },
    },
  ],
})

const extraOutputs: Outputs = {
  ...roundOne,
  // A large report nobody reads, a node that admits what it did not examine,
  // a failed node, and a node that had a tool call denied.
  report: { output: { text: "x".repeat(40_000) } },
  scan: { output: { summary: "partial", not_examined: ["unread package"] } },
  broken: { status: "failed" },
  guarded: { output: { summary: "continued" } },
}

// Each test builds its own in-memory database and store from these shared layers.
const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.merge(database, DagStore.layer.pipe(Layer.provide(database))))
// The memo works over a store it is handed, so its tests need no services.
const pure = testEffect(Layer.empty)

function seed(config: WorkflowConfig, outputs: Outputs) {
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
      .values({
        id: WORKFLOW_ID,
        project_id: Project.ID.make("project-1"),
        session_id: SessionSchema.ID.make("ses_parent"),
        title: "Review",
        status: "running",
        config: JSON.stringify(config),
        seq: 1,
        wake_reported: false,
        directory: "/project",
        target_fingerprint: { kind: "none" },
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values(
        rowsFor(config, outputs).map((row, index) => ({
          id: row.id,
          workflow_id: WORKFLOW_ID,
          name: row.name,
          worker_type: row.workerType,
          status: row.status,
          required: true,
          depends_on: row.dependsOn,
          output: row.output,
          error_reason: row.id === "broken" ? "exec failed" : null,
          error_class: row.id === "broken" ? "exec_failed" : null,
          safety_denials:
            row.id === "guarded"
              ? {
                  items: [{ attempt: 0, ruleID: "SF-3", permission: "bash", summary: "git reset --hard", at: 1 }],
                  total: 1,
                }
              : null,
          wake_eligible: false,
          wake_reported: false,
          seq: index + 1,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

describe("DagSummaryDerived.forWorkflows (#1027 D6b)", () => {
  // The implementation's fingerprint is read for the bound check, so it must
  // be among the outputs the selective read loads.
  it.effect("finds a review bound to the implementation through the selective read", () =>
    Effect.gen(function* () {
      const config = strictConfig()
      const store = yield* DagStore.Service
      yield* seed(config, accepted)
      const workflow = (yield* store.listBySession("ses_parent"))[0]
      const full = yield* store.getCurrentNodes(WORKFLOW_ID)
      const derived = (yield* DagSummaryDerived.forWorkflows(store, [workflow])).get(WORKFLOW_ID)
      expect(derived?.quality).toEqual(DagQuality.workflowQuality({ config, workflowID: WORKFLOW_ID, nodes: full }))
      expect(derived?.quality).toMatchObject({ reviewBound: true, reviews: 1, raised: 0, quietRounds: 1 })
    }),
  )

  it.effect("derives the numbers inspect computes from the full rows, loading almost no output", () =>
    Effect.gen(function* () {
      const config = withExtras(strictConfig())
      const store = yield* DagStore.Service
      yield* seed(config, extraOutputs)
      const workflow = (yield* store.listBySession("ses_parent"))[0]

      // What `inspect status` runs: every current row with every output.
      const full = yield* store.getCurrentNodes(WORKFLOW_ID)
      const expected = {
        coverageCount: DagCoverage.workflowCoverage({
          config,
          nodes: full,
          workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
        }).length,
        quality: DagQuality.workflowQuality({ config, workflowID: WORKFLOW_ID, nodes: full }),
      }
      const derived = (yield* DagSummaryDerived.forWorkflows(store, [workflow])).get(WORKFLOW_ID)

      expect(derived).toEqual(expected)
      // A failed node, a lane gap, and a denied tool call; plus the rejected
      // round's quality, with the skeptic's finding.
      expect(derived?.coverageCount).toBe(3)
      expect(derived?.quality).toMatchObject({ reviews: 1, raised: 5, refuted: 1, skepticRefutations: 1 })

      // The 40 KB report never came back; the review nodes and the gap did.
      const rows = yield* store.getSummaryNodes({ workflowIds: [WORKFLOW_ID], outputs: new Set() })
      expect(rows.find((row) => row.id === "report")?.output).toBeUndefined()
      expect(rows.find((row) => row.id === "scan")?.output).toBeDefined()
    }),
  )

  // Every chain's decisions and lanes are named, so the selective read gives the
  // same chain accounting as the full rows: the later rounds of one review do
  // not hide what an earlier review left open.
  it.effect("reads every review chain through the selective read", () =>
    Effect.gen(function* () {
      const config = chainsConfig()
      const store = yield* DagStore.Service
      yield* seed(config, chainsOutputs)
      const workflow = (yield* store.listBySession("ses_parent"))[0]
      const full = yield* store.getCurrentNodes(WORKFLOW_ID)
      const derived = (yield* DagSummaryDerived.forWorkflows(store, [workflow])).get(WORKFLOW_ID)
      expect(derived?.quality).toEqual(DagQuality.workflowQuality({ config, workflowID: WORKFLOW_ID, nodes: full }))
      expect(derived?.quality).toMatchObject({
        reviews: 5,
        stillOpen: 1,
        quietRounds: 1,
        completeness: { covered: 1, total: 2, unlisted: 2 },
      })
    }),
  )

  it.effect("derives nothing for an empty list and nulls quality for a workflow without a review", () =>
    Effect.gen(function* () {
      const store = yield* DagStore.Service
      expect((yield* DagSummaryDerived.forWorkflows(store, [])).size).toBe(0)

      const plain = { name: "plain", nodes: strictConfig().nodes.filter((node) => node.block === "coding") }
      yield* seed(plain, { implementation: { output: { fingerprint: "fp" } } })
      const workflow = (yield* store.listBySession("ses_parent"))[0]
      expect((yield* DagSummaryDerived.forWorkflows(store, [workflow])).get(WORKFLOW_ID)).toEqual({
        coverageCount: 0,
        quality: null,
      })
    }),
  )
})

describe("DagSummaryDerived memo (#1027 D6b)", () => {
  const config = strictConfig()
  const lite = (workflowId: string, outputs: Outputs): SummaryNodeRow[] =>
    rowsFor(config, outputs).map((row) => ({
      id: row.id,
      workflowId,
      status: row.status,
      dependsOn: row.dependsOn,
      errorReason: row.errorReason,
      errorClass: row.errorClass,
      safetyDenials: null,
      staleTarget: null,
      superseded: false as const,
      output: row.output,
    }))

  function harness() {
    const state = {
      revisions: new Map([
        ["wf-a", "1"],
        ["wf-b", "1"],
      ]),
      nodes: [...lite("wf-a", roundOne), ...lite("wf-b", {})],
      reads: [] as string[][],
      markerReads: 0,
    }
    const workflows = ["wf-a", "wf-b"].map((id) => makeWorkflowRow({ id, config: JSON.stringify(config) }))
    const store = {
      getWorkflowRevisions: () =>
        Effect.sync(() => {
          state.markerReads += 1
          return state.revisions
        }),
      listBySession: () => Effect.succeed(workflows),
      getSummaryNodes: (input: { readonly workflowIds: readonly string[] }) =>
        Effect.sync(() => {
          state.reads.push([...input.workflowIds])
          return state.nodes.filter((node) => input.workflowIds.includes(node.workflowId))
        }),
    }
    return { state, store, memo: DagSummaryDerived.memo() }
  }

  const resolve = (h: ReturnType<typeof harness>, ids: string[], session = "ses_parent") =>
    h.memo.resolve(h.store, session, ids)

  pure.effect("derives every workflow once, then keeps values while the change marker holds", () =>
    Effect.gen(function* () {
      const h = harness()
      const first = yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toEqual([["wf-a", "wf-b"]])
      expect(first.get("wf-a")?.quality).toMatchObject({ reviews: 1 })
      expect(first.get("wf-b")?.quality).toMatchObject({ reviews: 0 })

      const second = yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toHaveLength(1)
      expect(second.get("wf-a")).toBe(first.get("wf-a"))
    }),
  )

  pure.effect("re-derives only the workflow whose marker moved", () =>
    Effect.gen(function* () {
      const h = harness()
      yield* resolve(h, ["wf-a", "wf-b"])
      // wf-b's review round completes and its marker moves; wf-a is untouched.
      h.state.nodes = [...lite("wf-a", roundOne), ...lite("wf-b", roundOne)]
      h.state.revisions.set("wf-b", "2")
      const result = yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toEqual([["wf-a", "wf-b"], ["wf-b"]])
      expect(result.get("wf-b")?.quality).toMatchObject({ reviews: 1, raised: 5 })
    }),
  )

  pure.effect("derives again each time for a workflow with no marker", () =>
    Effect.gen(function* () {
      const h = harness()
      h.state.revisions.clear()
      yield* resolve(h, ["wf-a"])
      yield* resolve(h, ["wf-a"])
      expect(h.state.reads).toEqual([["wf-a"], ["wf-a"]])
    }),
  )

  pure.effect("forgets a workflow that left the session, and never reads for an empty one", () =>
    Effect.gen(function* () {
      const h = harness()
      yield* resolve(h, ["wf-a", "wf-b"])
      yield* resolve(h, ["wf-b"])
      // wf-a left the list, so its entry was dropped and must be derived afresh.
      yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toEqual([["wf-a", "wf-b"], ["wf-a"]])

      // An empty list reads nothing, and another session's list leaves this
      // session's entries alone.
      const before = h.state.markerReads
      expect((yield* resolve(h, [], "ses_other")).size).toBe(0)
      expect(h.state.markerReads).toBe(before)
      yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toHaveLength(2)

      // A session that lost every workflow drops its entries too.
      expect((yield* resolve(h, [])).size).toBe(0)
      yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toHaveLength(3)
    }),
  )
})

describe("DagSummaryDerived.toWire (#1027 D6b)", () => {
  const summary: DagStore.WorkflowSummary = {
    id: "wf",
    title: "Title",
    status: "running",
    graphRev: 2,
    nodeCount: 3,
    completedNodes: 1,
    runningNodes: 1,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 1,
    escalatedNodes: 0,
    tokens: 10,
    tokensCacheRead: 4,
    checkpointPending: false,
  }

  test("adds the derived fields and the slot count only when known, and nothing else", () => {
    const bare = DagSummaryDerived.toWire(summary, undefined)
    expect(Object.keys(bare).toSorted()).toEqual(Object.keys(summary).toSorted())

    // A field the store row happens to carry beyond the wire shape stays behind.
    const full = DagSummaryDerived.toWire(
      { ...summary, internal: true } as DagStore.WorkflowSummary,
      { coverageCount: 2, quality: null },
      3,
    )
    expect(full).toEqual({ ...summary, coverageCount: 2, quality: null, concurrencyRunning: 3 })
  })

  // The HTTP body and the pushed event are encoded with this schema, so a
  // derived value it would reject must fail here, not in a client.
  test("encodes through the public summary schema, with and without a quality", () => {
    const quality = {
      reviewBound: true,
      reviews: 2,
      raised: 7,
      fixed: 5,
      refuted: 2,
      stillOpen: 0,
      skepticRefutations: 1,
      rounds: 2,
      quietRounds: 1,
      completeness: { covered: 3, total: 3, unlisted: 0 },
    }
    const encode = Schema.encodeUnknownSync(DagSummary.WorkflowSummary)
    const wire = DagSummaryDerived.toWire(summary, { coverageCount: 2, quality }, 3)
    expect(encode(wire)).toEqual(wire)
    expect(encode({ ...wire, quality: null }).quality).toBeNull()
    expect(encode({ ...wire, quality: { ...quality, completeness: null } }).quality?.completeness).toBeNull()
    expect(() => encode({ ...wire, quality: { ...quality, raised: -1 } })).toThrow()
  })
})
