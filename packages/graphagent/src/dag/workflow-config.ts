// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagWorkflowConfig from "./workflow-config"

import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"
import { acceptanceFromCriteria } from "./admission"
import { DagLocation } from "./location"
import { ReplanDefinition } from "./replan-definition"
import type { NodeConfig, NodeDefaults, WorkflowConfig } from "./dag"

export const DEFAULT_WORKFLOW_CONFIG = {
  maxConcurrency: 5,
  maxNodeReplanAttempts: 5,
  nodeTimeoutMs: 10 * 60 * 1000,
  nodeRequired: false,
  reportToParent: false,
  maxTimeoutExtensions: 20,
} as const

export interface NormalizedNodeConfig extends NodeConfig {
  required: boolean
}

export function normalizeModel(model: NodeConfig["model"]) {
  if (!model) return undefined
  const prefix = `${model.providerID}/`
  if (!model.modelID.startsWith(prefix)) return model
  const modelID = model.modelID.slice(prefix.length)
  if (!modelID) return model
  return {
    ...model,
    modelID,
  }
}

// F9: clamp the timeout floor — 0/negative timeout_ms would fire the deadline
// watcher immediately (escalate or force-cancel on the first tick).
const MIN_NODE_TIMEOUT_MS = 1_000

function clampTimeoutMs(timeoutMs: number | undefined, fallbackMs: number) {
  return Math.max(MIN_NODE_TIMEOUT_MS, timeoutMs ?? fallbackMs)
}

export function normalizeNodeDefaults(defaults: NodeDefaults | undefined): NodeDefaults {
  return {
    required: defaults?.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired,
    worker_config: {
      timeout_ms: clampTimeoutMs(defaults?.worker_config?.timeout_ms, DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs),
    },
    report_to_parent: defaults?.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent,
    ...(defaults?.model ? { model: normalizeModel(defaults.model) } : {}),
  }
}

export function normalizeNodeConfig(node: NodeConfig, defaults: NodeDefaults): NormalizedNodeConfig {
  const model = normalizeModel(node.model ?? defaults.model)
  const required = node.required ?? defaults.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired
  return {
    ...node,
    required,
    worker_config: {
      ...defaults.worker_config,
      ...node.worker_config,
      timeout_ms: clampTimeoutMs(
        node.worker_config?.timeout_ms ?? defaults.worker_config?.timeout_ms,
        DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs,
      ),
    },
    report_to_parent: node.report_to_parent ?? defaults.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent,
    // New required work is strict by default. Only historical persisted
    // definitions (which bypass normalization) keep the accepted-skip
    // behavior; blocks mark their intentional conditional branches explicitly.
    ...(required && node.skip_ok === undefined ? { skip_ok: false } : {}),
    ...(model ? { model } : {}),
  }
}

// F2: a fragment node that omits worker_config.timeout_ms must NOT be
// silently normalized to the DEFAULT (that would rewrite a long extension
// back to 10min — implicit budget shortening). The replace bucket (definition
// replaced, execution kept) preserves the existing node's timeout for the
// merged config and the deadline recompute.
export function withoutSkipOk<T extends NodeConfig>(candidate: T): Omit<T, "skip_ok"> {
  const { skip_ok: _skipOk, ...rest } = candidate
  return rest
}

export function normalizeFragmentNode(
  node: NodeConfig,
  existing: NodeConfig | undefined,
  defaults: NodeDefaults,
): NormalizedNodeConfig {
  const timeoutMs = node.worker_config?.timeout_ms ?? existing?.worker_config?.timeout_ms
  const withTimeout =
    timeoutMs == null ? node : { ...node, worker_config: { ...node.worker_config, timeout_ms: timeoutMs } }
  const normalized = normalizeNodeConfig(withTimeout, defaults)
  if (!existing || node.skip_ok !== undefined) return normalized
  // An unchanged persisted definition keeps its historical skip semantics.
  // Only genuinely new or authored changes receive the strict default.
  const current = normalizeNodeConfig(existing, defaults)
  const changed = ReplanDefinition.changedAdmittedNodeFields(
    withoutSkipOk(current),
    withoutSkipOk(normalized),
    { allowTimeoutUpdate: false },
  )
  if (changed.length > 0) return normalized
  return existing.skip_ok === undefined
    ? withoutSkipOk(normalized)
    : { ...normalized, skip_ok: existing.skip_ok }
}

/** Merged-graph nodes whose gate fields (condition, review wiring) are the
 * persisted ones — not authored or changed by this mutation. Replan/extend
 * exempt them from gate checks added after the definition was accepted;
 * a fragment that changes a condition is held to the full grammar. */
export function persistedGateNodeIds(nodes: readonly NodeConfig[], persisted: ReadonlyMap<string, NodeConfig>) {
  return new Set(
    nodes
      .filter((node) => {
        const stored = persisted.get(node.id)
        return (
          stored !== undefined &&
          stored.condition === node.condition &&
          JSON.stringify(stored.review) === JSON.stringify(node.review)
        )
      })
      .map((node) => node.id),
  )
}

export function normalizeWorkflowConfig(config: WorkflowConfig): WorkflowConfig & { nodes: NormalizedNodeConfig[] } {
  const defaults = normalizeNodeDefaults(config.node_defaults)
  // Direct Dag.create callers bypass authoring; derive the deep-mode
  // completeness items here too so the persisted graph always carries them.
  const acceptance =
    config.acceptance ??
    (config.mode === "deep" && config.admission
      ? acceptanceFromCriteria(config.admission.brief.acceptance_criteria)
      : undefined)
  return {
    ...config,
    ...(acceptance !== undefined ? { acceptance } : {}),
    mode: config.mode ?? "standard",
    max_concurrency: config.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency,
    max_node_replan_attempts: config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
    // Kept as declared: the effective ceiling is the lower of this value and
    // the user's global `dag.max_total_nodes` cap (see
    // DagValidation.effectiveMaxTotalNodes), so a tighter declaration is
    // honored and the user cap can change between mutations.
    ...(config.max_total_nodes !== undefined ? { max_total_nodes: config.max_total_nodes } : {}),
    max_timeout_extensions: config.max_timeout_extensions ?? DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
    node_defaults: defaults,
    nodes: config.nodes.map((node) => normalizeNodeConfig(node, defaults)),
  }
}

/**
 * #943: resolve config/node workspaces to canonical realpaths before they are
 * persisted. The validation boundary reports the same failures as diagnostics;
 * this is the fail-closed guard for direct Dag.create callers.
 */
export function pinNodeWorkspaces(
  nodes: readonly NodeConfig[],
  ownerDirectory: string,
  resolutions = new Map<string, string>(),
): NodeConfig[] {
  const pin = (workspace: string, path: string) => {
    const cached = resolutions.get(workspace)
    if (cached !== undefined) return cached
    const resolved = DagLocation.resolveWorkspace(workspace, ownerDirectory)
    if (resolved._tag === "invalid") throw new Error(`Invalid ${path}: ${resolved.reason}`)
    resolutions.set(workspace, resolved.directory)
    return resolved.directory
  }
  return nodes.map((node): NodeConfig => {
    if (node.workspace === undefined) return node
    const pinned = pin(node.workspace, `nodes[${node.id}].workspace`)
    return pinned === node.workspace ? node : { ...node, workspace: pinned }
  })
}

export function bindWorkspace(
  config: WorkflowConfig,
  ownerDirectory: string,
): { config: WorkflowConfig; workspace?: string } {
  const resolutions = new Map<string, string>()
  const pin = (workspace: string, path: string) => {
    const cached = resolutions.get(workspace)
    if (cached !== undefined) return cached
    const resolved = DagLocation.resolveWorkspace(workspace, ownerDirectory)
    if (resolved._tag === "invalid") throw new Error(`Invalid ${path}: ${resolved.reason}`)
    resolutions.set(workspace, resolved.directory)
    return resolved.directory
  }
  const workspace = config.workspace === undefined ? undefined : pin(config.workspace, "config.workspace")
  const nodes = pinNodeWorkspaces(config.nodes, ownerDirectory, resolutions)
  return {
    config: { ...config, ...(workspace !== undefined ? { workspace } : {}), nodes },
    ...(workspace !== undefined ? { workspace } : {}),
  }
}

/**
 * Merge the current workflow config with a replan fragment, applying the plan
 * buckets (cancel / restart / replace / add) to produce the single-source-of-truth
 * post-replan config. Pure function — no I/O.
 *
 * - cancelled nodes are removed
 * - replaced nodes take the fragment's definition
 * - restarted (running) nodes take the fragment's definition (restart = new def)
 * - added nodes (new ids from fragment) are appended
 * - terminal + running-unchanged nodes keep their current definition
 */
export function computeMergedConfig(
  current: WorkflowConfig,
  fragment: { nodes: NodeConfig[] },
  plan: { cancel: string[]; restart: string[]; replace: string[]; add: string[] },
): WorkflowConfig {
  const fragmentById = new Map(fragment.nodes.map((n) => [n.id, n]))
  const cancelSet = new Set(plan.cancel)
  const restartSet = new Set(plan.restart)
  const replaceSet = new Set(plan.replace)
  const surviving = current.nodes
    .filter((n) => !cancelSet.has(n.id))
    .map((n) => (restartSet.has(n.id) || replaceSet.has(n.id) ? (fragmentById.get(n.id) ?? n) : n))
  const added = plan.add.map((id) => fragmentById.get(id)).filter((n): n is NodeConfig => n !== undefined)
  return reconcileDeliveryNode({ ...current, nodes: [...surviving, ...added] }, current)
}

/** A prior final report stops being final when a mutation adds work after it.
 * Existing explicit selections of non-leaf nodes retain their accepted meaning.
 */
export function reconcileDeliveryNode(config: WorkflowConfig, previous: WorkflowConfig): WorkflowConfig {
  const selected = config.delivery_node
  const previouslyLeaf = !previous.nodes.some((node) => node.depends_on.includes(previous.delivery_node ?? ""))
  if (
    selected === undefined ||
    (config.nodes.some((node) => node.id === selected) &&
      (!previouslyLeaf || !config.nodes.some((node) => node.depends_on.includes(selected))))
  )
    return config
  const { delivery_node: _deliveryNode, ...rest } = config
  return rest
}

const parseJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function parseWorkflowConfig(raw: string): WorkflowConfig | undefined {
  const parsed = parseJsonOption(raw)
  if (Option.isNone(parsed)) return undefined
  const candidate: unknown = parsed.value
  if (!isRecord(candidate)) return undefined
  if (candidate.delivery_node !== undefined && typeof candidate.delivery_node !== "string") return undefined
  // Guard the invariants every caller relies on (config.nodes.map, node.id,
  // depends_on iteration) instead of trusting the persisted row blindly. Kept
  // structural rather than a full strict schema: rejecting a row persisted by
  // an older version that callers could still consume would break recovery of
  // in-flight workflows.
  if (!Array.isArray(candidate.nodes)) return undefined
  const nodesValid = candidate.nodes.every(
    (node) => isRecord(node) && typeof node.id === "string" && Array.isArray(node.depends_on),
  )
  if (!nodesValid) return undefined
  return parsed.value as WorkflowConfig
}
