// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3b-2: what the join node's admission check decides, and what recovery and replan do to the two marks a
// compose node carries (`expand` on a slot, `join` on the join node it becomes). All of it is pure; the scheduler
// around it is covered by dag-compose-runtime.test.ts, and the durable writes by dag-compose-expansion.test.ts.
import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { planRecovery } from "@/dag/recovery-plan"
import { ReplanDefinition } from "@/dag/replan-definition"
import { catalog, composerOf } from "./compose-fixtures"
import { makeNodeRow } from "./fixtures"

type Join = DagCompose.Join

const item = (id: string, required = false): Join["items"][number] => ({
  id,
  node: `survey--${id}`,
  agent: "explore",
  required,
})
const join = (items: Join["items"], degraded?: string): Join => ({
  plan: "survey--split",
  items,
  ...(degraded !== undefined ? { degraded } : {}),
})
/** The children the check can find, by node id. A node that is not listed is gone. */
const children =
  (states: Record<string, DagCompose.JoinChild>) =>
  (node: string): DagCompose.JoinChild | undefined =>
    states[node]
const done = { status: "completed", output: { artifact: "code_findings" } }
const failed = { status: "failed", output: null }

describe("the join node's admission check", () => {
  it("runs when every item's child completed with an output", () => {
    const verdict = DagCompose.checkJoin(
      join([item("official", true), item("code")]),
      children({ "survey--official": done, "survey--code": { status: "completed", output: "plain text" } }),
    )
    expect(verdict).toEqual({ kind: "run" })
  })

  it("runs when only items that may be left out have nothing, as long as one item has something", () => {
    const verdict = DagCompose.checkJoin(
      join([item("official", true), item("code"), item("security")]),
      children({ "survey--official": done, "survey--code": failed }),
    )
    expect(verdict).toEqual({ kind: "run" })
  })

  it("refuses with compose_required_missing when a required item's child failed, and names the item", () => {
    const verdict = DagCompose.checkJoin(
      join([item("official"), item("security", true)]),
      children({ "survey--official": done, "survey--security": failed }),
    )
    if (verdict.kind !== "refuse") throw new Error("expected the join to be refused")
    expect(verdict.errorClass).toBe("compose_required_missing")
    expect(verdict.errorClass).toBe(DagCompose.REQUIRED_MISSING)
    expect(verdict.reason).toContain('"security" (survey--security: failed)')
    // It is the required item that is the cause: the optional one that did produce something is not blamed.
    expect(verdict.reason).not.toContain('"official"')
  })

  it("names every required item that has nothing, and only those", () => {
    const verdict = DagCompose.checkJoin(
      join([item("a", true), item("b", true), item("c"), item("d", true)]),
      children({ "survey--b": failed, "survey--d": done }),
    )
    if (verdict.kind !== "refuse") throw new Error("expected the join to be refused")
    expect(verdict.errorClass).toBe(DagCompose.REQUIRED_MISSING)
    expect(verdict.reason).toContain('"a" (survey--a: gone)')
    expect(verdict.reason).toContain('"b" (survey--b: failed)')
    expect(verdict.reason).not.toContain('"c"')
    expect(verdict.reason).not.toContain('"d"')
  })

  it("counts a child with no output, whatever became of it, as missing", () => {
    const states: Record<string, DagCompose.JoinChild | undefined> = {
      failed,
      skipped: { status: "skipped", output: null },
      aborted: { status: "aborted", output: null },
      // The scheduler's own "completed without output".
      completed_null: { status: "completed", output: null },
      completed_undefined: { status: "completed", output: undefined },
      // Nothing is a result until the child has completed, whatever it left in its row.
      running: { status: "running", output: "partial" },
      pending: { status: "pending", output: null },
      gone: undefined,
    }
    for (const [name, state] of Object.entries(states)) {
      const verdict = DagCompose.checkJoin(join([item("only", true)]), () => state)
      expect(verdict.kind, name).toBe("refuse")
    }
  })

  it("says what became of a child that completed without an output", () => {
    const verdict = DagCompose.checkJoin(
      join([item("only", true)]),
      children({ "survey--only": { status: "completed", output: null } }),
    )
    expect(verdict.kind === "refuse" && verdict.reason).toContain("survey--only: completed without output")
  })

  it("refuses with compose_no_results when no child has anything, though none was required", () => {
    const verdict = DagCompose.checkJoin(
      join([item("official"), item("code")]),
      children({ "survey--official": failed, "survey--code": { status: "skipped", output: null } }),
    )
    if (verdict.kind !== "refuse") throw new Error("expected the join to be refused")
    expect(verdict.errorClass).toBe("compose_no_results")
    expect(verdict.errorClass).toBe(DagCompose.NO_RESULTS)
    expect(verdict.reason).toContain('"official" (survey--official: failed)')
    expect(verdict.reason).toContain('"code" (survey--code: skipped)')
  })

  it("refuses a degraded expansion whose fallback worker has nothing with compose_no_results", () => {
    const record = join(
      [{ id: "fallback", node: "survey--fallback", agent: "explore", required: false }],
      "the plan was rejected",
    )
    const refused = DagCompose.checkJoin(record, children({ "survey--fallback": failed }))
    if (refused.kind !== "refuse") throw new Error("expected the join to be refused")
    expect(refused.errorClass).toBe(DagCompose.NO_RESULTS)
    expect(refused.reason).toContain("the fallback worker produced no result")
    expect(refused.reason).toContain("survey--fallback: failed")
    expect(DagCompose.checkJoin(record, children({ "survey--fallback": done }))).toEqual({ kind: "run" })
  })

  it("lets a required item decide first when both checks would refuse", () => {
    const verdict = DagCompose.checkJoin(join([item("a", true), item("b")]), children({}))
    expect(verdict.kind === "refuse" && verdict.errorClass).toBe(DagCompose.REQUIRED_MISSING)
  })

  it("refuses a join record with nothing in it: there is no item to join", () => {
    const verdict = DagCompose.checkJoin(join([]), children({}))
    expect(verdict.kind === "refuse" && verdict.errorClass).toBe(DagCompose.NO_RESULTS)
    expect(verdict.kind === "refuse" && verdict.reason).toContain("no item to join")
  })

  it("reads what the expansion wrote: a join node built from a plan is checked by its own record", () => {
    const composer = composerOf("surveyor")
    const slot = DagCompose.compileNodes(
      DagBlocks.compileWorkflowBlocks({
        objective: "Compare three session persistence designs",
        blocks: [new DagBlocks.WorkflowBlock({ id: "survey", kind: "compose", worker_type: "surveyor" })],
      }),
      catalog(),
      DagCompose.DEFAULT_LIMITS,
    ).nodes.find((node) => node.id === "survey")
    if (!slot) throw new Error("the block compiled to no slot")
    const output = {
      rationale: "split by source",
      items: [
        { id: "official", agent: "researcher", instruction: "Look into official" },
        { id: "security", agent: "auditor", instruction: "Look into security" },
      ],
      not_planned: [],
    }
    const expansion = DagCompose.planExpansion({
      slot,
      composer,
      limits: DagCompose.DEFAULT_LIMITS,
      source: { status: "completed", output },
      existingNodeIDs: new Set(),
    })
    const joined = expansion.nodes.at(-1)?.join
    if (!joined) throw new Error("the expansion wrote no join record")
    // `auditor` fails the plan when it is missing, so its item is required; `researcher` may be left out.
    expect(joined.items.map((entry) => [entry.id, entry.required])).toEqual([
      ["official", false],
      ["security", true],
    ])
    const verdict = DagCompose.checkJoin(joined, children({ "survey--official": done, "survey--security": failed }))
    expect(verdict.kind === "refuse" && verdict.errorClass).toBe(DagCompose.REQUIRED_MISSING)
    expect(DagCompose.checkJoin(joined, children({ "survey--official": failed, "survey--security": done }))).toEqual({
      kind: "run",
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------------------------------------------

/** The compose block `survey`, compiled; with `upstream`, behind a block `map` that it reads for itself. */
const surveyBlock = (upstream = false) =>
  DagCompose.compileNodes(
    DagBlocks.compileWorkflowBlocks({
      objective: "Compare three session persistence designs",
      blocks: [
        ...(upstream ? [new DagBlocks.WorkflowBlock({ id: "map", kind: "explore" })] : []),
        new DagBlocks.WorkflowBlock({
          id: "survey",
          kind: "compose",
          worker_type: "surveyor",
          instruction: "Compare the designs",
          ...(upstream ? { depends_on: ["map"] } : {}),
        }),
      ],
    }),
    catalog(),
    DagCompose.DEFAULT_LIMITS,
  ).nodes

const report: NodeConfig = {
  id: "report",
  name: "report",
  worker_type: "build",
  depends_on: ["survey"],
  required: true,
  prompt_template: { inline: "Report on {{survey}}" },
}

const plan = (...ids: [string, string][]) => ({
  rationale: "split by source",
  items: ids.map(([id, agent]) => ({ id, agent, instruction: `Look into ${id}` })),
  not_planned: [],
})

/** The block the way the scheduler leaves it after expanding the slot: the split node, the children and the join node. */
function expandedRoute(output: unknown, upstream = false): NodeConfig[] {
  const nodes = surveyBlock(upstream)
  const slot = nodes.find((node) => node.id === "survey")
  if (!slot) throw new Error("the block compiled to no slot")
  const expansion = DagCompose.planExpansion({
    slot,
    composer: composerOf("surveyor"),
    limits: DagCompose.DEFAULT_LIMITS,
    source: { status: "completed", output },
    existingNodeIDs: new Set(nodes.map((node) => node.id)),
  })
  return [...nodes.filter((node) => node.id !== "survey"), ...expansion.nodes, report]
}

const row = (node: NodeConfig, status: string, extra: Partial<Parameters<typeof makeNodeRow>[0]> = {}) =>
  makeNodeRow({
    id: node.id,
    name: node.name,
    workerType: node.worker_type,
    status,
    required: node.required ?? false,
    dependsOn: node.depends_on,
    ...extra,
  })

const config = (nodes: NodeConfig[]): WorkflowConfig => ({ name: "compose-recovery", nodes })

/** Every node `skipped` the way termination leaves the ones that never ran, except the ones named. */
const terminated = (nodes: NodeConfig[], statuses: Record<string, string>) =>
  nodes.map((node) =>
    statuses[node.id] !== undefined
      ? row(node, statuses[node.id], statuses[node.id] === "failed" ? { errorReason: "boom" } : {})
      : row(node, "skipped", { errorReason: "workflow_failed" }),
  )

/**
 * The ids of a join record are the keys the join node reads its inputs under, each naming itself, and the prompt
 * describes each of them. `own` are the inputs the block reads for itself, which are none of that.
 */
const expectInputsFollowRecord = (node: NodeConfig | undefined, own: Record<string, string> = {}) => {
  const record = node?.join
  if (!node || !record) throw new Error("not a join node")
  const ids = [record.plan, ...record.items.map((entry) => entry.node)]
  expect(node.input_mapping).toEqual({ ...own, ...Object.fromEntries(ids.map((id) => [id, id])) })
  for (const id of ids) expect(node.prompt_template.inline, id).toContain(`\n- "${id}": `)
  // Every line that describes a key is one of those: nothing is left describing an attempt that was replaced.
  const described = [...(node.prompt_template.inline ?? "").matchAll(/\n- "([^"\n]*)": /g)].map((match) => match[1])
  expect(described.sort()).toEqual([...ids].sort())
}

describe("recovering a compose node", () => {
  it("points a slot that has not been expanded at the recovered split node", () => {
    const nodes = [...surveyBlock(), report]
    const recovered = planRecovery(
      config(nodes),
      terminated(nodes, { "survey--split": "failed" }),
      ["survey--split"],
      2,
      3,
    )
    const splitID = "survey--split__attempt_2_r2"
    const slot = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    expect(slot?.id).toBe("survey__attempt_2_r2")
    expect(slot?.expand).toBe(splitID)
    expect(slot?.depends_on).toEqual([splitID])
    // Nothing else about the slot changed, and the original definition was not touched.
    expect(slot?.worker_type).toBe("surveyor")
    expect(nodes.find((node) => node.id === "survey")?.expand).toBe("survey--split")
  })

  it("leaves the split node alone when only the slot is recovered", () => {
    const nodes = [...surveyBlock(), report]
    const rows = terminated(nodes, { "survey--split": "completed" })
    const recovered = planRecovery(config(nodes), rows, ["survey"], 2, 3)
    expect(recovered.reused).toEqual(["survey--split"])
    const slot = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    expect(slot?.expand).toBe("survey--split")
  })

  it("points the join node at the recovered child of an item, and keeps the children that are reused", () => {
    const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]))
    const rows = terminated(nodes, {
      "survey--split": "completed",
      "survey--official": "completed",
      "survey--code": "failed",
    })
    const recovered = planRecovery(config(nodes), rows, ["survey--code"], 2, 3)
    const codeID = "survey--code__attempt_2_r2"
    expect(recovered.reused.sort()).toEqual(["survey--official", "survey--split"])
    const joinNode = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    expect(joinNode?.depends_on).toEqual(["survey--official", codeID])
    expect(joinNode?.join?.plan).toBe("survey--split")
    expect(joinNode?.join?.items.map((entry) => [entry.id, entry.node, entry.agent, entry.required])).toEqual([
      ["official", "survey--official", "researcher", false],
      ["code", codeID, "explore", false],
    ])
    // A join node never carries a slot's marker.
    expect(joinNode?.expand).toBeUndefined()
    // The keys it reads its inputs under, and the prompt that describes them, follow the record.
    expectInputsFollowRecord(joinNode)
    expect(joinNode?.input_mapping).toEqual({
      "survey--split": "survey--split",
      "survey--official": "survey--official",
      [codeID]: codeID,
    })
    expect(joinNode?.prompt_template.inline).toContain(`\n- "${codeID}": item "code", by explore; may be skipped.`)
    expect(joinNode?.prompt_template.inline).not.toContain('\n- "survey--code": ')
    // The definition the recovery started from keeps naming the attempt it was written against.
    const before = nodes.find((node) => node.id === "survey")
    expect(before?.join?.items.map((entry) => entry.node)).toEqual(["survey--official", "survey--code"])
    expect(before?.input_mapping).toHaveProperty("survey--code", "survey--code")
    expect(before?.prompt_template.inline).toContain('\n- "survey--code": ')
  })

  it("points the join node at every recovered attempt when the split node is recovered", () => {
    const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]))
    const rows = terminated(nodes, { "survey--split": "failed" })
    const recovered = planRecovery(config(nodes), rows, ["survey--split"], 2, 3)
    const attempt = (id: string) => `${id}__attempt_2_r2`
    const joinNode = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    expect(joinNode?.join?.plan).toBe(attempt("survey--split"))
    expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual([
      attempt("survey--official"),
      attempt("survey--code"),
    ])
    // The same attempts the join node now depends on and reads by node id, under keys that name them.
    expect(joinNode?.depends_on).toEqual([attempt("survey--official"), attempt("survey--code")])
    expectInputsFollowRecord(joinNode)
    expect(Object.keys(joinNode?.input_mapping ?? {}).sort()).toEqual(
      [attempt("survey--split"), attempt("survey--official"), attempt("survey--code")].sort(),
    )
    // The children wait for the recovered split node, which is their only dependency.
    for (const id of ["survey--official", "survey--code"])
      expect(recovered.config.nodes.find((node) => node.recovery?.logical_node_id === id)?.depends_on).toEqual([
        attempt("survey--split"),
      ])
  })

  it("points a degraded join node at the recovered fallback worker, and keeps why it was degraded", () => {
    const nodes = expandedRoute({ rationale: "nothing to split", items: [], not_planned: [] })
    const rows = terminated(nodes, { "survey--split": "completed", "survey--fallback": "failed" })
    const recovered = planRecovery(config(nodes), rows, ["survey--fallback"], 2, 3)
    const joinNode = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual(["survey--fallback__attempt_2_r2"])
    expect(joinNode?.join?.degraded).toBe("the plan has no items")
    expect(joinNode?.join?.plan).toBe("survey--split")
    expectInputsFollowRecord(joinNode)
    expect(joinNode?.prompt_template.inline).toContain('\n- "survey--fallback__attempt_2_r2": the whole task, by ')
  })

  it("keeps the name of an input the block reads for itself, and follows its source", () => {
    // `map` is the block's own input: its key is the block's word for it, not a node id of the expansion.
    const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]), true)
    const rows = terminated(nodes, { map: "completed", "survey--split": "completed", "survey--official": "completed" })
    const recovered = planRecovery(config(nodes), rows, ["map"], 2, 3)
    const joinNode = recovered.config.nodes.find((node) => node.recovery?.logical_node_id === "survey")
    const attempt = (id: string) => `${id}__attempt_2_r2`
    expectInputsFollowRecord(joinNode, { map: attempt("map") })
    expect(joinNode?.join?.plan).toBe(attempt("survey--split"))
    expect(joinNode?.depends_on).toEqual([attempt("survey--official"), attempt("survey--code")])
  })

  it("keeps a join node that no recovered node touches as it is, keys and prompt included", () => {
    const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]))
    const rows = terminated(nodes, {
      "survey--split": "completed",
      "survey--official": "completed",
      "survey--code": "completed",
      survey: "completed",
      report: "failed",
    })
    const recovered = planRecovery(config(nodes), rows, ["report"], 2, 3)
    expect(recovered.superseded).toEqual(["report"])
    expect(recovered.config.nodes.find((node) => node.id === "survey")).toEqual(
      nodes.find((node) => node.id === "survey"),
    )
  })

  it("keeps pointing the join node at the right attempts through a second recovery", () => {
    const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]))
    const first = planRecovery(
      config(nodes),
      terminated(nodes, { "survey--split": "completed", "survey--official": "completed", "survey--code": "failed" }),
      ["survey--code"],
      2,
      3,
    )
    // The recovered child fails again.
    const secondRows = first.config.nodes.map((node) =>
      row(
        node,
        node.id === "survey--split" || node.id === "survey--official"
          ? "completed"
          : node.id === "survey--code__attempt_2_r2"
            ? "failed"
            : "skipped",
        node.id === "survey--code__attempt_2_r2" ? { errorReason: "boom" } : { errorReason: "workflow_failed" },
      ),
    )
    const second = planRecovery(first.config, secondRows, ["survey--code__attempt_2_r2"], 3, 3)
    const joinNode = second.config.nodes.find((node) => node.recovery?.attempt === 3 && node.join !== undefined)
    expect(joinNode?.join?.items.map((entry) => entry.node)).toEqual(["survey--official", "survey--code__attempt_3_r3"])
    expect(joinNode?.depends_on).toEqual(["survey--official", "survey--code__attempt_3_r3"])
    // The keys follow the record again, and nothing of the first recovery is left in them or in the prompt.
    expectInputsFollowRecord(joinNode)
    expect(joinNode?.prompt_template.inline).not.toContain("survey--code__attempt_2_r2")
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Replan
// ---------------------------------------------------------------------------------------------------------------

describe("what a replan may do to the marks of a compose node", () => {
  const nodes = expandedRoute(plan(["official", "researcher"], ["code", "explore"]))
  const joinNode = nodes.find((node) => node.id === "survey")
  const slot = surveyBlock().find((node) => node.id === "survey")
  if (!joinNode?.join || !slot?.expand) throw new Error("the route has no slot or join node")
  const record = joinNode.join

  it("counts expand and join among the fields an admitted node cannot change", () => {
    const { join: _join, ...withoutJoin } = joinNode
    const { expand: _expand, ...withoutExpand } = slot
    expect(ReplanDefinition.changedAdmittedNodeFields(joinNode, withoutJoin, { allowTimeoutUpdate: true })).toEqual([
      "join",
    ])
    expect(ReplanDefinition.changedAdmittedNodeFields(slot, withoutExpand, { allowTimeoutUpdate: true })).toEqual([
      "expand",
    ])
    // Restating the definition as it is changes nothing.
    expect(
      ReplanDefinition.changedAdmittedNodeFields(joinNode, structuredClone(joinNode), { allowTimeoutUpdate: false }),
    ).toEqual([])
  })

  it("reports nothing for a node restated as it is, or one that carries no mark", () => {
    expect(ReplanDefinition.changedEngineOwnedFields(joinNode, structuredClone(joinNode))).toEqual([])
    expect(ReplanDefinition.changedEngineOwnedFields(slot, structuredClone(slot))).toEqual([])
    expect(ReplanDefinition.changedEngineOwnedFields(report, { ...report, name: "a new name" })).toEqual([])
  })

  it("reports the join record of a join node that a replacement drops or rewrites", () => {
    const { join: _join, ...withoutJoin } = joinNode
    expect(ReplanDefinition.changedEngineOwnedFields(joinNode, withoutJoin)).toEqual(["join"])
    const rewritten = { ...joinNode, join: { ...record, items: record.items.slice(1) } }
    expect(ReplanDefinition.changedEngineOwnedFields(joinNode, rewritten)).toEqual(["join"])
    const repointed = { ...joinNode, join: { ...record, plan: "somewhere-else" } }
    expect(ReplanDefinition.changedEngineOwnedFields(joinNode, repointed)).toEqual(["join"])
  })

  it("reports the marker of a slot that a replacement drops or rewrites", () => {
    const { expand: _expand, ...withoutExpand } = slot
    expect(ReplanDefinition.changedEngineOwnedFields(slot, withoutExpand)).toEqual(["expand"])
    expect(ReplanDefinition.changedEngineOwnedFields(slot, { ...slot, expand: "somewhere-else" })).toEqual(["expand"])
  })

  it("lets the expansion turn the slot into its join node, which is the one writer of that change", () => {
    // The replacement the scheduler writes carries the join record and no marker.
    const { expand: _expand, ...definition } = slot
    expect(ReplanDefinition.changedEngineOwnedFields(slot, { ...definition, join: record })).toEqual([])
    // A replacement that merely lacks the marker is no expansion.
    expect(ReplanDefinition.changedEngineOwnedFields(slot, definition)).toEqual(["expand"])
  })
})
