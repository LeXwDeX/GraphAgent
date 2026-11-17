// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What `inspect` status says about each compose block of a workflow (#1158): whether its plan was expanded, how
 * many items the composers planned and how many of them are required, whether a plan degraded and why, how deep the
 * expansion went, and how much of the subtree's node quota it has spent.
 *
 * Everything is read from the persisted graph alone, the definitions the workflow holds and the rows that are
 * current, the way the scheduler reads it when it plans an expansion (`DagCompose.positionOf`). The summary
 * therefore describes the state the next plan would be made from, and a workflow with no compose block has none.
 * The reasons an item was not split, and every degraded plan, are also coverage entries (`DagCoverage`); this is the
 * block-level view of the same persisted marks.
 */

import type { DagStore } from "@graphagent/core/dag/store"
import { DagCompose } from "./compose"
import type { NodeConfig, WorkflowConfig } from "./dag"

/** A plan that was not expanded as planned: the node that holds it (the block's join node, or a nested one) and why. */
export interface Degraded {
  readonly node_id: string
  readonly reason: string
}

export interface Summary {
  /** The block's node id: its expansion slot, which the expansion turns into the join node. */
  readonly id: string
  readonly composer: string
  /** Whether the block's own plan has been expanded, or degraded to its fallback worker: the slot is now a join node. */
  readonly expanded: boolean
  /** Items of every plan the block has made, nested plans included. A degraded plan has none: its fallback worker is not an item. */
  readonly items: number
  /** Of those, the items whose work is required. */
  readonly required_items: number
  /** `required_items` over `items`, to two decimals; left out while nothing is planned. A share near 1 means the composer marked nearly everything required. */
  readonly required_share?: number
  /** Every plan of the block that degraded, each by the node that holds it, in graph order. Left out when none did. */
  readonly degraded?: readonly Degraded[]
  /** Items that asked to be split again and ran as one worker; coverage gives each reason. Left out when none did. */
  readonly unsplit?: number
  /** The deepest plan level the expansion has reached; a top-level plan is level 1. */
  readonly depth: number
  /** `dag.compose.max_depth`. */
  readonly max_depth: number
  /** Nodes the expansion has generated so far, nested ones and fallback workers included. */
  readonly subtree_nodes: number
  /** `dag.compose.max_subtree_nodes`. */
  readonly subtree_quota: number
  /** What is left of the quota for the next plan, after the room set aside for the nested slots still waiting (`DagCompose.positionOf`). */
  readonly subtree_remaining: number
}

export interface Input {
  readonly config: Pick<WorkflowConfig, "nodes"> | undefined
  /** The workflow's rows of the current graph revision. */
  readonly nodes: readonly Pick<DagStore.NodeRow, "id" | "status" | "superseded">[]
  /** The limits as the user's global config sets them (`DagCompose.limits`). */
  readonly limits: DagCompose.Limits
}

/**
 * A summary for each top-level compose block, in graph order. A block is the author's own expansion slot: the node
 * that carries `expand` or, once expanded, `join`, and no `compose_subtree` mark (the nested ones the expansion
 * generated carry it, and belong to the block their `root` names). A definition with no current row is not part of
 * the graph any more and is left out, as `DagComposeExpansion.positionIn` leaves it out.
 */
export function summaries(input: Input): Summary[] {
  const rows = new Map(input.nodes.map((row) => [row.id, row]))
  const graph = (input.config?.nodes ?? []).filter((node) => {
    const row = rows.get(node.id)
    return row !== undefined && !row.superseded
  })
  const members = graph.map((node) => ({ node, status: rows.get(node.id)?.status ?? "pending" }))
  return graph
    .filter((node) => node.compose_subtree === undefined && (node.expand !== undefined || node.join !== undefined))
    .map((slot) => summaryOf(slot, graph, members, input.limits))
}

/**
 * The key the block's subtree is marked with: the id the top-level slot had when it was expanded
 * (`compose_subtree.root`). A recovery renames the slot, and the join node it became, to a new attempt id and leaves
 * the marks of the nodes it joins alone, so the key is read from them. A slot that has not been expanded has no
 * subtree, and its own id is the key.
 */
function rootOf(slot: NodeConfig, graph: readonly NodeConfig[]): string {
  const joined = new Set(slot.join?.items.map((item) => item.node))
  return graph.find((node) => joined.has(node.id) && node.compose_subtree !== undefined)?.compose_subtree?.root ?? slot.id
}

function summaryOf(
  slot: NodeConfig,
  graph: readonly NodeConfig[],
  members: readonly DagCompose.Member[],
  limits: DagCompose.Limits,
): Summary {
  const root = rootOf(slot, graph)
  const subtree = graph.filter((node) => node.compose_subtree?.root === root)
  // Every plan of the block that has been expanded or degraded holds its items in its join node.
  const joined = [slot, ...subtree].flatMap((node) => (node.join === undefined ? [] : [{ id: node.id, join: node.join }]))
  const planned = joined.filter((plan) => plan.join.degraded === undefined).flatMap((plan) => plan.join.items)
  const required = planned.filter((item) => item.required).length
  const degraded = joined.flatMap((plan) =>
    plan.join.degraded === undefined ? [] : [{ node_id: plan.id, reason: plan.join.degraded }],
  )
  const unsplit = planned.filter((item) => item.unsplit !== undefined).length
  return {
    id: slot.id,
    composer: slot.worker_type,
    expanded: slot.join !== undefined,
    items: planned.length,
    required_items: required,
    ...(planned.length > 0 ? { required_share: Math.round((required / planned.length) * 100) / 100 } : {}),
    ...(degraded.length > 0 ? { degraded } : {}),
    ...(unsplit > 0 ? { unsplit } : {}),
    depth: subtree.reduce((deepest, node) => Math.max(deepest, node.compose_subtree?.depth ?? 1), 1),
    max_depth: limits.maxDepth,
    subtree_nodes: subtree.length,
    subtree_quota: limits.maxSubtreeNodes,
    // `positionOf` reads the subtree by its key, which is the slot's own id only until a recovery renames the slot.
    subtree_remaining: DagCompose.positionOf({ id: root, compose_subtree: undefined }, members, limits).remainingNodes,
  }
}

export * as DagComposeStatus from "./compose-status"
