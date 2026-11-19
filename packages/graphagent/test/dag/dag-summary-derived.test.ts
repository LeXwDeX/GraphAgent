// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1027 D6b: coverage count and review quality for a summary. The derivation
// must give the numbers `inspect` computes from the full rows even though it
// loads almost no output text, and the memo must skip work without ever
// changing a result.
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@graphagent/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore, type SummaryNodeRow } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { DagEvent } from "@graphagent/schema/dag-event"
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

// #1618: the workflow-level worktree on the summary. The rule is the one `workflow status` follows: the settled row
// wins, the live pointer in the persisted config stands in for it until then, and a workflow without isolation has
// neither and carries no field.
describe("DagSummaryDerived worktree (#1618)", () => {
  const plain = () => ({ name: "plain", nodes: strictConfig().nodes.filter((node) => node.block === "coding") })
  const pointer = {
    directory: "/repo/.agents/worktree/dag-wf-workflow",
    branch: "graphagent/dag-wf-workflow",
    baseHead: "base-sha",
  }
  const settledRow = (state: DagEvent.WorkflowWorktree["state"], extra: Partial<DagEvent.WorkflowWorktree> = {}) =>
    ({
      directory: pointer.directory,
      branch: pointer.branch,
      baseHead: "base-sha",
      head: "head-sha",
      patchPath: "/reports/wf/workflow.patch",
      patchSha256: "patch-sha",
      touchedPaths: ["src/a.ts"],
      state,
      ...extra,
    }) satisfies DagEvent.WorkflowWorktree

  /** Settles the seeded workflow the way the projection does: the column only, no seq and no update time. */
  const settle = (worktree: DagEvent.WorkflowWorktree) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(WorkflowTable)
        .set({ worktree })
        .where(eq(WorkflowTable.id, WORKFLOW_ID))
        .run()
        .pipe(Effect.orDie)
    })

  const derivedOf = Effect.gen(function* () {
    const store = yield* DagStore.Service
    const workflow = (yield* store.listBySession("ses_parent"))[0]
    return (yield* DagSummaryDerived.forWorkflows(store, [workflow])).get(WORKFLOW_ID)
  })

  it.effect("the live pointer says active, with the directory and branch and none of its other fields", () =>
    Effect.gen(function* () {
      yield* seed({ ...plain(), worktree: pointer }, { implementation: { output: { fingerprint: "fp" } } })
      const derived = yield* derivedOf
      expect(derived?.worktree).toEqual({ directory: pointer.directory, branch: pointer.branch, state: "active" })
      // The numbers beside it are what they were.
      expect(derived).toMatchObject({ coverageCount: 0, quality: null })
    }),
  )

  it.effect("a pointer without a branch is active without one", () =>
    Effect.gen(function* () {
      yield* seed({ ...plain(), worktree: { directory: pointer.directory } }, {})
      expect((yield* derivedOf)?.worktree).toEqual({ directory: pointer.directory, state: "active" })
    }),
  )

  it.effect("a settlement wins over the pointer and gives its own state, and only the fields the wire declares", () =>
    Effect.gen(function* () {
      yield* seed({ ...plain(), worktree: pointer }, {})
      for (const state of ["removed", "kept"] as const) {
        yield* settle(settledRow(state, state === "kept" ? { reason: "patch failed" } : {}))
        const worktree = (yield* derivedOf)?.worktree
        // The commit, patch and reason evidence stay on the row; the wire carries where it was and what remains.
        expect(worktree).toEqual({ directory: pointer.directory, branch: pointer.branch, state })
      }
      // The settlement's own directory and branch are what count, not the pointer's.
      yield* settle(settledRow("kept", { directory: "/elsewhere", branch: undefined }))
      expect((yield* derivedOf)?.worktree).toEqual({ directory: "/elsewhere", state: "kept" })
    }),
  )

  it.effect("a settlement stands on its own once the pointer is gone from the config", () =>
    Effect.gen(function* () {
      yield* seed(plain(), {})
      yield* settle(settledRow("removed"))
      expect((yield* derivedOf)?.worktree).toEqual({
        directory: pointer.directory,
        branch: pointer.branch,
        state: "removed",
      })
    }),
  )

  it.effect("a workflow without isolation has no field at all, and a pointer that names no directory is ignored", () =>
    Effect.gen(function* () {
      yield* seed(plain(), {})
      const none = yield* derivedOf
      expect(none).toBeDefined()
      expect("worktree" in none!).toBe(false)

      const { db } = yield* Database.Service
      for (const broken of [{}, { directory: "" }, { directory: 7 }, { branch: "only-a-branch" }, "x", null]) {
        yield* db
          .update(WorkflowTable)
          .set({ config: JSON.stringify({ ...plain(), worktree: broken }) })
          .where(eq(WorkflowTable.id, WORKFLOW_ID))
          .run()
          .pipe(Effect.orDie)
        const derived = yield* derivedOf
        expect({ broken, drawn: derived !== undefined && "worktree" in derived }).toEqual({ broken, drawn: false })
      }
    }),
  )

  it.effect("an unreadable config carries no pointer, but a settlement is still reported", () =>
    Effect.gen(function* () {
      yield* seed(plain(), {})
      const { db } = yield* Database.Service
      yield* db
        .update(WorkflowTable)
        .set({ config: "{ not json" })
        .where(eq(WorkflowTable.id, WORKFLOW_ID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* derivedOf)?.worktree).toBeUndefined()
      yield* settle(settledRow("kept"))
      expect((yield* derivedOf)?.worktree).toEqual({
        directory: pointer.directory,
        branch: pointer.branch,
        state: "kept",
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
      workflows: ["wf-a", "wf-b"].map((id) => makeWorkflowRow({ id, config: JSON.stringify(config) })),
      reads: [] as string[][],
      markerReads: 0,
    }
    const store = {
      getWorkflowRevisions: () =>
        Effect.sync(() => {
          state.markerReads += 1
          return state.revisions
        }),
      listBySession: () => Effect.succeed(state.workflows),
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

  // #1618: the settlement of a workflow's worktree is written without moving the workflow's seq or update time, so the
  // marker's own settled segment is all that tells the memo the live pointer it holds is out of date. The memo keeps
  // exactly what the marker allows, and gives the settled state the moment the marker moves.
  pure.effect("gives the settled worktree once the marker moves for it, and keeps the pointer until then", () =>
    Effect.gen(function* () {
      const h = harness()
      const pointer = { directory: "/wt/wf-a", branch: "graphagent/wf-a" }
      const withPointer = JSON.stringify({ ...config, worktree: pointer })
      h.state.workflows = [
        makeWorkflowRow({ id: "wf-a", config: withPointer }),
        makeWorkflowRow({ id: "wf-b", config: JSON.stringify(config) }),
      ]
      const first = yield* resolve(h, ["wf-a", "wf-b"])
      expect(first.get("wf-a")?.worktree).toEqual({ ...pointer, state: "active" })
      expect(first.get("wf-b")?.worktree).toBeUndefined()

      // The row is settled, but the marker has not moved: the memo is only a cache of what it derived at that marker.
      const settled = { ...pointer, touchedPaths: [], state: "removed" as const }
      h.state.workflows = [
        makeWorkflowRow({ id: "wf-a", config: withPointer, worktree: settled }),
        makeWorkflowRow({ id: "wf-b", config: JSON.stringify(config) }),
      ]
      expect((yield* resolve(h, ["wf-a", "wf-b"])).get("wf-a")?.worktree).toEqual({ ...pointer, state: "active" })
      expect(h.state.reads).toHaveLength(1)

      // The store's marker ends in the settled flag: only wf-a derives again, and it now says what remained.
      h.state.revisions.set("wf-a", "1.0.1.0.1")
      const second = yield* resolve(h, ["wf-a", "wf-b"])
      expect(h.state.reads).toEqual([["wf-a", "wf-b"], ["wf-a"]])
      expect(second.get("wf-a")?.worktree).toEqual({ ...pointer, state: "removed" })
      expect(second.get("wf-b")).toBe(first.get("wf-b"))
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
    // #1475: distinct values, so a field mapped to the wrong source shows up in the equality below.
    tokensInput: 3,
    tokensOutput: 4,
    tokensReasoning: 1,
    tokensCacheWrite: 2,
    cost: 0.0042,
    costUnknown: true,
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

  // #1618: the worktree is one more optional field, so a client from before it decodes a newer server's summary, and a
  // newer client one from an older server, which has no field to send.
  test("carries the worktree only when the workflow has one, and encodes it through the public schema", () => {
    const encode = Schema.encodeUnknownSync(DagSummary.WorkflowSummary)
    const quality = null
    const bare = DagSummaryDerived.toWire(summary, { coverageCount: 0, quality })
    expect("worktree" in bare).toBe(false)
    expect(encode(bare)).toEqual(bare)

    for (const worktree of [
      { directory: "/wt/wf", branch: "graphagent/wf", state: "active" },
      { directory: "/wt/wf", state: "kept" },
      { directory: "/wt/wf", branch: "graphagent/wf", state: "removed" },
    ] as const) {
      const wire = DagSummaryDerived.toWire(summary, { coverageCount: 0, quality, worktree }, 3)
      expect(wire.worktree).toEqual(worktree)
      expect(encode(wire)).toEqual(wire)
    }

    // Anything the schema does not declare is a failure here, not in a client: a state the wire has no word for, a path
    // that is not a string, and the evidence the settlement row holds.
    const wire = DagSummaryDerived.toWire(summary, {
      coverageCount: 0,
      quality,
      worktree: { directory: "/wt/wf", state: "active" },
    })
    expect(() => encode({ ...wire, worktree: { directory: "/wt/wf", state: "gone" } })).toThrow()
    expect(() => encode({ ...wire, worktree: { directory: 7, state: "active" } })).toThrow()
    expect(() => encode({ ...wire, worktree: { state: "active" } })).toThrow()
    expect(encode({ ...wire, worktree: { directory: "/wt/wf", state: "kept", patchPath: "/p" } }).worktree).toEqual({
      directory: "/wt/wf",
      state: "kept",
    })
  })

  // #1475: the usage figures ride the same schema as optional fields, so an older server's summary still decodes.
  test("carries the itemised tokens, cost and unknown flag, all optional on the wire", () => {
    const encode = Schema.encodeUnknownSync(DagSummary.WorkflowSummary)
    const wire = DagSummaryDerived.toWire(summary, undefined)
    expect(wire).toMatchObject({
      tokensInput: 3,
      tokensOutput: 4,
      tokensReasoning: 1,
      tokensCacheWrite: 2,
      cost: 0.0042,
      costUnknown: true,
    })
    // The budget total keeps its definition: the four itemised counts, cache reads left out.
    expect(wire.tokens).toBe(3 + 2 + 4 + 1)

    const older = { ...wire }
    const added = ["tokensInput", "tokensOutput", "tokensReasoning", "tokensCacheWrite", "cost", "costUnknown"] as const
    for (const key of added) delete older[key]
    expect(encode(older)).toEqual(older)
    expect(() => encode({ ...wire, cost: Number.NaN })).toThrow()
    expect(() => encode({ ...wire, tokensInput: -1 })).toThrow()
    expect(() => encode({ ...wire, costUnknown: "yes" })).toThrow()
  })
})
