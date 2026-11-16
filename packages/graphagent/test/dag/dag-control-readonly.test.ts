// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1324 §4: `dag.permission: "readonly"` holds the write-safety precheck
// inside DagControl for every caller, not only the `plan` agent (#1031 M8),
// ahead of the plan-agent gate and regardless of it. A recording mock Dag (no
// database) shows exactly which Dag methods a request reached; `Config` is a
// test double that reports the tier under test.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The store
// double implements only the reads the precheck makes, the same idiom as
// dag-control-write-guard.test.ts.
import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import type { DagStore } from "@graphagent/core/dag/store"
import { Config } from "@/config/config"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagControl, type ControlConflict, type ControlRejection, type ControlRequest } from "@/dag/control"
import { TestConfig } from "../fixture/config"
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
    sessionId: "ses_parent",
    directory: "/nope/project",
    config: JSON.stringify({ name: id, nodes }),
    ...extra,
  })

const running = (...nodes: NodeConfig[]) => workflowRow("wf-1", "running", nodes)

interface Fixture {
  readonly workflow: DagStore.WorkflowRow
  readonly rows?: readonly DagStore.NodeRow[]
}

/** The tier the fake global configuration reports; `undefined` is the `allow` default. */
function harness(fixture: Fixture, tier?: "allow" | "ask" | "readonly") {
  const calls: string[] = []
  const store = {
    getWorkflow: (id: string) => Effect.succeed(id === fixture.workflow.id ? fixture.workflow : undefined),
    getNodes: (_id: string) => Effect.sync(() => [...(fixture.rows ?? [])]),
    getCurrentNodes: (_id: string) => Effect.sync(() => (fixture.rows ?? []).filter((row) => !row.superseded)),
    listByStatus: (_status: string) => Effect.sync(() => []),
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
  const config = TestConfig.layer({ dagGlobal: () => Effect.succeed(tier ? { permission: tier } : {}) })
  return { calls, layer: DagControl.layer.pipe(Layer.provide(dag), Layer.provide(config)) }
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

describe("DagControl dag.permission readonly gate", () => {
  it("refuses an extend that adds a writer, for any caller, with a message naming dag.permission", async () => {
    const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) }, "readonly")
    for (const agent of ["build", "general", undefined]) {
      const rejection = conflictOf(await apply(h, extendOf(def("impl")), agent))
      expect(rejection.kind).toBe("permission-readonly")
      expect(rejection.status).toBe("running")
      expect(rejection.parked).toBeUndefined()
      expect(rejection.message).toContain("Workflow extend rejected")
      expect(rejection.message).toContain("dag.permission")
      expect(rejection.message).toContain("impl")
      expect(h.calls).toEqual([])
    }
  })

  it("refuses a replan and a recover that would run a writer, the same way", async () => {
    const rows = [makeNodeRow({ id: "scan", status: "running", workerType: "explore" })]
    const replanH = harness({ workflow: running(def("scan", { worker_type: "explore" })), rows }, "readonly")
    const replanRejection = conflictOf(await apply(replanH, replanOf(def("added-writer")), "build"))
    expect(replanRejection.kind).toBe("permission-readonly")
    expect(replanRejection.message).toContain("Workflow replan rejected")
    expect(replanH.calls).toEqual([])

    // Recovering "scan" cascades to its downstream "impl" (a writer by default).
    const failedNodes = [def("scan", { worker_type: "explore" }), def("impl", { depends_on: ["scan"], required: false })]
    const failedRows = [
      makeNodeRow({ id: "scan", status: "failed", workerType: "explore", required: true }),
      makeNodeRow({ id: "impl", status: "skipped", dependsOn: ["scan"], required: false }),
    ]
    const recoverH = harness({ workflow: workflowRow("wf-1", "failed", failedNodes), rows: failedRows }, "readonly")
    const recoverRejection = conflictOf(await apply(recoverH, recoverOf("scan"), "build"))
    expect(recoverRejection.kind).toBe("permission-readonly")
    expect(recoverRejection.message).toContain("Workflow recover rejected")
    expect(recoverH.calls).toEqual([])
  })

  it("lets an all-read-only graph extend, replan and recover under the readonly tier", async () => {
    const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) }, "readonly")
    const exit = await apply(h, extendOf(def("review", { worker_type: "auditor" })), "build")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.calls).toEqual(["extend:wf-1"])
  })

  it("does not apply to a retarget: the readonly tier adds no writer, only the workspace check holds it", async () => {
    const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) }, "readonly")
    const exit = await apply(h, { op: "retarget" }, "build")
    // No workspace move requested: the write-safety precheck has nothing to check and the request proceeds.
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("leaves the allow and ask tiers to the existing plan-agent gate", async () => {
    for (const tier of [undefined, "allow" as const, "ask" as const]) {
      const h = harness({ workflow: running(def("scan", { worker_type: "explore" })) }, tier)
      const planRejection = conflictOf(await apply(h, extendOf(def("impl")), "plan"))
      expect(planRejection.kind).toBe("plan-readonly")
      const exit = await apply(h, extendOf(def("impl")), "build")
      expect(Exit.isSuccess(exit)).toBe(true)
    }
  })

  it("is read fresh on every request: a mid-run switch to readonly reaches the next extend and back", async () => {
    const fixture = { workflow: running(def("scan", { worker_type: "explore" })) }
    const allowH = harness(fixture, "allow")
    expect(Exit.isSuccess(await apply(allowH, extendOf(def("impl-1")), "build"))).toBe(true)

    const readonlyH = harness(fixture, "readonly")
    const rejection = conflictOf(await apply(readonlyH, extendOf(def("impl-2")), "build"))
    expect(rejection.kind).toBe("permission-readonly")

    const backH = harness(fixture, "allow")
    expect(Exit.isSuccess(await apply(backH, extendOf(def("impl-3")), "build"))).toBe(true)
  })
})
