// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M8: the write-safety precheck inside DagControl. The plan agent may only
// run read-only nodes through extend/replan/recover, and none of the three may
// newly run a writer next to another live workflow's unfinished writer; a
// retarget may not move one there either. Like the resume guard, a refusal parks
// nothing and mutates nothing. A recording mock Dag (no database) shows exactly
// which Dag methods a request reached.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The store double
// implements only the reads the precheck makes.
import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DagStore } from "@graphagent/core/dag/store"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagControl, type ControlConflict, type ControlRejection, type ControlRequest } from "@/dag/control"
import { tmpdir } from "../fixture/fixture"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const caller = (agent?: string) => ({ sessionID: "ses_parent", ...(agent ? { agent } : {}) })

const def = (id: string, extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: id },
  ...extra,
})

const workflowRow = (id: string, status: string, nodes: NodeConfig[], extra: Partial<DagStore.WorkflowRow> = {}) =>
  makeWorkflowRow({
    id,
    status,
    sessionId: id === "wf-1" ? "ses_parent" : `ses_${id}`,
    directory: "/nope/project",
    config: JSON.stringify({ name: id, nodes }),
    ...extra,
  })

interface Fixture {
  /** The workflow under control (its row config lists `nodes`). */
  readonly workflow: DagStore.WorkflowRow
  readonly rows?: readonly DagStore.NodeRow[]
  /** Other workflows the store lists as live, with the rows of each. */
  readonly others?: ReadonlyArray<{ workflow: DagStore.WorkflowRow; rows: readonly DagStore.NodeRow[] }>
}

function harness(fixture: Fixture) {
  const calls: string[] = []
  const reads: string[] = []
  const everyone = [fixture.workflow, ...(fixture.others ?? []).map((other) => other.workflow)]
  const rowsOf = (id: string) =>
    id === fixture.workflow.id
      ? (fixture.rows ?? [])
      : (fixture.others?.find((other) => other.workflow.id === id)?.rows ?? [])
  const store = {
    getWorkflow: (id: string) => Effect.succeed(everyone.find((candidate) => candidate.id === id)),
    getNodes: (id: string) => Effect.sync(() => [...rowsOf(id)]),
    getCurrentNodes: (id: string) => Effect.sync(() => rowsOf(id).filter((row) => !row.superseded)),
    listByStatus: (status: string) =>
      Effect.sync(() => {
        reads.push(status)
        return everyone.filter((candidate) => candidate.status === status)
      }),
  } as unknown as DagStore.Interface
  const record = <K extends keyof Dag.Interface>(name: K, result: unknown) =>
    ((...args: unknown[]) => {
      calls.push(`${name}:${String(args[0])}`)
      return Effect.succeed(result)
    }) as unknown as Dag.Interface[K]
  const dag = Layer.mock(Dag.Service, {
    store,
    pause: record("pause", undefined),
    resume: record("resume", undefined),
    step: record("step", { status: "no_ready_nodes" }),
    cancel: record("cancel", undefined),
    replan: record("replan", { cancel: [], restart: [], replace: [], add: [], ignore: [] }),
    extend: record("extend", { cancel: [], restart: [], replace: [], add: [], ignore: [] }),
    recover: record("recover", { replacements: [], superseded: [], reused: [], preserved: [], graphRev: 2 }),
    retarget: record("retarget", { nodes: [], toFingerprint: { kind: "none" }, graphRev: 2 }),
  })
  return { calls, reads, layer: DagControl.layer.pipe(Layer.provide(dag)) }
}

type Harness = ReturnType<typeof harness>

function apply(harnessed: Harness, request: ControlRequest, agent?: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const control = yield* DagControl.Service
      return yield* Effect.exit(control.apply("wf-1", request, caller(agent)))
    }).pipe(Effect.provide(harnessed.layer)),
  )
}

function rejectionOf<A>(exit: Exit.Exit<A, ControlRejection>): ControlRejection {
  if (Exit.isSuccess(exit)) throw new Error("expected the request to be refused")
  const found = Cause.findErrorOption(exit.cause)
  if (Option.isNone(found)) throw new Error(`expected a typed rejection, got ${Cause.pretty(exit.cause)}`)
  return found.value
}

function conflictOf<A>(exit: Exit.Exit<A, ControlRejection>): ControlConflict {
  const rejection = rejectionOf(exit)
  if (rejection._tag !== "Conflict") throw new Error(`expected a Conflict, got ${rejection._tag}`)
  return rejection
}

const extendOf = (...nodes: NodeConfig[]): ControlRequest => ({ op: "extend", prepared: { action: "extend", nodes } })
const replanOf = (...nodes: NodeConfig[]): ControlRequest => ({ op: "replan", prepared: { action: "replan", nodes } })
const recoverOf = (...nodeIDs: string[]): ControlRequest => ({ op: "recover", nodeIDs, expectedGraphRev: 1 })
const retargetOf = (workspace: string | undefined, nodeIDs?: readonly string[]): ControlRequest => ({
  op: "retarget",
  ...(workspace !== undefined ? { workspace } : {}),
  ...(nodeIDs !== undefined ? { nodeIDs } : {}),
})

/** A retarget needs a real linked worktree: the target must belong to the same
 * git project and be listed by `git worktree list`. */
async function repoWithLinkedWorktree() {
  let linked = ""
  const tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      linked = path.join(os.tmpdir(), `retarget-linked-${Math.random().toString(36).slice(2)}`)
      await $`git worktree add --detach ${linked} HEAD`.cwd(directory).quiet()
      // macOS temp paths resolve through /private; match git's canonical form.
      linked = await fs.realpath(linked)
    },
    dispose: async () => {
      if (!linked) return
      try {
        await $`git worktree remove --force ${linked}`.quiet()
      } catch {
        // The sandbox cleanup removes leftovers.
      }
    },
  })
  return { tmp, linked }
}

const running = (...nodes: NodeConfig[]) => workflowRow("wf-1", "running", nodes)

describe("DagControl plan-agent gate", () => {
  it("refuses an extend that adds a writer, without parking or mutating", async () => {
    const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) })
    const rejection = conflictOf(
      await apply(h, extendOf(def("impl"), def("scan-2", { worker_type: "explore" })), "plan"),
    )
    expect(rejection.kind).toBe("plan-readonly")
    expect(rejection.status).toBe("running")
    expect(rejection.parked).toBeUndefined()
    expect(rejection.message).toContain("Workflow extend rejected")
    expect(rejection.message).toContain("impl")
    expect(rejection.message).not.toContain("scan-2")
    expect(rejection.message).toContain("Switch to build")
    expect(h.calls).toEqual([])
  })

  it("lets the plan agent extend with read-only nodes", async () => {
    const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) })
    const exit = await apply(
      h,
      extendOf(def("review", { worker_type: "auditor" }), def("notes", { worker_type: "plan", block: "plan" })),
      "plan",
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.calls).toEqual(["extend:wf-1"])
  })

  it("holds only the plan agent to it: build, other agents, and a caller without an agent extend freely", async () => {
    for (const agent of ["build", "general", undefined]) {
      const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) })
      const exit = await apply(h, extendOf(def("impl")), agent)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(h.calls).toEqual(["extend:wf-1"])
    }
  })

  it("refuses a replan that adds, restarts, or replaces with a writer", async () => {
    const rows = [
      makeNodeRow({ id: "run-writer", status: "running" }),
      makeNodeRow({ id: "wait-scan", status: "pending", workerType: "explore" }),
    ]
    const nodes = [def("run-writer"), def("wait-scan", { worker_type: "explore" })]
    const fragments: ReadonlyArray<readonly [string, NodeConfig[], string]> = [
      ["adds a writer", [def("added-writer")], "added-writer"],
      ["restarts a running writer", [def("run-writer", { restart: true })], "run-writer"],
      ["replaces a pending node with a writer", [def("wait-scan", { worker_type: "general" })], "wait-scan"],
    ]
    for (const [, fragment, writer] of fragments) {
      const h = harness({ workflow: running(...nodes), rows })
      const rejection = conflictOf(await apply(h, replanOf(...fragment), "plan"))
      expect(rejection.kind).toBe("plan-readonly")
      expect(rejection.message).toContain("Workflow replan rejected")
      expect(rejection.message).toContain(writer)
      expect(h.calls).toEqual([])
    }
  })

  it("lets a replan through when no writer would newly run", async () => {
    const rows = [
      makeNodeRow({ id: "run-writer", status: "running" }),
      makeNodeRow({ id: "wait-scan", status: "pending", workerType: "explore" }),
    ]
    const h = harness({ workflow: running(def("run-writer"), def("wait-scan", { worker_type: "explore" })), rows })
    // The running writer is merely re-stated (it keeps its current run) and the
    // pending explore node is replaced by another read-only definition.
    const exit = await apply(
      h,
      replanOf(
        def("run-writer"),
        def("wait-scan", { worker_type: "auditor" }),
        def("more", { worker_type: "explore" }),
      ),
      "plan",
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.calls).toEqual(["replan:wf-1"])
  })

  it("leaves an unplannable replan to the real mutation", async () => {
    const h = harness({
      workflow: running(def("scan", { worker_type: "explore" })),
      rows: [makeNodeRow({ id: "scan", status: "running" })],
    })
    const exit = await apply(h, replanOf(def("impl", { depends_on: ["missing"] })), "plan")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.calls).toEqual(["replan:wf-1"])
  })

  it("refuses a recover whose replacement attempts include a writer, even a downstream one", async () => {
    const nodes = [def("scan", { worker_type: "explore" }), def("impl", { depends_on: ["scan"], required: false })]
    const rows = [
      makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true }),
      makeNodeRow({ id: "impl", status: "skipped", dependsOn: ["scan"], required: false }),
    ]
    const h = harness({ workflow: workflowRow("wf-1", "failed", nodes), rows })
    const rejection = conflictOf(await apply(h, recoverOf("scan"), "plan"))
    expect(rejection.kind).toBe("plan-readonly")
    expect(rejection.status).toBe("failed")
    expect(rejection.message).toContain("Workflow recover rejected")
    expect(rejection.message).toContain("impl__attempt_2_r2")
    expect(h.calls).toEqual([])
  })

  it("lets a recover through when every replacement is read-only", async () => {
    const nodes = [
      def("scan", { worker_type: "explore" }),
      def("report", { worker_type: "auditor", depends_on: ["scan"], required: false }),
    ]
    const rows = [
      makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true }),
      makeNodeRow({ id: "report", status: "skipped", workerType: "auditor", dependsOn: ["scan"], required: false }),
    ]
    const h = harness({ workflow: workflowRow("wf-1", "failed", nodes), rows })
    const exit = await apply(h, recoverOf("scan"), "plan")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.calls).toEqual(["recover:wf-1"])
  })

  it("leaves an unplannable or unreadable recover to the real mutation", async () => {
    const rows = [makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true })]
    const unknown = harness({
      workflow: workflowRow("wf-1", "failed", [def("scan", { worker_type: "explore" })]),
      rows,
    })
    expect(Exit.isSuccess(await apply(unknown, recoverOf("ghost"), "plan"))).toBe(true)
    expect(unknown.calls).toEqual(["recover:wf-1"])
    const unreadable = harness({ workflow: workflowRow("wf-1", "failed", [], { config: "not json" }), rows })
    expect(Exit.isSuccess(await apply(unreadable, recoverOf("scan"), "plan"))).toBe(true)
    expect(unreadable.calls).toEqual(["recover:wf-1"])
  })

  it("does not gate the ops that add no work", async () => {
    for (const request of [{ op: "pause" }, { op: "resume" }, { op: "step" }, { op: "cancel" }] as const) {
      const h = harness({ workflow: running(def("impl")), rows: [makeNodeRow({ id: "impl", status: "pending" })] })
      expect(Exit.isSuccess(await apply(h, request, "plan"))).toBe(true)
      expect(h.calls).toEqual([`${request.op}:wf-1`])
    }
  })
})

describe("DagControl cross-workflow write conflicts on extend, replan and recover", () => {
  const other = (
    id: string,
    status: string,
    nodes: NodeConfig[],
    rows: DagStore.NodeRow[],
    extra: Partial<DagStore.WorkflowRow> = {},
  ) => ({ workflow: workflowRow(id, status, nodes, extra), rows })
  const busy = [makeNodeRow({ id: "x", status: "running" })]

  it("refuses an extend that adds a writer beside another workflow's unfinished writer", async () => {
    const h = harness({
      workflow: running(def("scan", { worker_type: "explore" })),
      others: [other("wf-2", "running", [def("x")], busy)],
    })
    const rejection = conflictOf(await apply(h, extendOf(def("impl")), "build"))
    expect(rejection.kind).toBe("write-conflict")
    expect(rejection.status).toBe("running")
    expect(rejection.parked).toBeUndefined()
    expect(rejection.message).toContain("Workflow extend rejected")
    expect(rejection.message).toContain('workspace "/nope/project"')
    expect(rejection.message).toContain("workflow wf-2 (session ses_wf-2")
    expect(rejection.message).toContain("isolation: worktree")
    expect(h.calls).toEqual([])
    expect(h.reads).toEqual(["pending", "running", "paused", "stepping"])
  })

  it("counts the pending writers of a paused workflow, and any session's workflow", async () => {
    const h = harness({
      workflow: running(def("scan", { worker_type: "explore" })),
      others: [other("wf-2", "paused", [def("x")], [makeNodeRow({ id: "x", status: "pending" })])],
    })
    expect(rejectionOf(await apply(h, extendOf(def("impl")))).message).toContain("wf-2")
  })

  it("lets an extend through when the other workflow cannot clash", async () => {
    const scenarios: ReadonlyArray<readonly [string, ReturnType<typeof other>]> = [
      [
        "its writer has finished",
        other("wf-2", "running", [def("x")], [makeNodeRow({ id: "x", status: "completed" })]),
      ],
      ["its writer runs in its own worktree", other("wf-2", "running", [def("x", { isolation: "worktree" })], busy)],
      ["it only reads", other("wf-2", "running", [def("x", { worker_type: "explore" })], busy)],
      ["it works in another directory", other("wf-2", "running", [def("x")], busy, { directory: "/nope/elsewhere" })],
      [
        "it is isolated at workflow level (its execution directory is its own worktree)",
        other("wf-2", "running", [def("x")], busy, { executionDirectory: "/nope/project-wt" }),
      ],
      [
        "its writer was replaced in a later revision",
        other("wf-2", "running", [def("x")], [makeNodeRow({ id: "x", status: "running", superseded: true })]),
      ],
      ["its config cannot be read", other("wf-2", "running", [], busy, { config: "{}" })],
      ["it is already finished", other("wf-2", "completed", [def("x")], busy)],
    ]
    for (const [, scenario] of scenarios) {
      const h = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: [scenario] })
      expect(Exit.isSuccess(await apply(h, extendOf(def("impl")), "build"))).toBe(true)
      expect(h.calls).toEqual(["extend:wf-1"])
    }
  })

  it("does not count the workflow being extended against itself", async () => {
    const h = harness({
      workflow: running(def("x")),
      rows: [makeNodeRow({ id: "x", status: "running" })],
    })
    expect(Exit.isSuccess(await apply(h, extendOf(def("impl")), "build"))).toBe(true)
    expect(h.calls).toEqual(["extend:wf-1"])
  })

  it("never looks at other workflows for a read-only extend or isolated writers", async () => {
    const clash = [other("wf-2", "running", [def("x")], busy)]
    const readOnly = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: clash })
    expect(Exit.isSuccess(await apply(readOnly, extendOf(def("review", { worker_type: "auditor" })), "build"))).toBe(
      true,
    )
    expect(readOnly.reads).toEqual([])
    const isolated = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: clash })
    expect(Exit.isSuccess(await apply(isolated, extendOf(def("impl", { isolation: "worktree" })), "build"))).toBe(true)
    expect(isolated.reads).toEqual([])
  })

  it("places new writers by their own workspace and the workflow's execution directory", async () => {
    const clash = [other("wf-2", "running", [def("x", { workspace: "/nope/linked" })], busy)]
    const elsewhere = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: clash })
    expect(Exit.isSuccess(await apply(elsewhere, extendOf(def("impl")), "build"))).toBe(true)
    const linked = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: clash })
    const rejection = rejectionOf(await apply(linked, extendOf(def("impl", { workspace: "/nope/linked" })), "build"))
    expect(rejection.message).toContain('workspace "/nope/linked"')
    const bound = harness({
      workflow: workflowRow("wf-1", "running", [def("scan", { worker_type: "explore" })], {
        executionDirectory: "/nope/linked",
      }),
      others: clash,
    })
    expect(rejectionOf(await apply(bound, extendOf(def("impl")), "build")).message).toContain("wf-2")
  })

  it("refuses a replan that adds, restarts, or replaces with a writer beside another workflow's writer", async () => {
    const rows = [
      makeNodeRow({ id: "run-writer", status: "running" }),
      makeNodeRow({ id: "wait-scan", status: "pending", workerType: "explore" }),
    ]
    const nodes = [def("run-writer"), def("wait-scan", { worker_type: "explore" })]
    const fragments: ReadonlyArray<readonly [NodeConfig[], string]> = [
      [[def("added-writer")], "added-writer"],
      [[def("run-writer", { restart: true })], "run-writer"],
      [[def("wait-scan", { worker_type: "general" })], "wait-scan"],
    ]
    for (const [fragment, writer] of fragments) {
      const h = harness({ workflow: running(...nodes), rows, others: [other("wf-2", "running", [def("x")], busy)] })
      const rejection = conflictOf(await apply(h, replanOf(...fragment), "build"))
      expect(rejection.kind).toBe("write-conflict")
      expect(rejection.status).toBe("running")
      expect(rejection.parked).toBeUndefined()
      expect(rejection.message).toContain("Workflow replan rejected")
      expect(rejection.message).toContain("workflow wf-2 (session ses_wf-2")
      expect(rejection.message).toContain(`this replan also writes there (${writer})`)
      expect(h.calls).toEqual([])
    }
  })

  it("lets a replan through when nothing it newly runs can clash", async () => {
    const rows = [
      makeNodeRow({ id: "run-writer", status: "running" }),
      makeNodeRow({ id: "wait-scan", status: "pending", workerType: "explore" }),
    ]
    const nodes = [def("run-writer"), def("wait-scan", { worker_type: "explore" })]
    // A re-stated running writer keeps its run; read-only and isolated nodes never
    // share the workspace, so the other workflows are not even read.
    const quiet = harness({
      workflow: running(...nodes),
      rows,
      others: [other("wf-2", "running", [def("x")], busy)],
    })
    const exit = await apply(
      quiet,
      replanOf(
        def("run-writer"),
        def("wait-scan", { worker_type: "auditor" }),
        def("added-isolated", { isolation: "worktree" }),
      ),
      "build",
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(quiet.reads).toEqual([])
    expect(quiet.calls).toEqual(["replan:wf-1"])
    // The other workflow's writer has finished: the query runs and nothing clashes.
    const finished = harness({
      workflow: running(...nodes),
      rows,
      others: [other("wf-2", "running", [def("x")], [makeNodeRow({ id: "x", status: "completed" })])],
    })
    expect(Exit.isSuccess(await apply(finished, replanOf(def("added-writer")), "build"))).toBe(true)
    expect(finished.reads).toEqual(["pending", "running", "paused", "stepping"])
    expect(finished.calls).toEqual(["replan:wf-1"])
  })

  it("leaves an unplannable replan to the real mutation without reading other workflows", async () => {
    const h = harness({
      workflow: running(def("scan", { worker_type: "explore" })),
      rows: [makeNodeRow({ id: "scan", status: "running", workerType: "explore" })],
      others: [other("wf-2", "running", [def("x")], busy)],
    })
    expect(Exit.isSuccess(await apply(h, replanOf(def("impl", { depends_on: ["missing"] })), "build"))).toBe(true)
    expect(h.reads).toEqual([])
    expect(h.calls).toEqual(["replan:wf-1"])
  })

  it("refuses a recover that re-runs a writer beside another workflow's writer, even a downstream one", async () => {
    const clash = [other("wf-2", "running", [def("x")], busy)]
    const direct = harness({
      workflow: workflowRow("wf-1", "failed", [def("impl")]),
      rows: [makeNodeRow({ id: "impl", status: "failed", required: true })],
      others: clash,
    })
    const refused = conflictOf(await apply(direct, recoverOf("impl"), "build"))
    expect(refused.kind).toBe("write-conflict")
    expect(refused.status).toBe("failed")
    expect(refused.parked).toBeUndefined()
    expect(refused.message).toContain("Workflow recover rejected")
    expect(refused.message).toContain("workflow wf-2 (session ses_wf-2")
    expect(refused.message).toContain("this recover also writes there (impl__attempt_2_r2)")
    expect(refused.message).toContain("wait for that workflow to finish, then recover again")
    expect(direct.calls).toEqual([])
    const downstream = harness({
      workflow: workflowRow("wf-1", "failed", [
        def("scan", { worker_type: "explore" }),
        def("impl", { depends_on: ["scan"], required: false }),
      ]),
      rows: [
        makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true }),
        makeNodeRow({ id: "impl", status: "skipped", dependsOn: ["scan"], required: false }),
      ],
      others: clash,
    })
    expect(conflictOf(await apply(downstream, recoverOf("scan"), "build")).message).toContain("impl__attempt_2_r2")
    expect(downstream.calls).toEqual([])
  })

  it("lets a recover through when every replacement is read-only or nothing clashes", async () => {
    const readOnly = harness({
      workflow: workflowRow("wf-1", "failed", [def("scan", { worker_type: "explore" })]),
      rows: [makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true })],
      others: [other("wf-2", "running", [def("x")], busy)],
    })
    expect(Exit.isSuccess(await apply(readOnly, recoverOf("scan"), "build"))).toBe(true)
    expect(readOnly.reads).toEqual([])
    const quiet = harness({
      workflow: workflowRow("wf-1", "failed", [def("impl")]),
      rows: [makeNodeRow({ id: "impl", status: "failed", required: true })],
      others: [other("wf-2", "running", [def("x")], [makeNodeRow({ id: "x", status: "completed" })])],
    })
    expect(Exit.isSuccess(await apply(quiet, recoverOf("impl"), "build"))).toBe(true)
    expect(quiet.reads).toEqual(["pending", "running", "paused", "stepping"])
    expect(quiet.calls).toEqual(["recover:wf-1"])
  })

  it("leaves an unplannable or unreadable recover to the real mutation without reading other workflows", async () => {
    const rows = [makeNodeRow({ id: "impl", status: "failed", required: true })]
    const clash = [other("wf-2", "running", [def("x")], busy)]
    const unknown = harness({ workflow: workflowRow("wf-1", "failed", [def("impl")]), rows, others: clash })
    expect(Exit.isSuccess(await apply(unknown, recoverOf("ghost"), "build"))).toBe(true)
    expect(unknown.reads).toEqual([])
    expect(unknown.calls).toEqual(["recover:wf-1"])
    const unreadable = harness({
      workflow: workflowRow("wf-1", "failed", [], { config: "not json" }),
      rows,
      others: clash,
    })
    expect(Exit.isSuccess(await apply(unreadable, recoverOf("impl"), "build"))).toBe(true)
    expect(unreadable.reads).toEqual([])
    expect(unreadable.calls).toEqual(["recover:wf-1"])
  })

  it("does not count the workflow being replanned against itself", async () => {
    const h = harness({
      workflow: running(def("run-writer")),
      rows: [makeNodeRow({ id: "run-writer", status: "running" })],
    })
    expect(Exit.isSuccess(await apply(h, replanOf(def("run-writer", { restart: true })), "build"))).toBe(true)
    // The query ran (the writer is unisolated) and found only the workflow itself.
    expect(h.reads).toEqual(["pending", "running", "paused", "stepping"])
    expect(h.calls).toEqual(["replan:wf-1"])
  })

  it("reports the plan refusal first when the plan agent would also share a workspace", async () => {
    const clash = [other("wf-2", "running", [def("x")], busy)]
    const extend = harness({ workflow: running(def("scan", { worker_type: "explore" })), others: clash })
    expect(conflictOf(await apply(extend, extendOf(def("impl")), "plan")).kind).toBe("plan-readonly")
    expect(extend.reads).toEqual([])
    const replan = harness({
      workflow: running(def("scan", { worker_type: "explore" })),
      rows: [makeNodeRow({ id: "scan", status: "running", workerType: "explore" })],
      others: clash,
    })
    expect(conflictOf(await apply(replan, replanOf(def("impl")), "plan")).kind).toBe("plan-readonly")
    expect(replan.reads).toEqual([])
    const recover = harness({
      workflow: workflowRow("wf-1", "failed", [def("impl")]),
      rows: [makeNodeRow({ id: "impl", status: "failed", required: true })],
      others: clash,
    })
    expect(conflictOf(await apply(recover, recoverOf("impl"), "plan")).kind).toBe("plan-readonly")
    expect(recover.reads).toEqual([])
  })
})

describe("DagControl cross-workflow write conflicts on retarget", () => {
  const otherIn = (
    directory: string,
    nodes: NodeConfig[] = [def("x")],
    rows: DagStore.NodeRow[] = [makeNodeRow({ id: "x", status: "running" })],
    extra: Partial<DagStore.WorkflowRow> = {},
  ) => ({ workflow: workflowRow("wf-2", "running", nodes, { directory, ...extra }), rows })

  it("refuses a retarget that moves a pending or queued writer next to another workflow's writer", async () => {
    for (const status of ["pending", "queued"]) {
      const { tmp, linked } = await repoWithLinkedWorktree()
      await using _ = tmp
      const h = harness({
        workflow: workflowRow("wf-1", "running", [def("impl")], { directory: tmp.path }),
        rows: [makeNodeRow({ id: "impl", status })],
        others: [otherIn(linked)],
      })
      const rejection = conflictOf(await apply(h, retargetOf(linked), "build"))
      expect(rejection.kind).toBe("write-conflict")
      expect(rejection.status).toBe("running")
      expect(rejection.parked).toBeUndefined()
      expect(rejection.message).toContain("Workflow retarget rejected")
      expect(rejection.message).toContain(`workspace "${linked}"`)
      expect(rejection.message).toContain("workflow wf-2 (session ses_wf-2")
      expect(rejection.message).toContain("this retarget would move write-capable node(s) there (impl)")
      expect(rejection.message).toContain("retarget to a linked worktree no other live workflow is writing")
      expect(rejection.message).toContain("isolation: worktree with a replan")
      expect(rejection.message).toContain("wait for that workflow to finish")
      expect(h.calls).toEqual([])
      expect(h.reads).toEqual(["pending", "running", "paused", "stepping"])
    }
  })

  it("counts the other workflow by where it runs: its execution directory, or where a running node started", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const mine = () => workflowRow("wf-1", "running", [def("impl")], { directory: tmp.path })
    const rows = [makeNodeRow({ id: "impl", status: "pending" })]
    const bound = harness({
      workflow: mine(),
      rows,
      others: [otherIn(tmp.path, [def("x")], undefined, { executionDirectory: linked })],
    })
    expect(conflictOf(await apply(bound, retargetOf(linked), "build")).message).toContain("workflow wf-2")
    // A workflow that was itself retargeted away still has a running writer where it started.
    const started = harness({
      workflow: mine(),
      rows,
      others: [
        otherIn(tmp.path, [def("x")], [makeNodeRow({ id: "x", status: "running", directory: linked })], {
          executionDirectory: path.join(tmp.path, "moved-elsewhere"),
        }),
      ],
    })
    expect(conflictOf(await apply(started, retargetOf(linked), "build")).message).toContain("workflow wf-2")
  })

  it("moves the running target-sensitive writers it restarts, as narrowed by node_ids", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const nodes = [
      def("impl", { target_sensitive: true }),
      def("judge", { worker_type: "auditor", target_sensitive: true }),
    ]
    const rows = [
      makeNodeRow({ id: "impl", status: "running" }),
      makeNodeRow({ id: "judge", status: "running", workerType: "auditor" }),
    ]
    const fixture = () => ({
      workflow: workflowRow("wf-1", "running", nodes, { directory: tmp.path }),
      rows,
      others: [otherIn(linked)],
    })
    for (const nodeIDs of [undefined, ["impl"], ["impl", "judge"]]) {
      const h = harness(fixture())
      expect(conflictOf(await apply(h, retargetOf(linked, nodeIDs), "build")).message).toContain("(impl)")
      expect(h.calls).toEqual([])
    }
    // Restarting only the judge moves no writer.
    const judge = harness(fixture())
    expect(Exit.isSuccess(await apply(judge, retargetOf(linked, ["judge"]), "build"))).toBe(true)
    expect(judge.reads).toEqual([])
    expect(judge.calls).toEqual(["retarget:wf-1"])
    // node_ids the real retarget would reject are left to it.
    for (const nodeIDs of [[], ["ghost"]]) {
      const h = harness(fixture())
      expect(Exit.isSuccess(await apply(h, retargetOf(linked, nodeIDs), "build"))).toBe(true)
      expect(h.reads).toEqual([])
      expect(h.calls).toEqual(["retarget:wf-1"])
    }
  })

  it("leaves a running writer it does not restart where it is", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const h = harness({
      workflow: workflowRow("wf-1", "running", [def("impl")], { directory: tmp.path }),
      rows: [makeNodeRow({ id: "impl", status: "running" })],
      others: [otherIn(linked)],
    })
    expect(Exit.isSuccess(await apply(h, retargetOf(linked), "build"))).toBe(true)
    expect(h.reads).toEqual([])
    expect(h.calls).toEqual(["retarget:wf-1"])
  })

  it("lets a retarget through when nothing it moves can clash", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const mine = (nodes: NodeConfig[], rows: DagStore.NodeRow[]) => ({
      workflow: workflowRow("wf-1", "running", nodes, { directory: tmp.path }),
      rows,
    })
    const pending = (...ids: string[]) => ids.map((id) => makeNodeRow({ id, status: "pending" }))
    const scenarios: ReadonlyArray<readonly [string, ReturnType<typeof mine>, ReturnType<typeof otherIn>]> = [
      [
        "the other writer has finished",
        mine([def("impl")], pending("impl")),
        otherIn(linked, [def("x")], [makeNodeRow({ id: "x", status: "completed" })]),
      ],
      [
        "the other writer runs in its own worktree",
        mine([def("impl")], pending("impl")),
        otherIn(linked, [def("x", { isolation: "worktree" })]),
      ],
      [
        "the other workflow only reads",
        mine([def("impl")], pending("impl")),
        otherIn(linked, [def("x", { worker_type: "explore" })]),
      ],
      [
        "the other workflow works elsewhere",
        mine([def("impl")], pending("impl")),
        otherIn(path.join(tmp.path, "elsewhere")),
      ],
      ["the moved nodes only read", mine([def("scan", { worker_type: "explore" })], pending("scan")), otherIn(linked)],
      [
        "the moved writer has its own worktree",
        mine([def("impl", { isolation: "worktree" })], pending("impl")),
        otherIn(linked),
      ],
      [
        "the moved writer has its own workspace",
        mine([def("impl", { workspace: tmp.path })], pending("impl")),
        otherIn(linked),
      ],
    ]
    for (const [, fixture, other] of scenarios) {
      const h = harness({ ...fixture, others: [other] })
      expect(Exit.isSuccess(await apply(h, retargetOf(linked), "build"))).toBe(true)
      expect(h.calls).toEqual(["retarget:wf-1"])
    }
  })

  it("lets a retarget through that rebinds nothing, and leaves a retarget the real mutation will refuse to it", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const nodes = [def("impl")]
    const rows = [makeNodeRow({ id: "impl", status: "pending" })]
    const clash = [otherIn(linked), otherIn(tmp.path)]
    const cases: ReadonlyArray<readonly [string, DagStore.WorkflowRow, ControlRequest]> = [
      [
        "no workspace (only the fingerprint)",
        workflowRow("wf-1", "running", nodes, { directory: tmp.path }),
        retargetOf(undefined),
      ],
      [
        "the workflow's own directory",
        workflowRow("wf-1", "running", nodes, { directory: tmp.path }),
        retargetOf(tmp.path),
      ],
      [
        "its own bound worktree",
        workflowRow("wf-1", "running", nodes, { directory: tmp.path, executionDirectory: linked }),
        retargetOf(linked),
      ],
      [
        "an unresolvable workspace",
        workflowRow("wf-1", "running", nodes, { directory: tmp.path }),
        retargetOf(path.join(tmp.path, "missing")),
      ],
      ["a terminal workflow", workflowRow("wf-1", "failed", nodes, { directory: tmp.path }), retargetOf(linked)],
      [
        "a workflow-level worktree",
        workflowRow("wf-1", "running", nodes, {
          directory: tmp.path,
          config: JSON.stringify({ name: "wf-1", isolation: "worktree", nodes }),
        }),
        retargetOf(linked),
      ],
    ]
    for (const [, workflow, request] of cases) {
      const h = harness({ workflow, rows, others: clash })
      expect(Exit.isSuccess(await apply(h, request, "build"))).toBe(true)
      expect(h.reads).toEqual([])
      expect(h.calls).toEqual(["retarget:wf-1"])
    }
  })

  it("is not held to the plan gate, but still to the workspace check", async () => {
    const { tmp, linked } = await repoWithLinkedWorktree()
    await using _ = tmp
    const fixture = (others: ReturnType<typeof otherIn>[]) => ({
      workflow: workflowRow("wf-1", "running", [def("impl")], { directory: tmp.path }),
      rows: [makeNodeRow({ id: "impl", status: "pending" })],
      others,
    })
    // The plan agent adds no writer by retargeting one that already exists.
    const free = harness(fixture([]))
    expect(Exit.isSuccess(await apply(free, retargetOf(linked), "plan"))).toBe(true)
    expect(free.calls).toEqual(["retarget:wf-1"])
    const clash = harness(fixture([otherIn(linked)]))
    expect(conflictOf(await apply(clash, retargetOf(linked), "plan")).kind).toBe("write-conflict")
    expect(clash.calls).toEqual([])
  })
})
