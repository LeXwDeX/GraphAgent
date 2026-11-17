// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158: what a compose expansion that did not follow its plan adds to the coverage section (#1031), in the terms of a
// declined fan-out. The persisted `join` is read from definitions the engine's own expansion wrote, not from marks
// written by hand, so the test follows the shape the expansion gives them.
import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { coverageSection, workflowCoverage } from "@/dag/coverage"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { catalog, composerOf } from "./compose-fixtures"
import { makeNodeRow } from "./fixtures"

const limits = DagCompose.DEFAULT_LIMITS

/** The expansion slot of a compose block, compiled the way the authoring check compiles it. */
function slot(worker: string): NodeConfig {
  const nodes = DagBlocks.compileWorkflowBlocks({
    objective: "Compare three session persistence designs",
    blocks: [
      new DagBlocks.WorkflowBlock({ id: "survey", kind: "compose", worker_type: worker, instruction: "Compare" }),
    ],
  })
  const found = DagCompose.compileNodes(nodes, catalog(), limits).nodes.find((node) => node.id === "survey")
  if (!found) throw new Error("expected the slot")
  return found
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: "explore",
  instruction: `Look into ${id}`,
  ...extra,
})
const completedPlan = (items: unknown[]) => ({
  status: "completed",
  output: JSON.stringify({ rationale: "split by module", items, not_planned: [] }),
})

/** The workflow's current state after an expansion: its definitions, and a completed row for each. */
function afterExpansion(nodes: readonly NodeConfig[], extra: Partial<WorkflowConfig> = {}) {
  const config: WorkflowConfig = { name: "compose-coverage", nodes: [...nodes], ...extra }
  return { config, rows: nodes.map((node) => makeNodeRow({ id: node.id, status: "completed" })) }
}

describe("coverage of a compose expansion", () => {
  it("lists nothing when the expansion followed its plan", () => {
    const expanded = DagCompose.planExpansion({
      slot: slot("mapper"),
      composer: composerOf("mapper"),
      limits,
      source: completedPlan([item("core"), item("docs")]),
      existingNodeIDs: new Set(),
    })
    if (expanded.kind !== "expand") throw new Error("expected the plan to be expanded")
    const { config, rows } = afterExpansion(expanded.nodes)
    expect(workflowCoverage({ config, nodes: rows })).toEqual([])
  })

  it("lists a degraded expansion on the join node, with the reason, the way a declined fan-out is", () => {
    for (const [reason, why] of [
      ["the plan has no items", "the plan has no items"],
      [
        'the split node "survey--split" failed: the model gave up',
        'the split node "survey--split" failed: the model gave up',
      ],
      // Braces and parentheses are not kept in a reason, since it is also prompt text.
      ["the plan was rejected: items (3) {x}", "the plan was rejected: items 3 x"],
    ] as const) {
      const degraded = DagCompose.degrade(slot("surveyor"), composerOf("surveyor"), reason)
      const { config, rows } = afterExpansion(degraded.nodes)
      expect(workflowCoverage({ config, nodes: rows }), reason).toEqual([
        { node_id: "survey", reason: `compose expansion degraded: ${why}` },
      ])
    }
  })

  it("lists an item that asked to be split again and ran as one worker, on that item's node", () => {
    // `mapper` splits recursively, and a plan one level deep may not nest: both items run as plain workers.
    const expanded = DagCompose.planExpansion({
      slot: slot("mapper"),
      composer: composerOf("mapper"),
      limits: { ...limits, maxDepth: 1 },
      source: completedPlan([item("core", { split: true }), item("docs", { split: true }), item("tests")]),
      existingNodeIDs: new Set(),
    })
    if (expanded.kind !== "expand") throw new Error("expected the plan to be expanded")
    const { config, rows } = afterExpansion(expanded.nodes)
    expect(workflowCoverage({ config, nodes: rows })).toEqual([
      {
        node_id: "survey--core",
        reason: "compose split declined: the expansion is already as deep as dag.compose.max_depth 1 allows",
      },
      {
        node_id: "survey--docs",
        reason: "compose split declined: the expansion is already as deep as dag.compose.max_depth 1 allows",
      },
    ])
  })

  it("lists an item the subtree had no room to split, with that reason", () => {
    const expanded = DagCompose.planExpansion({
      slot: slot("mapper"),
      composer: composerOf("mapper"),
      limits,
      // Two items, the room for two nodes: nothing is left to pay for a nested plan.
      position: { depth: 1, remainingNodes: 2 },
      source: completedPlan([item("core", { split: true }), item("docs")]),
      existingNodeIDs: new Set(),
    })
    if (expanded.kind !== "expand") throw new Error("expected the plan to be expanded")
    const { config, rows } = afterExpansion(expanded.nodes)
    const entries = workflowCoverage({ config, nodes: rows })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ node_id: "survey--core" })
    expect(entries[0]?.reason).toContain("compose split declined: the subtree has no room left for a nested plan")
  })

  it("does not list an item that was split: its nested expansion is one of its own", () => {
    const expanded = DagCompose.planExpansion({
      slot: slot("mapper"),
      composer: composerOf("mapper"),
      limits,
      source: completedPlan([item("core", { split: true }), item("docs")]),
      existingNodeIDs: new Set(),
    })
    if (expanded.kind !== "expand") throw new Error("expected the plan to be expanded")
    const join = expanded.nodes.find((node) => node.id === "survey")?.join
    expect(join?.items.find((entry) => entry.id === "core")).toMatchObject({ nested: true })
    const { config, rows } = afterExpansion(expanded.nodes)
    expect(workflowCoverage({ config, nodes: rows })).toEqual([])
  })

  it("lists a nested expansion that degraded on its own join node, and not the plan above it", () => {
    // The nested slot `survey--core` is expanded in its turn; its fallback worker took the whole item.
    const outer = DagCompose.planExpansion({
      slot: slot("mapper"),
      composer: composerOf("mapper"),
      limits,
      source: completedPlan([item("core", { split: true }), item("docs")]),
      existingNodeIDs: new Set(),
    })
    if (outer.kind !== "expand") throw new Error("expected the plan to be expanded")
    const nested = outer.nodes.find((node) => node.id === "survey--core")
    if (!nested) throw new Error("expected the nested slot")
    const degraded = DagCompose.degrade(nested, composerOf("mapper"), "the plan has no items")
    const nodes = [...outer.nodes.filter((node) => node.id !== "survey--core"), ...degraded.nodes]
    const { config, rows } = afterExpansion(nodes)
    expect(workflowCoverage({ config, nodes: rows })).toEqual([
      { node_id: "survey--core", reason: "compose expansion degraded: the plan has no items" },
    ])
  })

  it("renders the entries in the section the final report appends, in either language", () => {
    const degraded = DagCompose.degrade(slot("surveyor"), composerOf("surveyor"), "the plan has no items")
    const { config, rows } = afterExpansion(degraded.nodes)
    const entries = workflowCoverage({ config, nodes: rows })
    expect(coverageSection(entries, "en")).toBe(
      "## Coverage and truncation\n- survey: compose expansion degraded: the plan has no items",
    )
    expect(coverageSection(entries, "zh-CN")).toContain("- survey: compose expansion degraded: the plan has no items")
  })
})

describe("coverage of a compose node the engine failed", () => {
  // These are failed nodes: the entry every failed node gets carries the error class and the reason, and coverage adds
  // no second one for the compose kind of failure.
  const join = (...items: DagCompose.Join["items"]): DagCompose.Join => ({ plan: "survey--split", items })
  const required = { id: "security", node: "survey--security", agent: "auditor", required: true }
  const optional = { id: "official", node: "survey--official", agent: "researcher", required: false }

  it("lists a join node refused for a required item that has nothing, with its reason", () => {
    const verdict = DagCompose.checkJoin(join(required, optional), (id) =>
      id === "survey--official" ? { status: "completed", output: { artifact: "research_findings" } } : undefined,
    )
    if (verdict.kind !== "refuse") throw new Error("expected the join node to be refused")
    const row = makeNodeRow({
      id: "survey",
      status: "failed",
      errorClass: verdict.errorClass,
      errorReason: verdict.reason,
    })
    expect(workflowCoverage({ config: { name: "w", nodes: [] }, nodes: [row] })).toEqual([
      {
        node_id: "survey",
        reason: `failed: compose_required_missing: ${verdict.reason}`,
      },
    ])
    expect(verdict.reason).toContain('required item "security" (survey--security: gone) produced no result')
  })

  it("lists a join node none of whose children produced anything, and the slots that could not be expanded", () => {
    const verdict = DagCompose.checkJoin(join(optional), () => ({ status: "failed", output: null }))
    if (verdict.kind !== "refuse") throw new Error("expected the join node to be refused")
    const rows = [
      makeNodeRow({ id: "survey", status: "failed", errorClass: verdict.errorClass, errorReason: verdict.reason }),
      makeNodeRow({
        id: "survey-b",
        status: "failed",
        errorClass: "compose_capacity",
        errorReason: "Compose expansion does not fit the graph: too many nodes",
      }),
      makeNodeRow({
        id: "survey-c",
        status: "failed",
        errorClass: "compose_unavailable",
        errorReason: 'Compose expansion failed: agent "surveyor" does not exist',
      }),
    ]
    expect(workflowCoverage({ config: { name: "w", nodes: [] }, nodes: rows }).map((entry) => entry.reason)).toEqual([
      `failed: compose_no_results: ${verdict.reason}`,
      "failed: compose_capacity: Compose expansion does not fit the graph: too many nodes",
      'failed: compose_unavailable: Compose expansion failed: agent "surveyor" does not exist',
    ])
  })

  it("does not list a join node that a recovery replaced: only the current rows count", () => {
    const old = makeNodeRow({ id: "survey", status: "failed", errorClass: DagCompose.NO_RESULTS, superseded: true })
    expect(workflowCoverage({ config: { name: "w", nodes: [] }, nodes: [old] })).toEqual([])
  })
})
