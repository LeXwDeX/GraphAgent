// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DagStore } from "@opencode-ai/core/dag/store"
import type { WorkflowConfig } from "../dag"
import { verdictField } from "./verdict"

export interface ReplanCheckpoint {
  readonly id: string
  readonly seq: number
}

/** A `{ verdict: "replan" }` object output (any case, JSON string or fenced). */
export function isReplanVerdict(output: unknown) {
  return verdictField(output) === "REPLAN"
}

export function latestReplanCheckpoint(
  config: WorkflowConfig | undefined,
  nodes: readonly DagStore.NodeRow[],
): ReplanCheckpoint | undefined {
  if (!config) return undefined
  const reporting = new Set(config.nodes.filter((node) => node.report_to_parent === true).map((node) => node.id))
  return nodes.reduce<ReplanCheckpoint | undefined>((latest, node) => {
    if (node.status !== "completed" || !reporting.has(node.id) || !isReplanVerdict(node.output)) return latest
    if (latest && latest.seq >= node.seq) return latest
    return { id: node.id, seq: node.seq }
  }, undefined)
}

export * as Checkpoint from "./checkpoint"
