// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG scheduling core — required-node validation.
 *
 * Pure: validates that a workflow's node config is internally consistent at
 * creation time (and before applying a replan fragment). Specifically checks
 * that required nodes do not form a cycle among themselves.
 *
 * Ported from dag-iron-laws session/required-nodes-validator.ts. Adapted to
 * the new schema field name (`depends_on` instead of `dependencies`) and to
 * opencode's functional style (no single-method class wrapper, no unused
 * Effect import).
 */

import { DependencyGraph } from "./graph"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface NodeConfigLike {
  id: string
  depends_on: string[]
  required: boolean
}

export interface WorkflowConfigLike {
  nodes: NodeConfigLike[]
}

/**
 * Validate a workflow config's required-node declarations.
 *
 * @example
 * ```ts
 * const result = validateRequiredNodes({ nodes: [...] })
 * if (!result.valid) throw new Error(result.errors.join("; "))
 * ```
 */
export function validateRequiredNodes(config: WorkflowConfigLike): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const requiredNodeIds = config.nodes.filter((n) => n.required).map((n) => n.id)

  // Required nodes must not form a cycle among themselves. Reuse DependencyGraph
  // rather than the old validator's bespoke DFS — same semantics, less code.
  const requiredGraph = new DependencyGraph()
  for (const id of requiredNodeIds) requiredGraph.addNode(id)
  for (const node of config.nodes) {
    if (!node.required) continue
    for (const depId of node.depends_on) {
      if (requiredNodeIds.includes(depId)) {
        // Safe to addEdge: both endpoints are required and present.
        requiredGraph.addEdge(node.id, depId)
      }
    }
  }
  if (requiredGraph.hasCycle()) {
    errors.push("Required nodes form a cycle")
  }

  // Advisory: all-required graphs leave no room for optional degradation.
  if (requiredNodeIds.length === config.nodes.length && config.nodes.length > 0) {
    warnings.push("All nodes are marked as required. Consider if some nodes can be optional.")
  }

  return { valid: errors.length === 0, errors, warnings }
}
