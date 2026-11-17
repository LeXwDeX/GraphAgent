// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG model-tier selection.
 *
 * The settings themselves (`dag.model` and `dag.thinking_depth`) resolve per
 * execution directory in `config/dag-section.ts`; this module only maps a
 * node's role to the configured tier.
 */

export * as DagConfig from "./config"

import { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { WorkflowBlockKind } from "./blocks"
import type { NodeConfig } from "./dag"
import { isReviewWorker } from "./review-lifecycle"

export type Dag = typeof ConfigV1.Dag.Type

/** The two model tiers of `dag.model`. */
export type Tier = "advanced" | "standard"

/** The fields of a node definition that say what the node is for. A `NodeConfig` carries all of them. */
export type NodeRole = Pick<NodeConfig, "id" | "block" | "generated_helper" | "expand" | "join">

export interface TierNode {
  /**
   * The node's effective `required` flag. It is failure semantics and takes no part in a node that has a role of
   * its own; it decides the tier of a node that has none (a hand-written one), as it always has.
   */
  readonly required: boolean
  readonly workerType: string
  /** The node's definition. Without it the caller knows only the worker, and the node has no role. */
  readonly definition?: NodeRole
  /** The nodes of the node's graph. Only the join nodes in it are read, to tell the children of an expansion. */
  readonly graph?: readonly Pick<NodeConfig, "id" | "join">[]
}

/**
 * The tier a block kind runs on. Judging and accepting work (a plan, a
 * verification, a synthesis, a review lane or decision, a debug block's root-cause
 * diagnosis) and the composer take the advanced tier; writing and exploring take
 * the standard one (a debug block's evidence node is a generated helper). A `Record`
 * over every kind, so a new block kind must be placed here.
 */
const BLOCK_TIER: Record<WorkflowBlockKind, Tier> = {
  explore: "standard",
  plan: "advanced",
  prototype: "standard",
  debug: "advanced",
  coding: "standard",
  verify: "advanced",
  review: "advanced",
  synthesize: "advanced",
  compose: "advanced",
}

/**
 * Whether a join node of `graph` names `nodeID` as one of its items, that is, whether an expansion planned the
 * node. A child carries no marker of its own (its definition is a plain read-only worker), so the join node that
 * waits for it is the record that it is one.
 */
export function isComposeChild(graph: TierNode["graph"], nodeID: string): boolean {
  return graph?.some((node) => node.join?.items.some((item) => item.node === nodeID) === true) === true
}

/**
 * The tier of a node, by what it is for. `required` only decides failure semantics.
 *
 * 1. A worker that judges is advanced wherever it sits: `review` / `review-*` and the `auditor`.
 * 2. A composer's split node, expansion slot and join node (`generated_helper: "split"`, `expand`, `join`) are advanced.
 * 3. A generated helper (the writers' aggregator, a debug block's evidence node) only reconciles or collects: standard.
 * 4. A block-compiled node follows its block kind (`BLOCK_TIER`): `plan`, `verify`, `synthesize`, `review` and
 *    `compose` advanced, and `debug` (its diagnosis; its evidence node is a helper, above); `coding`, `prototype`
 *    (fan-out package writers keep their block) and `explore` standard.
 * 5. A child of an expansion is standard.
 * 6. Any other node has no role (a hand-written one) and keeps the older rule: `required` takes the advanced tier.
 */
export function tierOf(node: TierNode): Tier {
  if (isReviewWorker(node.workerType) || node.workerType === "auditor") return "advanced"
  return roleTier(node) ?? (node.required ? "advanced" : "standard")
}

function roleTier(node: TierNode): Tier | undefined {
  const definition = node.definition
  if (!definition) return undefined
  if (definition.generated_helper === "split" || definition.expand !== undefined || definition.join !== undefined)
    return "advanced"
  if (definition.generated_helper !== undefined) return "standard"
  if (definition.block !== undefined) return BLOCK_TIER[definition.block]
  if (isComposeChild(node.graph, definition.id)) return "standard"
  return undefined
}

/**
 * Resolve the configured default model for a node: the model of the tier its
 * role calls for (`tierOf`). A single configured tier acts as the unified
 * default. Fallback runs on the parsed refs: an empty or malformed tier (e.g. a
 * commented placeholder left as "") counts as unconfigured.
 */
export function tierModel(info: Dag, node: TierNode) {
  const advanced = parseModelRef(info.model?.advanced)
  const standard = parseModelRef(info.model?.standard)
  return tierOf(node) === "advanced" ? (advanced ?? standard) : (standard ?? advanced)
}

function parseModelRef(ref: string | undefined) {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash < 0) return undefined
  // Whitespace-only components (e.g. " / ") count as unconfigured.
  const providerID = ref.slice(0, slash).trim()
  const modelID = ref.slice(slash + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}
