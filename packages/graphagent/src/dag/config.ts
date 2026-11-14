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
import { isReviewWorker } from "./review-lifecycle"

export type Dag = typeof ConfigV1.Dag.Type

/**
 * Resolve the configured default model for a node. Critical nodes
 * (required: true or review workers) take the advanced tier; everything else
 * takes standard. A single configured tier acts as the unified default.
 * Fallback runs on the parsed refs: an empty or malformed tier (e.g. a
 * commented placeholder left as "") counts as unconfigured.
 */
export function tierModel(info: Dag, node: { required: boolean; workerType: string }) {
  const critical = node.required || isReviewWorker(node.workerType)
  const advanced = parseModelRef(info.model?.advanced)
  const standard = parseModelRef(info.model?.standard)
  return critical ? (advanced ?? standard) : (standard ?? advanced)
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