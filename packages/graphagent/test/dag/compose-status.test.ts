// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR4b: what `inspect` status says about each compose block. The summary is a pure function of the persisted
// graph: the definitions the workflow holds (the marks the expansion wrote: `expand`, `join`, `compose_subtree`) and
// the rows that are current. The graphs below are made by the engine's own functions (`compileNodes`, `planExpansion`,
// `degrade`), the way the scheduler makes them, so the summary is read against what the engine really persists;
// test/dag/dag-compose-builtin-runtime.test.ts reads the same summary through the loop and the tool.
import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { DagComposeStatus } from "@/dag/compose-status"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { planRecovery } from "@/dag/recovery-plan"
import { catalog, composerOf } from "./compose-fixtures"
import { makeNodeRow } from "./fixtures"

const limits = DagCompose.DEFAULT_LIMITS

type BlockInput = ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]

/** The split node and the expansion slot of a compose block `id`, as the authoring check compiles it. */
function block(id: string, worker = "surveyor", extra: Partial<BlockInput> = {}): NodeConfig[] {
  return DagCompose.compileNodes(
    DagBlocks.compileWorkflowBlocks({
      objective: "Understand the persistence layer",
      blocks: [new DagBlocks.WorkflowBlock({ id, kind: "compose", worker_type: worker, instruction: "Look", ...extra })],
    }),
    catalog(),
    limits,
  ).nodes
}

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) => ({ rationale: "split by what has to be found out", items, not_planned: [] })

const find = (graph: readonly NodeConfig[], id: string) => {
  const found = graph.find((node) => node.id === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

/**
 * The graph after the scheduler expanded `slotID` with the plan `output` (or degraded it, with `output` left out): the
 * slot replaced in place by its join node, and what the expansion generated appended, as `Dag.extend` does. The
 * expansion reads where it sits from the graph, as it does at run time.
 */
function expandedGraph(
  graph: readonly NodeConfig[],
  slotID: string,
  output?: unknown,
  rows: readonly Row[] = rowsOf(graph),
): NodeConfig[] {
  const slot = find(graph, slotID)
  const members = graph.map((node) => ({ node, status: rows.find((row) => row.id === node.id)?.status ?? "pending" }))
  const result =
    output === undefined
      ? DagCompose.degrade(slot, composerOf(slot.worker_type), "the plan has no items")
      : DagCompose.planExpansion({
          slot,
          composer: composerOf(slot.worker_type),
          limits,
          source: { status: "completed", output },
          existingNodeIDs: new Set(graph.map((node) => node.id)),
          position: DagCompose.positionOf(slot, members, limits),
        })
  const written = new Map(result.nodes.map((node) => [node.id, node]))
  const kept = graph.map((node) => written.get(node.id) ?? node)
  return [...kept, ...result.nodes.filter((node) => !graph.some((existing) => existing.id === node.id))]
}

interface Row {
  readonly id: string
  readonly status: string
  readonly superseded: boolean
}

/** The current rows of a graph: every node there, none superseded. Nodes still waiting are pending, the others done. */
function rowsOf(graph: readonly NodeConfig[], pending: readonly string[] = []): Row[] {
  return graph.map((node) => ({
    id: node.id,
    status: pending.includes(node.id) || node.expand !== undefined ? "pending" : "completed",
    superseded: false,
  }))
}

const summarize = (graph: readonly NodeConfig[], rows: readonly Row[] = rowsOf(graph), used = limits) =>
  DagComposeStatus.summaries({ config: { nodes: [...graph] }, nodes: rows, limits: used })

describe("a workflow with no compose block", () => {
  it("has no summary", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Understand the persistence layer",
      blocks: [new DagBlocks.WorkflowBlock({ id: "look", kind: "explore" })],
    })
    expect(summarize(nodes)).toEqual([])
    expect(DagComposeStatus.summaries({ config: undefined, nodes: [], limits })).toEqual([])
  })
})

describe("a compose block whose plan has not been expanded yet", () => {
  it("is listed as not expanded, with nothing planned and the whole quota left", () => {
    const graph = block("survey")
    expect(summarize(graph)).toEqual([
      {
        id: "survey",
        composer: "surveyor",
        expanded: false,
        items: 0,
        required_items: 0,
        depth: 1,
        max_depth: 2,
        subtree_nodes: 0,
        subtree_quota: 40,
        subtree_remaining: 40,
      },
    ])
  })
})

describe("a compose block whose plan was expanded", () => {
  it("counts the items, the required ones and their share, and the nodes the plan spent", () => {
    const graph = expandedGraph(
      block("survey"),
      "survey",
      plan([item("a", "researcher"), item("b", "explore", { required: true }), item("c", "researcher")]),
    )
    expect(summarize(graph)).toEqual([
      {
        id: "survey",
        composer: "surveyor",
        expanded: true,
        items: 3,
        required_items: 1,
        required_share: 0.33,
        depth: 1,
        max_depth: 2,
        subtree_nodes: 3,
        subtree_quota: 40,
        subtree_remaining: 37,
      },
    ])
  })

  it("counts an item whose agent's work is required as required, whatever the plan says", () => {
    // `auditor` is an agent whose failure is the plan's failure: its item is required without the plan saying so.
    const graph = expandedGraph(
      block("survey"),
      "survey",
      plan([item("security", "auditor"), item("a", "researcher"), item("b", "researcher")]),
    )
    const [summary] = summarize(graph)
    expect(summary).toMatchObject({ items: 3, required_items: 1, required_share: 0.33 })
  })

  it("rounds the share to two decimals and reaches 1 when everything is required", () => {
    const some = expandedGraph(
      block("survey"),
      "survey",
      plan([item("a", "researcher", { required: true }), item("b", "researcher", { required: true }), item("c", "explore")]),
    )
    expect(summarize(some)[0]).toMatchObject({ required_items: 2, required_share: 0.67 })
    const all = expandedGraph(
      block("survey"),
      "survey",
      plan([item("a", "researcher", { required: true }), item("b", "explore", { required: true })]),
    )
    expect(summarize(all)[0]).toMatchObject({ required_items: 2, required_share: 1 })
  })

  it("has no `degraded` and no `unsplit` field when the plan was followed", () => {
    const graph = expandedGraph(block("survey"), "survey", plan([item("a", "researcher")]))
    const [summary] = summarize(graph)
    expect(summary).not.toHaveProperty("degraded")
    expect(summary).not.toHaveProperty("unsplit")
  })
})

describe("a compose block whose plan degraded", () => {
  it("says so with the reason, has planned no item, and counts the fallback worker among the nodes spent", () => {
    const graph = expandedGraph(block("survey", "surveyor", { required: true }), "survey")
    expect(summarize(graph)).toEqual([
      {
        id: "survey",
        composer: "surveyor",
        expanded: true,
        items: 0,
        required_items: 0,
        degraded: [{ node_id: "survey", reason: "the plan has no items" }],
        depth: 1,
        max_depth: 2,
        subtree_nodes: 1,
        subtree_quota: 40,
        subtree_remaining: 39,
      },
    ])
  })

  it("leaves the share out while nothing is planned", () => {
    const [summary] = summarize(expandedGraph(block("survey"), "survey"))
    expect(summary).not.toHaveProperty("required_share")
  })
})

describe("a recursive compose block", () => {
  // `api` is split again, `web` runs as one worker; the nested plan lists two items.
  const top = () =>
    expandedGraph(block("map", "mapper"), "map", plan([item("api", "explore", { split: true, required: true }), item("web", "explore")]))

  it("shows the nested slot as waiting: one level down, with its place in the quota set aside", () => {
    const graph = top()
    // The plan's two items and the nested split node are spent; the nested slot is waiting for its plan and holds a node.
    expect(summarize(graph, rowsOf(graph, ["map--api"]))).toEqual([
      {
        id: "map",
        composer: "mapper",
        expanded: true,
        items: 2,
        required_items: 1,
        required_share: 0.5,
        depth: 2,
        max_depth: 2,
        subtree_nodes: 3,
        subtree_quota: 40,
        subtree_remaining: 36,
      },
    ])
  })

  it("adds the items of the nested plan, and the depth the expansion reached", () => {
    const graph = expandedGraph(
      top(),
      "map--api",
      plan([item("routes", "explore", { required: true }), item("models", "explore")]),
    )
    // The nested slot is the join node of its own plan now, and belongs to the block `map`, not to a block of its own.
    expect(find(graph, "map--api").join?.items.map((entry) => entry.id)).toEqual(["routes", "models"])
    const summaries = summarize(graph)
    expect(summaries.map((summary) => summary.id)).toEqual(["map"])
    expect(summaries[0]).toEqual({
      id: "map",
      composer: "mapper",
      expanded: true,
      items: 4,
      required_items: 2,
      required_share: 0.5,
      depth: 2,
      max_depth: 2,
      subtree_nodes: 5,
      subtree_quota: 40,
      subtree_remaining: 35,
    })
  })

  it("counts an item that asked to be split at the deepest level, which runs as one worker", () => {
    const graph = expandedGraph(
      top(),
      "map--api",
      plan([item("routes", "explore"), item("models", "explore", { split: true })]),
    )
    const [summary] = summarize(graph)
    expect(summary).toMatchObject({ items: 4, unsplit: 1, depth: 2 })
    // The reason is persisted on the item, where coverage reads it too.
    expect(find(graph, "map--api").join?.items.find((entry) => entry.id === "models")?.unsplit).toContain(
      "dag.compose.max_depth 2",
    )
  })

  it("counts an item the top-level plan could not split for lack of depth", () => {
    // With one level allowed, the item that asks to be split runs as one worker from the start.
    const flat = { ...limits, maxDepth: 1 }
    const slot = find(block("map", "mapper"), "map")
    const result = DagCompose.planExpansion({
      slot,
      composer: composerOf("mapper"),
      limits: flat,
      source: { status: "completed", output: plan([item("api", "explore", { split: true }), item("web", "explore")]) },
      existingNodeIDs: new Set(),
    })
    const graph = [find(block("map", "mapper"), "map--split"), ...result.nodes]
    expect(summarize(graph, rowsOf(graph), flat)[0]).toMatchObject({ items: 2, unsplit: 1, depth: 1, max_depth: 1 })
  })

  it("lists a nested plan that degraded by the node that holds it, and still counts the plan that was followed", () => {
    const nested = expandedGraph(top(), "map--api")
    expect(summarize(nested)[0]).toMatchObject({
      items: 2,
      degraded: [{ node_id: "map--api", reason: "the plan has no items" }],
      depth: 2,
      // plan items 2 + the nested split node + the nested slot's fallback worker
      subtree_nodes: 4,
    })
  })

  it("lists every plan that degraded, in graph order, when several nested plans do", () => {
    const both = expandedGraph(
      block("map", "mapper"),
      "map",
      plan([item("api", "explore", { split: true }), item("web", "explore", { split: true })]),
    )
    const graph = expandedGraph(expandedGraph(both, "map--api"), "map--web")
    expect(summarize(graph)[0]?.degraded).toEqual([
      { node_id: "map--api", reason: "the plan has no items" },
      { node_id: "map--web", reason: "the plan has no items" },
    ])
    // Two nested plans, none of them listed an item: only the top-level plan's two items are planned work.
    expect(summarize(graph)[0]).toMatchObject({ items: 2, subtree_nodes: 6 })
  })

  it("does not count a node that is not part of the current graph", () => {
    const graph = expandedGraph(
      top(),
      "map--api",
      plan([item("routes", "explore"), item("models", "explore")]),
    )
    // A replan that cancelled `map--api--models` superseded its row: it holds no room and is no longer there.
    const rows = rowsOf(graph).map((row) => (row.id === "map--api--models" ? { ...row, superseded: true } : row))
    expect(summarize(graph, rows)[0]).toMatchObject({ subtree_nodes: 4, subtree_remaining: 36 })
    // A definition that has no row at all is outside the graph too.
    expect(summarize(graph, rows.filter((row) => row.id !== "map--api--models"))[0]).toMatchObject({ subtree_nodes: 4 })
  })
})

describe("a compose block after a recovery", () => {
  /** The workflow after `selected` were recovered: the recovered graph, and its current rows (the replacements pending). */
  function recovered(graph: readonly NodeConfig[], statuses: Record<string, string>, selected: string[]) {
    const config: WorkflowConfig = { name: "compose-recovery", nodes: [...graph] }
    const rows = graph.map((node) =>
      makeNodeRow({
        id: node.id,
        name: node.name,
        workerType: node.worker_type,
        status: statuses[node.id] ?? "skipped",
        required: node.required ?? false,
        dependsOn: node.depends_on,
        ...(statuses[node.id] === "failed" ? { errorReason: "boom" } : { errorReason: null }),
      }),
    )
    const plan = planRecovery(config, rows, selected, 2, 3)
    const replaced = new Set(plan.replacements.map((entry) => entry.current))
    const current: Row[] = plan.config.nodes.map((node) => ({
      id: node.id,
      status: replaced.has(node.id) ? "pending" : "completed",
      superseded: false,
    }))
    return { config: plan.config, rows: current }
  }

  it("keeps counting the subtree under the id the slot had when it was expanded, though the join node was renamed", () => {
    // `survey` expanded into two children and one of them failed. Recovering it recovers the join node with it, and the
    // replacement has a new id; the children keep the mark they were given, so the block is still found by it.
    const graph = expandedGraph(
      block("survey", "surveyor", { required: true }),
      "survey",
      plan([item("official", "researcher"), item("code", "explore", { required: true })]),
    )
    const { config, rows } = recovered(
      graph,
      { "survey--split": "completed", "survey--official": "completed", "survey--code": "failed" },
      ["survey--code"],
    )
    const renamed = config.nodes.find((node) => node.join !== undefined)
    expect(renamed?.id).toBe("survey__attempt_2_r2")
    expect(DagComposeStatus.summaries({ config, nodes: rows, limits })).toEqual([
      {
        id: "survey__attempt_2_r2",
        composer: "surveyor",
        expanded: true,
        items: 2,
        required_items: 1,
        required_share: 0.5,
        depth: 1,
        max_depth: 2,
        // The reused child and the recovered attempt of the other: the superseded one is no longer a node of the graph.
        subtree_nodes: 2,
        subtree_quota: 40,
        subtree_remaining: 38,
      },
    ])
  })

  it("counts the nested plans of a recovered recursive block too", () => {
    const top = expandedGraph(
      block("map", "mapper"),
      "map",
      plan([item("api", "explore", { split: true }), item("web", "explore")]),
    )
    const graph = expandedGraph(top, "map--api", plan([item("routes", "explore"), item("models", "explore")]))
    const { config, rows } = recovered(
      graph,
      {
        "map--split": "completed",
        "map--web": "completed",
        "map--api--split": "completed",
        "map--api--routes": "completed",
        "map--api--models": "failed",
      },
      ["map--api--models"],
    )
    // The join node of the nested plan is recovered with it, and so is the join node above.
    expect(config.nodes.filter((node) => node.join !== undefined).map((node) => node.id)).toEqual([
      "map__attempt_2_r2",
      "map--api__attempt_2_r2",
    ])
    expect(DagComposeStatus.summaries({ config, nodes: rows, limits })).toEqual([
      {
        id: "map__attempt_2_r2",
        composer: "mapper",
        expanded: true,
        items: 4,
        required_items: 0,
        required_share: 0,
        depth: 2,
        max_depth: 2,
        subtree_nodes: 5,
        subtree_quota: 40,
        subtree_remaining: 35,
      },
    ])
  })
})

describe("several compose blocks", () => {
  it("lists each in graph order, with the nested nodes of one block counted for that block alone", () => {
    const survey = block("survey")
    const map = block("map", "mapper")
    const graph = expandedGraph(
      expandedGraph([...survey, ...map], "map", plan([item("api", "explore", { split: true }), item("web", "explore")])),
      "survey",
      plan([item("a", "researcher")]),
    )
    const summaries = summarize(graph, rowsOf(graph, ["map--api"]))
    expect(summaries.map((summary) => summary.id)).toEqual(["survey", "map"])
    expect(summaries[0]).toMatchObject({ composer: "surveyor", items: 1, depth: 1, subtree_nodes: 1, subtree_remaining: 39 })
    expect(summaries[1]).toMatchObject({ composer: "mapper", items: 2, depth: 2, subtree_nodes: 3, subtree_remaining: 36 })
  })
})

describe("the limits the summary is read against", () => {
  it("are the ones it is given: the ceiling, the quota, and what is left of it", () => {
    const small = DagCompose.limits({ compose: { max_depth: 3, max_subtree_nodes: 10 } })
    const graph = expandedGraph(block("survey"), "survey", plan([item("a", "researcher"), item("b", "explore")]))
    expect(summarize(graph, rowsOf(graph), small)[0]).toMatchObject({
      max_depth: 3,
      subtree_quota: 10,
      subtree_nodes: 2,
      subtree_remaining: 8,
    })
  })

  it("never report less than nothing left, when the quota was lowered below what the subtree already holds", () => {
    const graph = expandedGraph(
      block("survey"),
      "survey",
      plan([item("a", "researcher"), item("b", "explore"), item("c", "explore")]),
    )
    const tight = { ...limits, maxSubtreeNodes: 2 }
    expect(summarize(graph, rowsOf(graph), tight)[0]).toMatchObject({ subtree_nodes: 3, subtree_remaining: 0 })
  })
})
