// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M8: the shared write-safety rules. One writer definition feeds the
// plan-agent gate, the cross-workflow write-conflict check and the default
// isolation decision, so each of them is tested against the same table here.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The store double
// implements only the two reads `liveWriters` makes, and rows are hand-built.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import type { DagStore } from "@graphagent/core/dag/store"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { DagBlocks } from "@/dag/blocks"
import { DagWriteGuard } from "@/dag/write-guard"
import { tmpdir } from "../fixture/fixture"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const def = (id: string, extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: id },
  ...extra,
})

describe("DagBlocks.isWriterNode", () => {
  const cases: ReadonlyArray<readonly [string, Partial<NodeConfig>, boolean]> = [
    ["a coding block, even on a read-only worker override", { block: "coding", worker_type: "explore" }, true],
    ["a prototype block", { block: "prototype", worker_type: "build" }, true],
    ["a coding block that denies workspace writes", { block: "coding", workspace_writes: "deny" }, true],
    ["a hand-written build node", { worker_type: "build" }, true],
    ["a hand-written general node", { worker_type: "general" }, true],
    ["a custom worker with no block", { worker_type: "frontend-dev" }, true],
    ["a general node that allows writes explicitly", { worker_type: "general", workspace_writes: "allow" }, true],
    ["a build node that denies workspace writes", { worker_type: "build", workspace_writes: "deny" }, false],
    ["an explore node", { worker_type: "explore" }, false],
    ["an explore node that asks for workspace writes", { worker_type: "explore", workspace_writes: "allow" }, false],
    ["a plan node", { worker_type: "plan" }, false],
    ["an auditor node", { worker_type: "auditor" }, false],
    ["a review node", { worker_type: "review" }, false],
    ["a review-* node", { worker_type: "review-security" }, false],
    ["a verify node", { worker_type: "verify" }, false],
    ["a verification-* node", { worker_type: "verification-e2e" }, false],
    ["a generated aggregator", { worker_type: "explore", aggregates_writers: true, block: "review" }, false],
    ["an aggregator even on a build worker", { worker_type: "build", aggregates_writers: true }, false],
    ["a review-block lane", { worker_type: "auditor", block: "review" }, false],
    ["a verify block", { worker_type: "auditor", block: "verify" }, false],
    ["a debug diagnosis node (general by default)", { worker_type: "general", block: "debug" }, true],
  ]
  for (const [name, extra, expected] of cases) {
    it(`${expected ? "counts" : "does not count"} ${name}`, () => {
      expect(DagBlocks.isWriterNode(def("n", extra))).toBe(expected)
    })
  }

  it("finds exactly the two coding blocks of a compiled parallel route, not the aggregator or lanes", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver two slices",
      blocks: [
        { id: "plan", kind: "plan" },
        { id: "slice-a", kind: "coding", depends_on: ["plan"] },
        { id: "slice-b", kind: "coding", depends_on: ["plan"] },
        { id: "gates", kind: "verify", depends_on: ["slice-a", "slice-b"] },
        { id: "decision", kind: "review", depends_on: ["gates"] },
        { id: "final", kind: "synthesize", depends_on: ["decision"] },
      ],
    })
    // The route really contains the generated aggregator, so the exclusion is exercised.
    expect(nodes.some((node) => node.aggregates_writers === true)).toBe(true)
    expect(DagWriteGuard.writerIDs(nodes)).toEqual(["slice-a", "slice-b"])
  })
})

describe("DagWriteGuard.hasUnorderedWriters", () => {
  it("needs two writers", () => {
    expect(DagWriteGuard.hasUnorderedWriters([])).toBe(false)
    expect(DagWriteGuard.hasUnorderedWriters([def("a")])).toBe(false)
    expect(DagWriteGuard.hasUnorderedWriters([def("a"), def("scan", { worker_type: "explore" })])).toBe(false)
  })

  it("is true when two writers have no dependency path", () => {
    expect(DagWriteGuard.hasUnorderedWriters([def("a"), def("b")])).toBe(true)
  })

  it("is false for a direct or transitive order", () => {
    expect(DagWriteGuard.hasUnorderedWriters([def("a"), def("b", { depends_on: ["a"] })])).toBe(false)
    expect(
      DagWriteGuard.hasUnorderedWriters([
        def("a"),
        def("gate", { worker_type: "auditor", depends_on: ["a"] }),
        def("b", { depends_on: ["gate"] }),
      ]),
    ).toBe(false)
  })

  it("is true as soon as one pair is unordered", () => {
    expect(DagWriteGuard.hasUnorderedWriters([def("a"), def("b", { depends_on: ["a"] }), def("c")])).toBe(true)
  })

  it("tolerates a dependency that names an unknown node and a shared ancestor", () => {
    expect(
      DagWriteGuard.hasUnorderedWriters([
        def("root"),
        def("a", { depends_on: ["root", "ghost"] }),
        def("b", { depends_on: ["root"] }),
      ]),
    ).toBe(true)
  })
})

describe("DagWriteGuard messages", () => {
  it("tells the plan agent which nodes write and where to go next", () => {
    const message = DagWriteGuard.planRejection("extend", ["impl", "docs"])
    expect(message).toContain("Workflow extend rejected")
    expect(message).toContain("impl, docs")
    expect(message).toContain("Switch to build before running the implementation phase")
    expect(message).toContain("plan_exit")
  })

  it("names the workflow, session and nodes of a write conflict and the way out", () => {
    const conflict: DagWriteGuard.WriteConflict = {
      workflowID: "dag_other",
      sessionID: "ses_other",
      directory: "/repo",
      liveNodes: ["a", "b"],
      newNodes: ["c"],
    }
    const start = DagWriteGuard.writeConflictMessage("start", [conflict])
    expect(start).toContain('workspace "/repo" is being written by workflow dag_other (session ses_other')
    expect(start).toContain("a, b")
    expect(start).toContain("config.isolation: worktree")
    expect(start).toContain("wait for that workflow to finish")
    const extend = DagWriteGuard.writeConflictMessage("extend", [conflict, { ...conflict, workflowID: "dag_third" }])
    expect(extend).toContain("dag_other")
    expect(extend).toContain("dag_third")
    expect(extend).toContain("isolation: worktree")
    expect(extend).not.toContain("config.isolation")
  })

  it("words the way out for a replan and a recover by what each can change", () => {
    const conflict: DagWriteGuard.WriteConflict = {
      workflowID: "dag_other",
      sessionID: "ses_other",
      directory: "/repo",
      liveNodes: ["a"],
      newNodes: ["c"],
    }
    const replan = DagWriteGuard.writeConflictMessage("replan", [conflict])
    expect(replan).toContain("Workflow replan rejected")
    expect(replan).toContain("this replan also writes there (c)")
    expect(replan).toContain("added, restarted or replaced write-capable node(s) isolation: worktree")
    expect(replan).toContain("wait for that workflow to finish")
    // A recovery re-runs the stored definitions: there is no isolation to add.
    const recover = DagWriteGuard.writeConflictMessage("recover", [conflict])
    expect(recover).toContain("Workflow recover rejected")
    expect(recover).toContain("this recover also writes there (c)")
    expect(recover).toContain("wait for that workflow to finish, then recover again")
    expect(recover).not.toContain("isolation: worktree")
  })
})

describe("DagWriteGuard.replanNewRuns", () => {
  const row = (id: string, status: string, dependsOn: string[] = []) => makeNodeRow({ id, status, dependsOn })
  const rows = [
    row("running", "running"),
    row("queued", "queued"),
    row("pending", "pending"),
    row("done", "completed"),
    row("gone", "pending"),
  ]

  it("runs added ids, restarted nodes, and pending or queued replacements", () => {
    const fragment = [
      def("running", { restart: true, worker_type: "general" }),
      def("queued", { worker_type: "general" }),
      def("pending", { worker_type: "general" }),
      def("added", { worker_type: "general" }),
    ]
    expect(DagWriteGuard.replanNewRuns(rows, fragment)?.map((node) => node.id)).toEqual([
      "running",
      "queued",
      "pending",
      "added",
    ])
  })

  it("keeps a re-stated running node on its current run and ignores terminal and cancelled nodes", () => {
    const fragment = [
      def("running"),
      def("done"),
      def("gone", { cancel: true }),
      def("added", { worker_type: "explore" }),
    ]
    expect(DagWriteGuard.replanNewRuns(rows, fragment)?.map((node) => node.id)).toEqual(["added"])
  })

  it("returns undefined when the fragment does not plan, so the real replan can say why", () => {
    expect(DagWriteGuard.replanNewRuns(rows, [def("added", { depends_on: ["missing"] })])).toBeUndefined()
    expect(DagWriteGuard.replanNewRuns(rows, [def("ghost", { restart: true })])).toBeUndefined()
  })

  it("returns undefined when a stored node status is not one the planner knows", () => {
    expect(
      DagWriteGuard.replanNewRuns([row("odd", "mystery")], [def("added", { worker_type: "general" })]),
    ).toBeUndefined()
  })
})

describe("DagWriteGuard.recoveryNewRuns", () => {
  const config = (nodes: NodeConfig[]): WorkflowConfig => ({ name: "recover", nodes })
  const failed = (id: string, dependsOn: string[] = []) =>
    makeNodeRow({ id, status: "failed", dependsOn, required: true })
  const waiting = (id: string, dependsOn: string[]) =>
    makeNodeRow({ id, status: "skipped", dependsOn, required: false })
  const done = (id: string, dependsOn: string[] = []) => makeNodeRow({ id, status: "completed", dependsOn })

  it("covers the selected node and everything downstream of it", () => {
    const nodes = [
      def("scan", { worker_type: "explore" }),
      def("impl", { depends_on: ["scan"], required: false }),
      def("report", { worker_type: "auditor", depends_on: ["impl"], required: false }),
    ]
    const runs = DagWriteGuard.recoveryNewRuns({
      config: config(nodes),
      rows: [failed("scan"), waiting("impl", ["scan"]), waiting("report", ["impl"])],
      nodeIDs: ["scan"],
      graphRev: 1,
    })
    expect(runs?.map((node) => node.worker_type)).toEqual(["explore", "build", "auditor"])
    expect(DagWriteGuard.writerIDs(runs ?? [])).toHaveLength(1)
    expect(runs?.[1]?.id).toBe("impl__attempt_2_r2")
  })

  it("leaves completed upstream work out", () => {
    const nodes = [def("impl"), def("verify-impl", { worker_type: "verify", depends_on: ["impl"], required: false })]
    const runs = DagWriteGuard.recoveryNewRuns({
      config: config(nodes),
      rows: [done("impl"), failed("verify-impl", ["impl"])],
      nodeIDs: ["verify-impl"],
      graphRev: 3,
    })
    expect(runs?.map((node) => node.worker_type)).toEqual(["verify"])
    expect(DagWriteGuard.writerIDs(runs ?? [])).toEqual([])
  })

  it("returns undefined when the recovery does not plan, so the real recover can say why", () => {
    expect(
      DagWriteGuard.recoveryNewRuns({
        config: config([def("scan")]),
        rows: [failed("scan")],
        nodeIDs: ["not-a-node"],
        graphRev: 1,
      }),
    ).toBeUndefined()
  })
})

describe("DagWriteGuard.unisolatedWriters and writeConflicts", () => {
  it("places writers by their workspace and skips isolated or read-only nodes", () => {
    const placed = DagWriteGuard.unisolatedWriters(
      [
        def("shared"),
        def("elsewhere", { workspace: "/nope/other-checkout" }),
        def("own-tree", { isolation: "worktree" }),
        def("scan", { worker_type: "explore" }),
      ],
      "/nope/project",
    )
    expect(placed).toEqual([
      { id: "shared", directory: "/nope/project" },
      { id: "elsewhere", directory: "/nope/other-checkout" },
    ])
  })

  it("reports each live workflow that shares a directory with a new writer", () => {
    const live: DagWriteGuard.LiveWriters[] = [
      { workflowID: "dag_a", sessionID: "ses_a", directory: "/p", nodeIDs: ["x"] },
      { workflowID: "dag_b", sessionID: "ses_b", directory: "/q", nodeIDs: ["y"] },
      { workflowID: "dag_c", sessionID: "ses_c", directory: "/p", nodeIDs: ["z"] },
    ]
    const conflicts = DagWriteGuard.writeConflicts(live, [
      { id: "n1", directory: "/p" },
      { id: "n2", directory: "/p" },
    ])
    expect(conflicts.map((conflict) => [conflict.workflowID, conflict.newNodes])).toEqual([
      ["dag_a", ["n1", "n2"]],
      ["dag_c", ["n1", "n2"]],
    ])
    expect(DagWriteGuard.writeConflicts(live, [{ id: "n3", directory: "/elsewhere" }])).toEqual([])
    expect(DagWriteGuard.writeConflicts([], [{ id: "n3", directory: "/p" }])).toEqual([])
  })
})

describe("DagWriteGuard.liveWriters", () => {
  const configOf = (nodes: NodeConfig[]) => JSON.stringify({ name: "wf", nodes })
  const workflow = (id: string, status: string, nodes: NodeConfig[], extra: Partial<DagStore.WorkflowRow> = {}) =>
    makeWorkflowRow({ id, status, sessionId: `ses_${id}`, directory: "/nope/p", config: configOf(nodes), ...extra })

  const fakeStore = (
    workflows: DagStore.WorkflowRow[],
    rows: Record<string, DagStore.NodeRow[]>,
    asked?: string[],
  ): DagStore.Interface =>
    ({
      listByStatus: (status: string) =>
        Effect.sync(() => {
          asked?.push(status)
          return workflows.filter((candidate) => candidate.status === status)
        }),
      getCurrentNodes: (id: string) => Effect.succeed(rows[id] ?? []),
    }) as unknown as DagStore.Interface

  it("asks only for the statuses that can still schedule work", async () => {
    const asked: string[] = []
    await Effect.runPromise(DagWriteGuard.liveWriters(fakeStore([], {}, asked)))
    expect(asked).toEqual(["pending", "running", "paused", "stepping"])
  })

  it("lists unfinished unisolated writers, including those of a paused workflow", async () => {
    const store = fakeStore(
      [
        workflow("run", "running", [def("a"), def("b"), def("scan", { worker_type: "explore" })]),
        workflow("pause", "paused", [def("c")]),
      ],
      {
        run: [
          makeNodeRow({ id: "a", status: "running" }),
          makeNodeRow({ id: "b", status: "completed" }),
          makeNodeRow({ id: "scan", status: "running", workerType: "explore" }),
        ],
        pause: [makeNodeRow({ id: "c", status: "queued" })],
      },
    )
    const groups = await Effect.runPromise(DagWriteGuard.liveWriters(store))
    expect(groups).toEqual([
      { workflowID: "run", sessionID: "ses_run", directory: "/nope/p", nodeIDs: ["a"] },
      { workflowID: "pause", sessionID: "ses_pause", directory: "/nope/p", nodeIDs: ["c"] },
    ])
  })

  it("splits a workflow by directory and honors the execution directory", async () => {
    const store = fakeStore(
      [
        workflow("bound", "running", [def("a"), def("b", { workspace: "/nope/linked" })], {
          executionDirectory: "/nope/bound",
        }),
      ],
      { bound: [makeNodeRow({ id: "a", status: "pending" }), makeNodeRow({ id: "b", status: "pending" })] },
    )
    const groups = await Effect.runPromise(DagWriteGuard.liveWriters(store))
    expect(groups.map((group) => [group.directory, group.nodeIDs])).toEqual([
      ["/nope/bound", ["a"]],
      ["/nope/linked", ["b"]],
    ])
  })

  it("skips node-isolated writers, the excluded workflow, and workflows whose config cannot be read", async () => {
    const store = fakeStore(
      [
        workflow("mine", "running", [def("a")]),
        workflow("isolated", "running", [def("a", { isolation: "worktree" })]),
        workflow("broken", "running", [], { config: "{}" }),
        workflow("done", "running", [def("a")]),
      ],
      {
        mine: [makeNodeRow({ id: "a", status: "running" })],
        isolated: [makeNodeRow({ id: "a", status: "running" })],
        done: [makeNodeRow({ id: "a", status: "failed" })],
      },
    )
    expect(await Effect.runPromise(DagWriteGuard.liveWriters(store, "mine"))).toEqual([])
  })
})

describe("DagWriteGuard.defaultIsolation", () => {
  const strict = { review_gate: "strict" } as const
  const parallel = (): NodeConfig[] => [
    def("a"),
    def("b"),
    def("verify", { worker_type: "auditor", depends_on: ["a", "b"] }),
  ]

  const repo = async (init?: (directory: string) => Promise<void>) =>
    tmpdir({ git: true, init: async (directory) => init?.(directory) })

  it("applies to a strict workflow with unordered writers in a clean git checkout", async () => {
    await using tmp = await repo()
    const decision = DagWriteGuard.defaultIsolation({ config: strict, nodes: parallel(), directory: tmp.path })
    expect(decision.kind).toBe("apply")
    expect(decision.kind === "apply" ? decision.notice : "").toContain("never merged automatically")
  })

  it("treats a deep workflow as strict", async () => {
    await using tmp = await repo()
    const decision = DagWriteGuard.defaultIsolation({
      config: { mode: "deep" },
      nodes: parallel(),
      directory: tmp.path,
    })
    expect(decision.kind).toBe("apply")
  })

  it("does not apply to a standard workflow, ordered writers, or a single writer", async () => {
    await using tmp = await repo()
    const base = { directory: tmp.path }
    expect(DagWriteGuard.defaultIsolation({ ...base, config: { review_gate: "standard" }, nodes: parallel() })).toEqual(
      {
        kind: "none",
      },
    )
    expect(DagWriteGuard.defaultIsolation({ ...base, config: {}, nodes: parallel() })).toEqual({ kind: "none" })
    expect(
      DagWriteGuard.defaultIsolation({
        ...base,
        config: strict,
        nodes: [def("a"), def("b", { depends_on: ["a"] })],
      }),
    ).toEqual({ kind: "none" })
    expect(DagWriteGuard.defaultIsolation({ ...base, config: strict, nodes: [def("a")] })).toEqual({ kind: "none" })
  })

  it("leaves a document that already binds a workspace or isolation alone", async () => {
    await using tmp = await repo()
    const base = { directory: tmp.path }
    const bound = [
      DagWriteGuard.defaultIsolation({ ...base, config: { ...strict, workspace: tmp.path }, nodes: parallel() }),
      DagWriteGuard.defaultIsolation({ ...base, config: { ...strict, isolation: "worktree" }, nodes: parallel() }),
      DagWriteGuard.defaultIsolation({
        ...base,
        config: strict,
        nodes: [def("a", { workspace: tmp.path }), def("b")],
      }),
      DagWriteGuard.defaultIsolation({
        ...base,
        config: strict,
        nodes: [def("a", { isolation: "worktree" }), def("b")],
      }),
    ]
    expect(bound).toEqual([{ kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "none" }])
  })

  it("skips a checkout with uncommitted changes and says why", async () => {
    await using tmp = await repo(async (directory) => {
      await fs.writeFile(path.join(directory, "wip.txt"), "unsaved work\n")
    })
    const decision = DagWriteGuard.defaultIsolation({ config: strict, nodes: parallel(), directory: tmp.path })
    expect(decision.kind).toBe("skip")
    if (decision.kind !== "skip") return
    expect(decision.reason).toBe("dirty")
    expect(decision.notice).toContain("uncommitted changes")
    expect(decision.notice).toContain("do not commit or stash")
    expect(decision.notice).toContain("fan_out")
  })

  it("skips a directory outside git and says writers can only run serially", async () => {
    await using tmp = await tmpdir()
    const decision = DagWriteGuard.defaultIsolation({ config: strict, nodes: parallel(), directory: tmp.path })
    expect(decision.kind).toBe("skip")
    if (decision.kind !== "skip") return
    expect(decision.reason).toBe("not-git")
    expect(decision.notice).toContain("not a git repository")
    expect(decision.notice).toContain("serially")
  })

  it("skips a repository with no commit to branch from", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    const decision = DagWriteGuard.defaultIsolation({ config: strict, nodes: parallel(), directory: tmp.path })
    expect(decision.kind).toBe("skip")
    if (decision.kind !== "skip") return
    expect(decision.reason).toBe("no-commits")
    expect(decision.notice).toContain("no commits")
  })
})
