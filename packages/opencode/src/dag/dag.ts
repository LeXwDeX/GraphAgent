// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as Dag from "./dag"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context, Schema, Option, Clock } from "effect"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { BatchEvent } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { isRecord } from "@/util/record"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import {
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
  isWorkflowTerminalStatus,
  isTerminalWorkflowStatusValue,
  isNodeTerminalStatus,
  isTransitionRejection,
  InvalidTransitionError,
  StaleNodeAttemptError,
  TerminalViolationError,
  WorkflowStatus,
  NodeStatus,
} from "@opencode-ai/core/dag/core/types"
import { AdmissionRecord, ExecutionMode, transitionAdmission, validateAdmission } from "./admission"
import { unresolvedReviewOutcomes, targetSensitiveNode } from "./review-lifecycle"
import { ReplanDefinition } from "./replan-definition"
import { DagValidation, StructuralValidationError } from "./validation"
import { DagLocation } from "./location"
import { DagIsolation } from "./isolation"
import { SessionLocation } from "@/session/location"
import { SessionID } from "@/session/schema"
import { planRecovery, type RecoveryPlan } from "./recovery-plan"
import { verifyOutputFileRef } from "./runtime/output-ref"
import { failingGateVerdict, verdictField } from "./runtime/verdict"

export { StructuralValidationError } from "./validation"

// Re-export domain types
export const ID = DagEvent.DagID
export type ID = typeof ID.Type
export const NodeID = DagEvent.NodeID
export type NodeID = typeof NodeID.Type

export interface WorkflowOwner {
  readonly projectID: string
  readonly directory: string
}

export interface NodeExecutionAttempt {
  readonly replanAttempts: number
  /** Admission-only definition snapshot; later node events advance seq. */
  readonly nodeSeq?: number
  /** Settlement identity after NodeStarted assigns the child session. */
  readonly childSessionID?: string
  /** Admission-only config generation; running settlements intentionally omit it. */
  readonly graphRev?: number
  readonly inputSnapshotID?: string
  /** Revision-dependent failure; newer accepted input wins instead of being closed. */
  readonly expectedAcceptedRevision?: number
}

export class StaleMessageInputError extends Schema.TaggedError<StaleMessageInputError>()(
  "StaleMessageInputError",
  {
    dagID: Schema.String,
    nodeID: Schema.String,
    reason: Schema.String,
  },
) {}
export const isStaleMessageInput = (error: unknown): error is StaleMessageInputError =>
  error instanceof StaleMessageInputError

/** Outcome of a dedicated `extend_timeout` control operation (P0-A). */
export type ExtendTimeoutVerdict =
  | { readonly status: "extended"; readonly deadlineMs: number }
  /** Node missing, or no longer running (pending/queued/terminal). */
  | { readonly status: "not_running" }
  /** No formal escalation is awaiting adjudication, regardless of whether
   * the deadline has already elapsed. */
  | { readonly status: "no_escalation" }
  /** Q2 delivery gate: a pending escalation has not been delivered to the parent
   * yet; adjudication must follow delivery. Node stays running. */
  | { readonly status: "escalation_undelivered" }
  /** The cumulative escalation count has reached this workflow's cap. */
  | { readonly status: "cap_exhausted" }

/** #945: durable outcome of a mid-run target change. */
export interface RetargetResult {
  readonly nodes: string[]
  readonly fromDirectory?: string
  readonly toDirectory?: string
  readonly fromFingerprint?: DagEvent.TargetFingerprint
  readonly toFingerprint: DagEvent.TargetFingerprint
  readonly graphRev: number
}

export const DEFAULT_WORKFLOW_CONFIG = {
  maxConcurrency: 5,
  maxNodeReplanAttempts: 5,
  maxTotalNodes: 100,
  nodeTimeoutMs: 10 * 60 * 1000,
  nodeRequired: false,
  reportToParent: false,
  maxTimeoutExtensions: 20,
} as const

// Cap on workflow-lock acquisition + critical section (ADR-0004). The critical
// section is a synchronous DB write, so exceeding this means the workflow is
// already broken — interrupt loudly via Effect's builtin TimeoutException. The
// critical section must never await async work; that is the only way this bound
// can fire.
export const WORKFLOW_LOCK_TIMEOUT = "30 seconds" as const

/** A node as declared in the workflow's YAML config. */
export interface NodeConfig {
  id: string
  name: string
  worker_type: string
  depends_on: string[]
  required?: boolean
  /** A required node may be skipped without failing the workflow. New required
   * nodes default to false; undefined on historical rows keeps their
   * accepted-skip semantics. */
  skip_ok?: boolean
  prompt_template: { id?: string; inline?: string; input?: Record<string, unknown> }
  worker_config?: { timeout_ms?: number }
  input_mapping?: Record<string, string>
  report_to_parent?: boolean
  condition?: string
  model?: { modelID: string; providerID: string }
  restart?: boolean
  cancel?: boolean
  output_schema?: Record<string, unknown>
  /** Controller-owned lineage; each recovery gets a distinct durable node ID. */
  recovery?: { logical_node_id: string; attempt: number; previous_node_id: string }
  review?: {
    phase: "design" | "diff"
    implementation_node_id?: string
    verification_node_id?: string
  }
  /** Direct dependency whose `packages` output fans this writer out at
   * admission; cleared by the expansion that replaces this node. */
  fan_out?: string
  /** #943: absolute path to a linked worktree where this node runs. */
  workspace?: string
  /** #946: run this writer-capable node in a fresh worktree of the workflow
   * target. Mutually exclusive with `workspace`. */
  isolation?: "worktree"
  /** #944: block compilation marks nodes that judge the current working tree
   * (review lanes, verify, synthesize). Their attempts record a target
   * fingerprint and a stale result cannot settle completion. */
  target_sensitive?: boolean
}

export interface NodeDefaults {
  required?: boolean
  worker_config?: { timeout_ms?: number }
  report_to_parent?: boolean
  model?: { modelID: string; providerID: string }
}

interface NormalizedNodeConfig extends NodeConfig {
  required: boolean
}

export type ResultProtocol = "final_response" | "submit_result"

/** Missing on historical persisted workflows means the original tool protocol. */
export function resultProtocol(config: Pick<WorkflowConfig, "result_protocol"> | undefined): ResultProtocol {
  return config?.result_protocol ?? "submit_result"
}

export interface WorkflowConfig {
  name: string
  result_protocol?: ResultProtocol
  delivery_node?: string
  mode?: ExecutionMode
  admission?: AdmissionRecord
  max_concurrency?: number
  max_node_replan_attempts?: number
  max_total_nodes?: number
  max_timeout_extensions?: number
  /** #943: absolute path to a linked worktree where child sessions run. */
  workspace?: string
  node_defaults?: NodeDefaults
  nodes: NodeConfig[]
}

export class ReviewGateError extends Error {
  readonly dagID: string
  readonly reviewIDs: string[]

  constructor(dagID: string, reviewIDs: string[]) {
    super(`Cannot complete workflow ${dagID}: unresolved review outcome(s): ${reviewIDs.join(", ")}`)
    this.name = "ReviewGateError"
    this.dagID = dagID
    this.reviewIDs = reviewIDs
  }
}

/** Required work that ended without a usable result: a deliberate bad verdict
 * or an unaccepted skip. Kept separate from the review gate so explicit
 * completion reports both causes precisely. */
export class CompletionGateError extends Error {
  readonly dagID: string
  readonly gaps: string[]

  constructor(dagID: string, gaps: string[]) {
    super(`Cannot complete workflow ${dagID}: required node(s) did not complete: ${gaps.join(", ")}`)
    this.name = "CompletionGateError"
    this.dagID = dagID
    this.gaps = gaps
  }
}

interface CompletionNode {
  readonly id: string
  readonly status: string
  readonly required: boolean
  readonly output: unknown
  readonly errorReason: string | null
  /** #944: a completed node whose target changed under it cannot gate completion. */
  readonly staleTarget?: boolean | null
}

function declaresVerdictContract(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false
  const properties = schema.properties
  const required = schema.required
  return (
    (typeof properties === "object" && properties !== null && "verdict" in properties)
    || (Array.isArray(required) && required.includes("verdict"))
  )
}

/** A schema whose accepted values include a string must keep string output as data. */
function schemaAllowsString(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false
  const type = schema.type
  if (type === "string") return true
  if (Array.isArray(type) && type.includes("string")) return true
  for (const key of ["anyOf", "oneOf"]) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.some((variant) => isRecord(variant) && schemaAllowsString(variant)))
      return true
  }
  return false
}

/**
 * Required current-revision nodes that did not produce an accepted result.
 * Natural completion (`mode: "natural"`) keeps the historical accepted-skip
 * behavior for definitions without `skip_ok`. Explicit completion uses
 * `mode: "strict"`: every required node must be completed with a passing
 * verdict or explicitly opted into the skip, so forced completion cannot
 * bypass the invariant. A completed non-review gate whose verdict says
 * FAIL/BLOCKING/BLOCKED/INCOMPLETE always counts as unfinished. Only a legacy
 * diff review is exempt: its REJECT outcome stays reopenable, while design
 * review verdicts are real gate failures.
 */
export function requiredCompletionGaps(
  config: WorkflowConfig | undefined,
  nodes: readonly CompletionNode[],
  mode: "natural" | "strict" = "natural",
): string[] {
  const definitions = new Map(config?.nodes.map((node) => [node.id, node]))
  return nodes.flatMap((node) => {
    const definition = definitions.get(node.id)
    // #944: a target-sensitive node judges the working tree. A stale result
    // never counts as an accepted result — including a non-required review
    // lane, whose verdict can still open the review decision.
    if (definition?.target_sensitive === true && node.status === "completed" && node.staleTarget === true)
      return [`${node.id} (stale target)`]
    if (!node.required) return []
    if (node.status !== "completed") {
      if (node.status !== "skipped" && node.status !== "aborted")
        return [`${node.id} (${node.status || "unfinished"})`]
      if (definition?.skip_ok === true) return []
      if (definition?.skip_ok === undefined && mode === "natural") return []
      return [`${node.id} (${node.status}: ${node.errorReason ?? "unfinished"})`]
    }
    // #944: a result judged against a tree that changed mid-run is not an
    // accepted result, even when its verdict says PASS/ACCEPT.
    if (node.staleTarget === true) return [`${node.id} (stale target)`]
    if (definition?.review?.phase === "diff") {
      const outcome = verdictField(node.output)
      // Only the legacy diff-review outcomes that gate reopen behavior are
      // exempt. A malformed FAIL/BLOCKED diff review is still a failed gate.
      if (outcome === "ACCEPT" || outcome === "REJECT") return []
    }
    const verdict = failingGateVerdict(node.output, {
      allowScalar: declaresVerdictContract(definition?.output_schema),
      parseString: !schemaAllowsString(definition?.output_schema),
    })
    return verdict ? [`${node.id} (verdict ${verdict})`] : []
  })
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

function normalizeNodeDefaults(defaults: NodeDefaults | undefined): NodeDefaults {
  return {
    required: defaults?.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired,
    worker_config: {
      timeout_ms: clampTimeoutMs(defaults?.worker_config?.timeout_ms, DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs),
    },
    report_to_parent: defaults?.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent,
    ...(defaults?.model ? { model: normalizeModel(defaults.model) } : {}),
  }
}

function normalizeNodeConfig(node: NodeConfig, defaults: NodeDefaults): NormalizedNodeConfig {
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
    // definitions (which bypass normalization) keep the accepted-skip legacy
    // path; blocks mark their intentional conditional branches explicitly.
    ...(required && node.skip_ok === undefined ? { skip_ok: false } : {}),
    ...(model ? { model } : {}),
  }
}

// F2: a fragment node that omits worker_config.timeout_ms must NOT be
// silently normalized to the DEFAULT (that would rewrite a long extension
// back to 10min — implicit budget shortening). The replace bucket (definition
// replaced, execution kept) preserves the existing node's timeout for the
// merged config and the deadline recompute.
function withoutSkipOk<T extends NodeConfig>(candidate: T): Omit<T, "skip_ok"> {
  const { skip_ok: _skipOk, ...rest } = candidate
  return rest
}

function normalizeFragmentNode(
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
function persistedGateNodeIds(nodes: readonly NodeConfig[], persisted: ReadonlyMap<string, NodeConfig>) {
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

function normalizeWorkflowConfig(config: WorkflowConfig): WorkflowConfig & { nodes: NormalizedNodeConfig[] } {
  const defaults = normalizeNodeDefaults(config.node_defaults)
  return {
    ...config,
    result_protocol: config.result_protocol ?? "final_response",
    mode: config.mode ?? "standard",
    max_concurrency: config.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency,
    max_node_replan_attempts: config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
    // The default doubles as a floor (see DagValidation.effectiveMaxTotalNodes).
    max_total_nodes: Math.max(config.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes, DEFAULT_WORKFLOW_CONFIG.maxTotalNodes),
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
function pinNodeWorkspaces(
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

function bindWorkspace(
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
function reconcileDeliveryNode(config: WorkflowConfig, previous: WorkflowConfig): WorkflowConfig {
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
  if (
    candidate.result_protocol !== undefined &&
    candidate.result_protocol !== "final_response" &&
    candidate.result_protocol !== "submit_result"
  )
    return undefined
  if (candidate.delivery_node !== undefined && typeof candidate.delivery_node !== "string") return undefined
  // Guard the invariants every caller relies on (config.nodes.map, node.id,
  // depends_on iteration) instead of trusting the persisted row blindly. Kept
  // structural rather than a full strict schema: rejecting a legacy row that
  // callers could still consume would break recovery of in-flight workflows.
  if (!Array.isArray(candidate.nodes)) return undefined
  const nodesValid = candidate.nodes.every(
    (node) => isRecord(node) && typeof node.id === "string" && Array.isArray(node.depends_on),
  )
  if (!nodesValid) return undefined
  return parsed.value as WorkflowConfig
}

// Structural validation (duplicate ids, dangling/condition references,
// template bindings, ceilings, review lifecycle, required-node and full-graph
// cycles) lives in the shared validation authority so create, replan, and the
// workflow validate action all enforce the same invariants with the same
// codes and field paths.

export interface Interface {
  readonly create: (input: {
    projectID: string
    sessionID: string
    title: string
    config: WorkflowConfig
  }) => Effect.Effect<ID, Error>
  readonly store: DagStore.Interface
  readonly pause: (dagID: string) => Effect.Effect<void, Error>
  readonly pauseForCheckpoint: (
    dagID: string,
    checkpointSeq: number,
  ) => Effect.Effect<"paused" | "acknowledged" | "inactive", Error>
  readonly resume: (dagID: string) => Effect.Effect<void, Error>
  readonly step: (
    dagID: string,
  ) => Effect.Effect<{ status: "stepping"; nodeID?: string } | { status: "no_ready_nodes" }, Error>
  readonly cancel: (dagID: string) => Effect.Effect<void, Error>
  readonly complete: (
    dagID: string,
    options?: { readonly skipReviewGate?: boolean; readonly allowAcceptedSkips?: boolean },
  ) => Effect.Effect<void, Error>
  readonly fail: (dagID: string, reason: string) => Effect.Effect<void, Error>
  /**
   * Fail a workflow whose execution location is unusable outside the normal
   * control flow (its directory disappeared or was never stamped). Unlike
   * `fail`, this also legalizes the pending→running and paused→running legs
   * first, so a row abandoned in any non-terminal status can reach `failed`
   * and open one terminal wake episode. Revalidates the durable execution
   * location inside the workflow lock: a concurrent move to a valid directory
   * wins and returns `ignored`. Idempotent: an already-terminal row also
   * returns `ignored`.
   */
  readonly failUnrecoverable: (dagID: string, reason: string) => Effect.Effect<"failed" | "ignored", Error>
  readonly settleCompletion: (
    dagID: string,
    options?: {
      readonly expectedGraphRev?: number
      readonly allowAcceptedSkips?: boolean
      readonly skipReviewGate?: boolean
      readonly owner?: WorkflowOwner
    },
  ) => Effect.Effect<{ readonly status: "completed" | "failed" | "stale" | "ignored" }, Error>
  readonly replan: (
    dagID: string,
    fragment: { nodes: NodeConfig[] },
  ) => Effect.Effect<{ cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] }, Error>
  readonly extend: (
    dagID: string,
    nodes: NodeConfig[],
    /** Runtime-initiated extends (fan-out) apply only while this pending node
     * still matches the scheduling attempt that planned them. */
    fence?: { nodeID: string; attempt: NodeExecutionAttempt },
  ) => Effect.Effect<{ cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] }, Error>
  readonly recover: (
    dagID: string,
    input: {
      nodeIDs: readonly string[]
      expectedGraphRev: number
      resumeCancelled?: boolean
    },
  ) => Effect.Effect<Omit<RecoveryPlan, "config"> & { graphRev: number }, Error>
  /** #945: change the workflow target and restart running target-sensitive
   * attempts so old evidence cannot reach the gate. */
  readonly retarget: (
    dagID: string,
    input: {
      workspace?: string
      fingerprint?: string
      nodeIDs?: readonly string[]
      reason?: string
    },
  ) => Effect.Effect<RetargetResult, Error>
  readonly nodeQueued: (
    dagID: string,
    nodeID: string,
    deadlineMs?: number,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<void, Error>
  readonly nodeStarted: (
    dagID: string,
    nodeID: string,
    childSessionID: string,
    deadlineMs?: number,
    wakeEligible?: boolean,
    attempt?: NodeExecutionAttempt,
    /** #949: execution directory for this attempt, snapshotted for status. */
    directory?: string,
    /** #949: repo HEAD when the attempt started. */
    baseHead?: string,
    /** #944: target fingerprint captured before a target-sensitive node starts. */
    targetFingerprint?: DagEvent.TargetFingerprint,
    /** #946: the isolated worktree this attempt runs in. */
    worktree?: DagEvent.NodeWorktree,
  ) => Effect.Effect<void, Error>
  readonly nodeCompleted: (
    dagID: string,
    nodeID: string,
    output: unknown,
    attempt?: NodeExecutionAttempt,
    capturedOutput?: unknown,
    /** #946: commit/patch evidence for an isolated node. */
    worktree?: DagEvent.NodeWorktree,
    /** #946: paths changed by a non-isolated node. */
    touchedPaths?: readonly string[],
  ) => Effect.Effect<void, Error>
  readonly nodeFailed: (
    dagID: string,
    nodeID: string,
    reason: string,
    trigger: string,
    attempt?: NodeExecutionAttempt,
    /** More specific triage class than trigger (e.g. schema_invalid). */
    errorClass?: string,
    /** #946: a failed isolated node keeps its worktree for inspection. */
    worktree?: DagEvent.NodeWorktree,
  ) => Effect.Effect<void, Error>
  readonly nodeSkipped: (
    dagID: string,
    nodeID: string,
    reason: string,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<void, Error>
  readonly nodeCancelled: (dagID: string, nodeID: string) => Effect.Effect<void, Error>
  readonly nodeRestarted: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void, Error>
  readonly nodeTimeoutEscalated: (
    dagID: string,
    nodeID: string,
    childSessionID: string,
    timeoutExtensions: number,
    staleDeadlineMs?: number | null,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<void, Error>
  readonly nodeExtendTimeout: (
    dagID: string,
    nodeID: string,
    newDeadlineMs: number,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<number, Error>
  readonly extendTimeout: (
    dagID: string,
    nodeID: string,
    timeoutMs: number,
  ) => Effect.Effect<ExtendTimeoutVerdict, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Dag") {}

// The per-workflow KeyedMutex is single-permit and NOT reentrant: a guarded
// command invoked without the lock races its status guards, and one invoked
// while the lock is already held deadlocks silently (the permit never frees).
// The witness turns that convention into a type — only withWorkflowLock mints
// a WorkflowLock, so every guarded command below carries compile-time proof
// that it runs inside the lock's critical section. Internal composition
// (extend → replan → nodeFailed) forwards the caller's witness instead of
// re-acquiring the lock.
declare const WorkflowLockHeld: unique symbol
type WorkflowLock = { readonly [WorkflowLockHeld]: true }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const mailboxService = yield* Effect.serviceOption(DagMessages.Service)
    const withMailbox = <A, E, R>(
      dagID: string,
      reason: string | undefined | ((result: A) => string | undefined),
      commit: Effect.Effect<A, E, R>,
    ) => (Option.isSome(mailboxService) ? mailboxService.value.fenceWorkflow(dagID, reason, commit) : commit)
    const workflowLocks = KeyedMutex.makeUnsafe<string>()
    const lockWitness = {} as WorkflowLock
    const withWorkflowLock =
      (dagID: string) =>
      <A, E, R>(body: (lock: WorkflowLock) => Effect.Effect<A, E, R>) =>
        workflowLocks
          .withLock(dagID)(Effect.suspend(() => body(lockWitness)))
          .pipe(Effect.timeout(WORKFLOW_LOCK_TIMEOUT))

    const guardWorkflow = Effect.fn("Dag.guardWorkflow")(function* (dagID: string, target: WorkflowStatus) {
      const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const current = wf.status as WorkflowStatus
      if (!getValidNextWorkflowStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(dagID, current, target))
      }
    })

    const guardWorkflowNotTerminal = Effect.fn("Dag.guardWorkflowNotTerminal")(function* (
      dagID: string,
      attemptedStatus: string,
    ) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (isWorkflowTerminalStatus(workflow.status as WorkflowStatus)) {
        return yield* Effect.fail(new TerminalViolationError(dagID, workflow.status, attemptedStatus))
      }
      return workflow
    })

    const guardNodeAttempt = (node: DagStore.NodeRow, graphRev: number, attempt?: NodeExecutionAttempt) => {
      if (!attempt) return Effect.void
      const stale =
        node.replanAttempts !== attempt.replanAttempts ||
        (attempt.nodeSeq !== undefined && node.seq !== attempt.nodeSeq) ||
        (attempt.childSessionID !== undefined && node.childSessionId !== attempt.childSessionID) ||
        (attempt.graphRev !== undefined && graphRev !== attempt.graphRev)
      return stale
        ? Effect.fail(
            new StaleNodeAttemptError(node.id, attempt, {
              replanAttempts: node.replanAttempts,
              nodeSeq: node.seq,
              childSessionID: node.childSessionId,
              graphRev,
            }),
          )
        : Effect.void
    }

    const guardNode = Effect.fn("Dag.guardNode")(function* (
      dagID: string,
      nodeID: string,
      target: NodeStatus,
      attempt?: NodeExecutionAttempt,
    ) {
      const workflow = yield* guardWorkflowNotTerminal(dagID, target)
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      yield* guardNodeAttempt(node, workflow.graphRev, attempt)
      const current = node.status as NodeStatus
      if (isNodeTerminalStatus(current)) {
        return yield* Effect.fail(new TerminalViolationError(nodeID, current, target))
      }
      if (!getValidNextNodeStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(nodeID, current, target))
      }
      return node
    })

    const create = Effect.fn("Dag.create")(function* (input: {
      projectID: string
      sessionID: string
      title: string
      config: WorkflowConfig
    }) {
      const config = normalizeWorkflowConfig(input.config)
      // Structural validation first, via the shared authority (the same one
      // the workflow validate action runs): duplicate ids would silently
      // merge via the projector's upsert, and a dangling depends_on reference
      // would silently drop the edge in buildGraph — turning a typo'd
      // dependency into an immediately-runnable root node. Rejection happens
      // before any event publication.
      const structural = DagValidation.structuralDiagnostics({
        nodes: config.nodes,
        delivery_node: config.delivery_node,
        mode: config.mode,
        max_total_nodes: config.max_total_nodes,
      })
      const structuralErrors = DagValidation.sortLegacyStructural(structural.filter((d) => d.severity === "error"))
      for (const warning of structural.filter((d) => d.severity === "warning")) {
        yield* Effect.logWarning("DAG structural validation diagnostic", { diagnostic: warning })
      }
      if (structuralErrors.length > 0) {
        return yield* Effect.fail(new StructuralValidationError({ diagnostics: structuralErrors }))
      }
      if (config.mode === "deep") {
        if (!config.admission) {
          return yield* Effect.fail(
            new Error(
              "Deep workflow admission blocked: admission is required; complete parent-session QA or provide an informed waiver",
            ),
          )
        }
        const admission = validateAdmission(config.admission)
        const stateAccepted = config.admission.state === "READY" || config.admission.state === "WAIVED"
        if (!admission.valid || !stateAccepted) {
          const errors = [
            ...(!stateAccepted
              ? [`state ${config.admission.state} cannot start a deep workflow; expected READY or WAIVED`]
              : []),
            ...(!admission.valid ? admission.errors : []),
            ...config.admission.brief.blocking_questions,
          ]
          return yield* Effect.fail(
            new Error(
              `Deep workflow admission blocked: ${errors.join("; ")}. Answer blockers, reduce scope, use standard mode, or provide an informed waiver`,
            ),
          )
        }
      }
      // #943: ownerDirectory keeps the DAG-LOC-01 ownership key; the workspace
      // is a separate execution binding resolved once and persisted on the
      // workflow row. The authoring boundary already checked it; this repeats
      // the resolution for direct Dag.create callers and stores realpaths.
      const ownerDirectory = yield* Effect.flatMap(
        SessionLocation.sessionDirectory(SessionID.make(input.sessionID)),
        (durable) =>
          durable._tag === "Some"
            ? Effect.succeed(DagLocation.canonicalDirectory(durable.value))
            : DagLocation.stampDirectory(),
      )
      const bound = yield* Effect.try({
        try: () => bindWorkspace(config, ownerDirectory),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      // #944: the target identity is captured from the bound execution
      // directory (the owner directory when no workspace is bound). Non-git
      // directories get the stable `none` marker.
      const targetFingerprint = DagLocation.fingerprintTarget(bound.workspace ?? ownerDirectory)
      const durableConfig =
        bound.config.mode === "deep" && bound.config.admission
          ? {
              ...bound.config,
              admission: {
                ...bound.config.admission,
                state: transitionAdmission(bound.config.admission.state, "CONSUMED"),
              },
            }
          : bound.config

      const dagID = DagEvent.DagID.create()
      const ts = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowCreated, {
        dagID,
        projectID: input.projectID as never,
        sessionID: input.sessionID as never,
        title: input.title,
        config: JSON.stringify(durableConfig),
        status: "pending",
        timestamp: ts,
        // DAG-LOC-01 stamp (P2-F): the execution-location key is the TARGET
        // SESSION's durable directory — the single source of truth. Stamping
        // the ambient request instance's directory would let a request on
        // directory A create a workflow for B's session stamped A, orphaning
        // it from B's loops. Fall back to the ambient instance only when the
        // session has no durable row (the workflow insert would fail its
        // session FK anyway).
        directory: ownerDirectory,
        ...(bound.workspace !== undefined ? { executionDirectory: bound.workspace } : {}),
        targetFingerprint,
      })
      for (const node of durableConfig.nodes) {
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID,
          nodeID: node.id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required ?? false,
          model: node.model as never,
          timestamp: ts,
        })
      }
      const startTs = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: startTs })
      return dagID
    })

    const pause = Effect.fn("Dag.pause")(function* (lock: WorkflowLock, dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.PAUSED)
      yield* events.publish(DagEvent.WorkflowPaused, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    const pauseForCheckpoint = Effect.fn("Dag.pauseForCheckpoint")(function* (
      lock: WorkflowLock,
      dagID: string,
      checkpointSeq: number,
    ) {
      const acknowledgedSeq = yield* store.getLatestCheckpointControlSeq(dagID)
      if (acknowledgedSeq !== undefined && acknowledgedSeq >= checkpointSeq) return "acknowledged" as const

      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (
        !workflow ||
        workflow.status === "completed" ||
        workflow.status === "failed" ||
        workflow.status === "cancelled" ||
        workflow.status === "archived"
      )
        return "inactive" as const
      if (workflow.status === "paused") return "paused" as const
      if (workflow.status !== "running" && workflow.status !== "stepping") {
        return "inactive" as const
      }

      yield* pause(lock, dagID)
      return "paused" as const
    })
    const resume = Effect.fn("Dag.resume")(function* (lock: WorkflowLock, dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.RUNNING)
      yield* events.publish(DagEvent.WorkflowResumed, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })

    const step = Effect.fn("Dag.step")(function* (lock: WorkflowLock, dagID: string) {
      // Guard: only `running` → `stepping` is valid.
      yield* guardWorkflow(dagID, WorkflowStatus.STEPPING)
      // Reject if a node is still in-flight (one-at-a-time stepping). Queued
      // counts as in-flight: the node is durably admitted and will start once
      // a permit frees (P0-2) — stepping alongside it would put two nodes in
      // flight.
      // Rev-view (v1.0.15 Train A): step computes readiness over the CURRENT
      // graph revision — superseded rows must not re-seed their failures or
      // edges into the transient runtime. Superseded rows are terminal, so
      // the in-flight check is unaffected by the filter.
      const nodes = yield* store.getCurrentNodes(dagID)
      const hasInFlight = nodes.some((n) => n.status === "running" || n.status === "queued")
      if (hasInFlight) return yield* Effect.fail(new Error(`Node still in-flight: cannot step ${dagID}`))
      // Compute ready nodes using a transient WorkflowRuntime.
      const schedulingNodes = toSchedulingNodes(nodes)
      const config = parseWorkflowConfig((yield* store.getWorkflow(dagID))?.config ?? "")
      const maxConcurrency = Math.max(1, config?.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
      const runtime = new WorkflowRuntime(schedulingNodes, maxConcurrency)
      const ready = runtime.getReadyNodes()
      // A previously skipped dependency can leave a pending cascade node as
      // the only legal work. Give the loop a control event so it can converge
      // that non-executing state instead of stranding the workflow forever.
      const cascade = runtime.getCascadeSkipNodes()
      const nodeID = (ready.length > 0 ? ready : cascade).slice().sort()[0]
      if (!nodeID) return { status: "no_ready_nodes" as const }
      yield* events.publish(DagEvent.WorkflowStepped, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        timestamp: yield* DateTime.now,
      })
      return { status: "stepping" as const, nodeID }
    })
    // Publish terminal node events for any non-terminal nodes so the read
    // model stays consistent after workflow termination. Running nodes get
    // NodeFailed when the workflow fails, otherwise a distinct NodeAborted;
    // pending/queued nodes get NodeSkipped. The projector's status guards make this
    // safe against races — a node that transitioned between the read and the
    // publish is silently left at its current status.
    const terminateNonTerminalNodes = Effect.fnUntraced(function* (
      lock: WorkflowLock,
      dagID: string,
      skipReason: "agent_complete" | "workflow_cancelled" | "workflow_failed",
      failReason: string,
      failRunning: boolean,
    ) {
      const nodes = yield* store.getNodes(dagID)
      for (const node of nodes) {
        if (isNodeTerminalStatus(node.status as NodeStatus)) continue
        const ts = yield* DateTime.now
        if (failRunning && node.status === "running") {
          yield* events.publish(DagEvent.NodeFailed, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: failReason,
            trigger: "exec_failed" as never,
            timestamp: ts,
          })
        } else if (node.status === "running" || node.status === "paused") {
          yield* events.publish(DagEvent.NodeAborted, {
            dagID: ID.make(dagID),
            nodeID: NodeID.make(node.id),
            reason: skipReason,
            timestamp: ts,
          })
        } else {
          yield* events.publish(DagEvent.NodeSkipped, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: skipReason,
            timestamp: ts,
          })
        }
      }
    })

    const cancel = Effect.fn("Dag.cancel")(function* (lock: WorkflowLock, dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.CANCELLED)
      yield* events.publish(DagEvent.WorkflowCancelled, { dagID: dagID as ID, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(lock, dagID, "workflow_cancelled", "workflow_cancelled", false)
    })
    const complete = Effect.fn("Dag.complete")(function* (
      lock: WorkflowLock,
      dagID: string,
      options?: { readonly skipReviewGate?: boolean; readonly allowAcceptedSkips?: boolean },
    ) {
      yield* guardWorkflow(dagID, WorkflowStatus.COMPLETED)
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      const config = workflow ? parseWorkflowConfig(workflow.config) : undefined
      const nodes = yield* store.getNodes(dagID)
      // The review gate guards EXPLICIT completion (tool/HTTP shortcuts). A
      // natural completion at a REJECT checkpoint must stay reachable so the
      // parent can dispose of the verdict via reopen-extend (issue #294); the
      // scheduling loop passes skipReviewGate for that path.
      const unresolvedReviews =
        !options?.skipReviewGate && config ? unresolvedReviewOutcomes(config, nodes) : []
      if (unresolvedReviews.length > 0) yield* Effect.fail(new ReviewGateError(dagID, unresolvedReviews))
      // Required verdict/skip gaps gate every completion, including the
      // natural path: a verify FAIL or an unaccepted required skip must never
      // be announced as success (issue #950). Explicit completion is strict
      // even for nodes that have not started: forced completion cannot bypass
      // the invariant. The loop opts into historical accepted skips only on
      // its natural completion path, where the runtime has already proved the
      // graph terminal. Superseded revisions cannot block the current graph.
      const completionGaps = requiredCompletionGaps(
        config,
        yield* store.getCurrentNodes(dagID),
        options?.allowAcceptedSkips ? "natural" : "strict",
      )
      if (completionGaps.length > 0) yield* Effect.fail(new CompletionGateError(dagID, completionGaps))
      yield* terminateNonTerminalNodes(lock, dagID, "agent_complete", "", false)
      yield* events.publish(DagEvent.WorkflowCompleted, {
        dagID: dagID as ID,
        durationMs: 0 as never,
        timestamp: yield* DateTime.now,
      })
    })

    const fail = Effect.fn("Dag.fail")(function* (lock: WorkflowLock, dagID: string, reason: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.FAILED)
      yield* events.publish(DagEvent.WorkflowFailed, {
        dagID: dagID as ID,
        reason,
        failedNodes: [] as never,
        timestamp: yield* DateTime.now,
      })
      yield* terminateNonTerminalNodes(lock, dagID, "workflow_failed", reason, true)
    })

    /**
     * Terminalize a workflow that can never progress. The projector accepts
     * WorkflowFailed only from running/stepping, so a pending row takes the
     * legal pending→running leg and a paused row the paused→running leg
     * before failing. The whole sequence runs under the workflow lock; a
     * concurrent terminal transition makes one leg a no-op and the attempt
     * collapses to `ignored`.
     */
    const failUnrecoverable = Effect.fn("Dag.failUnrecoverable")(function* (
      lock: WorkflowLock,
      dagID: string,
      reason: string,
    ) {
      return yield* Effect.gen(function* () {
        const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        if (!workflow || isTerminalWorkflowStatusValue(workflow.status)) return "ignored" as const
        // Revalidate inside the lock: a SessionEvent.Moved may have re-stamped
        // the row to a valid directory after the caller observed it missing.
        // The moved workflow must continue, not be failed with a stale verdict.
        if (DagLocation.resolveExecution(workflow)._tag === "ok") return "ignored" as const
        if (workflow.status === "pending") {
          yield* events.publish(DagEvent.WorkflowStarted, { dagID: ID.make(dagID), timestamp: yield* DateTime.now })
        } else if (workflow.status === "paused") {
          yield* resume(lock, dagID)
        }
        yield* fail(lock, dagID, reason)
        return "failed" as const
      }).pipe(Effect.catchIf(isTransitionRejection, () => Effect.succeed("ignored" as const)))
    })

const TERMINAL_NODE_STATUSES = new Set(["completed", "failed", "aborted", "skipped"])

/**
 * Natural terminalization shared by the owning DagLoop and the host-level
     * supervision sweep. The decision and the transition run under the same
     * workflow lock, and an optional expectedGraphRev fences a stale runtime
     * snapshot: a recover/replan that bumped the revision wins instead of
     * being failed with the old graph's evidence.
     */
    const settleCompletion = Effect.fn("Dag.settleCompletion")(function* (
      lock: WorkflowLock,
      dagID: string,
      options?: {
        readonly expectedGraphRev?: number
        readonly allowAcceptedSkips?: boolean
        readonly skipReviewGate?: boolean
        readonly owner?: WorkflowOwner
      },
    ) {
      // The authoritative reads, outcome, and terminal event (plus its
      // read-model projection) must share one durable SQLite immediate
      // transaction. fenceWorkflow owns that transaction; a nested
      // events.publish uses a savepoint on the same connection, so a recover
      // in another process cannot advance the graph between the reads and the
      // terminal write. Without a mailbox service (unit harnesses), the same
      // decision runs unfenced.
      const terminalize = Effect.gen(function* () {
        const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        if (!workflow || isTerminalWorkflowStatusValue(workflow.status))
          return { status: "ignored" as const }
        if (options?.expectedGraphRev !== undefined && workflow.graphRev !== options.expectedGraphRev)
          return { status: "stale" as const }
        if (workflow.status === "paused") return { status: "ignored" as const }
        if (options?.owner) {
          const owner = options.owner
          const owned =
            workflow.projectId === owner.projectID &&
            workflow.directory !== null &&
            DagLocation.canonicalDirectory(workflow.directory) === DagLocation.canonicalDirectory(owner.directory)
          // Re-check inside the fence: a SessionEvent.Moved may have re-stamped
          // the row after the caller's precheck, and the old instance must not
          // publish a terminal outcome for the new owner's workflow.
          if (!owned) return { status: "ignored" as const }
        }
        const nodes = yield* store.getCurrentNodes(dagID)
        const config = parseWorkflowConfig(workflow.config)
        // A required failure terminalizes now, even when its dependents are
        // still mounted as pending rows: the failure cascade makes them
        // non-executable and `fail` terminalizes them durably.
        const failed = nodes.filter((node) => node.required && node.status === "failed").map((node) => node.id)
        if (failed.length > 0) {
          yield* fail(lock, dagID, `required node(s) failed: ${failed.join(", ")}`)
          return { status: "failed" as const }
        }
        if (nodes.length === 0 || nodes.some((node) => !TERMINAL_NODE_STATUSES.has(node.status)))
          return { status: "ignored" as const }
        const gaps = requiredCompletionGaps(
          config,
          nodes,
          options?.allowAcceptedSkips === false ? "strict" : "natural",
        )
        if (gaps.length > 0) {
          yield* fail(lock, dagID, `required node(s) did not complete: ${gaps.join(", ")}`)
          return { status: "failed" as const }
        }
        yield* complete(lock, dagID, {
          skipReviewGate: options?.skipReviewGate ?? true,
          allowAcceptedSkips: options?.allowAcceptedSkips ?? true,
        })
        return { status: "completed" as const }
      })
      const fenced = Option.isSome(mailboxService)
        ? mailboxService.value.fenceWorkflow(
            dagID,
            (result) =>
              result.status === "completed" || result.status === "failed" ? result.status : undefined,
            terminalize,
          )
        : terminalize
      return yield* fenced.pipe(
        Effect.catchIf(isTransitionRejection, () => Effect.succeed({ status: "ignored" as const })),
      )
    })

    const _replan = Effect.fn("Dag._replan")(function* (
      lock: WorkflowLock,
      dagID: string,
      fragment: { nodes: NodeConfig[] },
      reopenCompleted = false,
      action: "extend" | "replan" = "replan",
    ) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (
        isWorkflowTerminalStatus(workflow.status as WorkflowStatus) &&
        !(reopenCompleted && workflow.status === WorkflowStatus.COMPLETED)
      ) {
        return yield* Effect.fail(new TerminalViolationError(dagID, workflow.status, "replan"))
      }
      const wfConfig = parseWorkflowConfig(workflow.config)
      if (!wfConfig) {
        return yield* Effect.fail(new Error(`Replan rejected: current workflow config is invalid: ${dagID}`))
      }
      const defaults = normalizeNodeDefaults(wfConfig.node_defaults)
      const cfgById = new Map(wfConfig.nodes.map((n) => [n.id, n]))
      // #943: direct Dag service callers bypass the authoring boundary. Pin
      // node workspaces to canonical realpaths before the definition reaches
      // the merged config; invalid values are an ordinary Effect failure.
      const fragmentNodes = yield* Effect.try({
        try: () => pinNodeWorkspaces(fragment.nodes, workflow.directory ?? ""),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const normalizedFragment = {
        nodes: fragmentNodes.map((node) =>
          normalizeFragmentNode(node, cfgById.get(node.id), defaults),
        ),
      }
      const nodes = yield* store.getNodes(dagID)
      const plan = planReplan(
        {
          nodes: nodes.map((n) => ({
            id: n.id,
            status: n.status as never,
            depends_on: n.dependsOn,
            superseded: n.superseded,
          })),
        },
        {
          nodes: normalizedFragment.nodes.map((n) => ({
            id: n.id,
            depends_on: n.depends_on,
            restart: n.restart,
            cancel: n.cancel,
          })),
        },
      )
      if (plan.errors.length > 0) return yield* Effect.fail(new Error(`Replan rejected: ${plan.errors.join("; ")}`))

      const nodeStatusById = new Map(nodes.map((n) => [n.id, n.status]))
      const definitionErrors: string[] = []
      for (const next of normalizedFragment.nodes) {
        if (next.cancel || next.restart) continue
        const status = nodeStatusById.get(next.id)
        if (status !== NodeStatus.RUNNING && status !== NodeStatus.QUEUED && status !== NodeStatus.PAUSED) continue
        const current = cfgById.get(next.id)
        if (!current) {
          definitionErrors.push(
            `Node "${next.id}" is ${status}, but its current execution definition is unavailable and cannot be safely replaced`,
          )
          continue
        }
        const fields = ReplanDefinition.changedAdmittedNodeFields(
          withoutSkipOk(normalizeNodeConfig(current, defaults)),
          withoutSkipOk(next),
          { allowTimeoutUpdate: status === NodeStatus.RUNNING },
        )
        if (fields.length === 0) continue
        definitionErrors.push(
          status === NodeStatus.RUNNING
            ? `Node "${next.id}" is running and changes admitted execution fields without restart: ${fields.join(", ")}; set restart: true to apply the new definition`
            : `Node "${next.id}" is ${status} and changes already captured execution fields: ${fields.join(", ")}; ${status} nodes cannot restart, so cancel it and add a replacement node under a new id`,
        )
      }
      if (definitionErrors.length > 0) {
        return yield* Effect.fail(new Error(`Replan rejected: ${definitionErrors.join("; ")}`))
      }

      // Fragment nodes that will actually (re)run must satisfy the same
      // condition-reference rule as create. Terminal nodes in the fragment are
      // ignored by the plan and keep their immutable definitions; cancelled
      // nodes never evaluate a condition again.
      const rerunNodes = normalizedFragment.nodes.filter((n) => {
        if (n.cancel) return false
        const status = nodeStatusById.get(n.id)
        return status === undefined || !isNodeTerminalStatus(status as NodeStatus)
      })

      // Structural validation through the SAME authority as create — condition,
      // binding, dangling-dep, ceiling, review-lifecycle, and topology checks
      // all run through DagValidation.replanStructuralDiagnostics (which reuses
      // the exact same helper functions as structuralDiagnostics). This is the
      // create/replan parity the spec requires: one authority, two entry points
      // that differ only in scoping (fragment + rerun-only vs whole-graph).
      const maxReplanAttempts = wfConfig.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts
      const terminalNodeIds = new Set(
        nodes.filter((n) => isNodeTerminalStatus(n.status as NodeStatus)).map((n) => n.id),
      )
      const merged = computeMergedConfig(wfConfig, normalizedFragment, plan)
      const replanDiagnostics = DagValidation.replanStructuralDiagnostics({
        fragmentNodes: normalizedFragment.nodes,
        rerunNodes,
        existingNodeIds: new Set(nodes.map((n) => n.id)),
        existingNodeCount: nodes.length,
        addCount: plan.add.length,
        merged,
        action,
        config: { mode: wfConfig.mode, max_total_nodes: wfConfig.max_total_nodes },
        terminalNodeIds,
        grandfatheredNodeIds: persistedGateNodeIds(merged.nodes, cfgById),
      })
      const replanErrors = DagValidation.sortLegacyStructural(replanDiagnostics.filter((d) => d.severity === "error"))
      for (const warning of replanDiagnostics.filter((d) => d.severity === "warning")) {
        yield* Effect.logWarning("DAG structural validation diagnostic", { diagnostic: warning })
      }
      if (replanErrors.length > 0) {
        return yield* Effect.fail(new StructuralValidationError({ diagnostics: replanErrors }))
      }

      const nodeById = new Map(nodes.map((n) => [n.id, n]))
      const ceilingBreached: string[] = []
      const batch: BatchEvent[] = []
      for (const id of plan.restart) {
        const existing = nodeById.get(id)
        if (existing && existing.replanAttempts >= maxReplanAttempts) {
          batch.push({
            definition: DagEvent.NodeFailed,
            data: {
              dagID: DagEvent.DagID.make(dagID),
              nodeID: DagEvent.NodeID.make(id),
              reason: "replan attempt ceiling exceeded",
              trigger: "exec_failed",
              timestamp: yield* DateTime.now,
            },
          })
          ceilingBreached.push(id)
        }
      }
      const effectiveRestart = plan.restart.filter((id) => !ceilingBreached.includes(id))

      const fragmentById = new Map(normalizedFragment.nodes.map((n) => [n.id, n]))
      for (const id of plan.add) {
        const node = fragmentById.get(id)!
        batch.push({
          definition: DagEvent.NodeRegistered,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            name: node.name,
            workerType: node.worker_type,
            dependsOn: node.depends_on.map((d) => d as never),
            required: node.required,
            model: node.model as never,
            timestamp: yield* DateTime.now,
          },
        })
      }
      // Replaced nodes: re-publish NodeRegistered so the projector upserts the
      // new definition (worker_type, model, depends_on) into the read-model row.
      for (const id of plan.replace) {
        const node = fragmentById.get(id)
        if (!node) continue
        batch.push({
          definition: DagEvent.NodeRegistered,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            name: node.name,
            workerType: node.worker_type,
            dependsOn: node.depends_on.map((d) => d as never),
            required: node.required,
            model: node.model as never,
            timestamp: yield* DateTime.now,
          },
        })
      }
      for (const id of plan.cancel) {
        batch.push({
          definition: DagEvent.NodeCancelled,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            timestamp: yield* DateTime.now,
          },
        })
      }
      for (const id of effectiveRestart) {
        // A restart re-spawns with the fragment's definition — the new
        // depends_on must reach the durable row BEFORE the runtime rebuilds
        // its graph from store.getNodes (WorkflowReplanned handler), or the
        // restarted node keeps its stale edges and is re-ready under them.
        // Mirrors the replace bucket's NodeRegistered re-publish.
        const node = fragmentById.get(id)
        if (node) {
          batch.push({
            definition: DagEvent.NodeRegistered,
            data: {
              dagID: dagID as ID,
              nodeID: id as never,
              name: node.name,
              workerType: node.worker_type,
              dependsOn: node.depends_on.map((d) => d as never),
              required: node.required,
              model: node.model as never,
              timestamp: yield* DateTime.now,
            },
          })
        }
        batch.push({
          definition: DagEvent.NodeRestarted,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            childSessionID: (nodeById.get(id)?.childSessionId ?? "") as never,
            timestamp: yield* DateTime.now,
          },
        })
      }

      // #6: build effective plan that excludes ceiling-breached restarts
      const effectivePlan = { ...plan, restart: effectiveRestart }
      // A failed row leaves the current revision only when the merged graph
      // routes around it. While a node that can still execute depends on it,
      // superseding would drop that edge from the rebuilt graph and run the
      // dependent as a root despite its failed upstream.
      const cancelled = new Set(effectivePlan.cancel)
      const liveDependencies = new Set([
        ...nodes
          .filter((n) => !terminalNodeIds.has(n.id) && !cancelled.has(n.id) && !ceilingBreached.includes(n.id))
          .flatMap((n) => fragmentById.get(n.id)?.depends_on ?? n.dependsOn),
        ...effectivePlan.add.flatMap((id) => fragmentById.get(id)?.depends_on ?? []),
      ])

      // Persist the merged config using the effective plan (without ceiling-breached restarts)
      const mergedConfig = computeMergedConfig(wfConfig, normalizedFragment, effectivePlan)
      batch.push({
        definition: DagEvent.WorkflowConfigUpdated,
        data: {
          dagID: dagID as ID,
          config: JSON.stringify(mergedConfig),
          timestamp: yield* DateTime.now,
        },
      })

      // #7: max_total_nodes check is non-atomic (read-then-publish). This is
      // acceptable because the ceiling is a fail-safe, not a correctness
      // invariant — concurrent replans slightly exceeding the limit is better
      // than serializing all replans. The projector's INSERT ON CONFLICT
      // ensures no duplicate node IDs.
      batch.push({
        definition: DagEvent.WorkflowReplanned,
        data: {
          dagID: dagID as ID,
          added: effectivePlan.add.length as never,
          removed: effectivePlan.cancel.length as never,
          replaced: effectivePlan.replace.length as never,
          restarted: effectivePlan.restart.length as never,
          // Rev-view (v1.0.15 Train A): the terminal-FAILED rows at replan time
          // are the segment the new revision replaces — left in the rebuild
          // input they re-seed as required-unsatisfied and weld the workflow to
          // failure (the wake-up bug this train breaks). plan.cancel rows are
          // marked superseded by the NodeCancelled projection instead; this
          // list carries the genuine failures the fragment bypasses, which the
          // engine never cancels. Durable rows stay untouched. A failure that a
          // surviving node still depends on stays current (see liveDependencies).
          superseded: nodes
            .filter((n) => n.status === "failed" && !liveDependencies.has(n.id))
            .map((n) => DagEvent.NodeID.make(n.id)),
          timestamp: yield* DateTime.now,
        },
      })
      yield* withMailbox(dagID, undefined, events.publishMany(batch))
      return {
        cancel: effectivePlan.cancel,
        restart: effectivePlan.restart,
        replace: effectivePlan.replace,
        add: effectivePlan.add,
        ignore: effectivePlan.ignore,
      }
    })

    const _extend = Effect.fn("Dag._extend")(function* (
      lock: WorkflowLock,
      dagID: string,
      newNodes: NodeConfig[],
      fence?: { nodeID: string; attempt: NodeExecutionAttempt },
    ) {
      const wf = yield* store.getWorkflow(dagID)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      if (fence) {
        // Checked under the same lock that applies the mutation: a parent
        // replan or cancel between the scheduling snapshot and here wins.
        const fenced = nodes.find((node) => node.id === fence.nodeID)
        if (!fenced) return yield* Effect.fail(new Error(`Node not found: ${fence.nodeID}`))
        yield* guardNodeAttempt(fenced, wf.graphRev, fence.attempt)
        // Only a still-pending writer may be reshaped; anything else is a
        // stale attempt even when the caller supplied no node sequence.
        if (fenced.status !== "pending") {
          return yield* Effect.fail(
            new StaleNodeAttemptError(fence.nodeID, fence.attempt, {
              replanAttempts: fenced.replanAttempts,
              nodeSeq: fenced.seq,
              childSessionID: fenced.childSessionId,
              graphRev: wf.graphRev,
            }),
          )
        }
      }
      const config = parseWorkflowConfig(wf.config)
      const cfgById = new Map((config?.nodes ?? []).map((n) => [n.id, n]))
      const newIds = new Set(newNodes.map((n) => n.id))
      // extend is additive: carry forward pending/queued/paused nodes (with their
      // existing config definition) so replan treats them as "replace" (preserved)
      // rather than "supersede" (cancelled). Running nodes are intentionally
      // excluded — the merged config (computeMergedConfig: surviving = every
      // non-cancel node) already keeps a running node's definition whether or
      // not the fragment mentions it, so there is nothing to carry forward.
      // Note (§3.7): the WorkflowReplanned handler re-times a running survivor
      // only when the replan carries a NEW worker_config.timeout_ms for it
      // (deadline = now + new timeout). Unchanged/omitted timeout keeps the
      // current deadline and the extension count is never reset by an extend.
      // Terminal nodes are immutable and need no preservation.
      const toPreserve = nodes.filter(
        (n) =>
          !newIds.has(n.id) &&
          (n.status === NodeStatus.PENDING || n.status === NodeStatus.QUEUED || n.status === NodeStatus.PAUSED),
      )
      if (toPreserve.length > 0 && !config) {
        return yield* Effect.fail(
          new Error(
            `Cannot extend: workflow config is unparseable — would silently cancel ${toPreserve.length} pending node(s)`,
          ),
        )
      }
      const preserved = toPreserve.map((n) => cfgById.get(n.id)).filter((n): n is NodeConfig => n !== undefined)
      const configuredNodes = config?.nodes ?? []
      // Leaf qualification runs on the RUNTIME topology, not the static config:
      // a dependent that was skipped (condition_false / orphan_cascade) never
      // executed, so the graph effectively ended at the checkpoint and the
      // naturally-completed workflow may still be reopened by additive extend.
      // Dependents that completed or failed continued the graph past the
      // checkpoint and block the exception. Row statuses are compared as
      // plain strings (loop.ts convention) — enum casts on read-model rows
      // trip the lint ratchet.
      const executedDependents = (nodeID: string) =>
        nodes.filter(
          (candidate) =>
            candidate.dependsOn.includes(nodeID) && (candidate.status === "completed" || candidate.status === "failed"),
        )
      const checkpointCandidates = nodes.filter(
        (node) =>
          node.status === "completed" &&
          node.wakeEligible &&
          configuredNodes.some((candidate) => candidate.id === node.id),
      )
      const hasReportingLeafCheckpoint = checkpointCandidates.some((node) => executedDependents(node.id).length === 0)
      const addsNewNode = newNodes.some((node) => !nodes.some((existing) => existing.id === node.id))
      const earlyCompleted = nodes.some((node) => node.errorReason === "agent_complete")
      const reopenCompleted = wf.status === "completed" && addsNewNode && hasReportingLeafCheckpoint && !earlyCompleted
      function reopenDenial(workflowStatus: string): string | undefined {
        if (workflowStatus === "archived") return "archived workflows are immutable — start a new workflow instead"
        if (workflowStatus !== "completed")
          return "only a naturally completed workflow can be reopened — failed and cancelled workflows are immutable; start a new workflow reusing their completed outputs as static input"
        if (!addsNewNode) return "the fragment adds no new node ids — an additive reopen requires at least one new node"
        if (earlyCompleted)
          return "the workflow was completed early via control(complete); early completion stays terminal"
        if (checkpointCandidates.length === 0)
          return "no wake-eligible reporting checkpoint completed the graph — only a naturally completed reporting-leaf checkpoint may be reopened"
        const blockers = [
          ...new Set(
            checkpointCandidates.flatMap((node) => executedDependents(node.id).map((dependent) => dependent.id)),
          ),
        ]
        return `reporting checkpoint(s) ${checkpointCandidates.map((node) => `"${node.id}"`).join(", ")} are followed by executed dependent(s) ${blockers.map((id) => `"${id}"`).join(", ")} — the graph continued past the checkpoint`
      }
      // A terminal atomic wake may ask the parent to add the next bounded wave.
      // Keep the exception private to naturally completed additive extension;
      // an early control(complete) leaves an agent_complete marker and remains
      // terminal, as do public replan and non-additive terminal mutations.
      const wfTerminal =
        wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled" || wf.status === "archived"
      if (wfTerminal && !reopenCompleted) {
        return yield* Effect.fail(new TerminalViolationError(dagID, wf.status, "extend", reopenDenial(wf.status)))
      }
      // Internal call to _replan — shares the caller's lock holding period,
      // does NOT re-acquire the per-workflow lock or go through Service.of.
      return yield* _replan(lock, dagID, { nodes: [...preserved, ...newNodes] }, reopenCompleted, "extend")
    })

    const recover: Interface["recover"] = Effect.fn("Dag.recover")(function* (dagID, input) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (!Number.isSafeInteger(input.expectedGraphRev) || input.expectedGraphRev !== workflow.graphRev) {
        return yield* Effect.fail(
          new Error(`Recovery rejected: stale expected_graph_rev; current graph_rev is ${workflow.graphRev}`),
        )
      }
      if (workflow.status !== "paused" && workflow.status !== "failed" && workflow.status !== "cancelled") {
        return yield* Effect.fail(
          new Error(
            workflow.status === "completed" || workflow.status === "archived"
              ? `Recovery requires a paused or failed workflow; ${workflow.status} cannot recover. It is terminal: if in-scope work remains, extend it when allowed or start a bounded successor workflow that reuses its valid outputs — no user approval is needed for work the original request already covers`
              : `Recovery requires a paused or failed workflow; ${workflow.status} cannot recover (pause live scheduling first)`,
          ),
        )
      }
      if (workflow.status === "cancelled" && !input.resumeCancelled) {
        return yield* Effect.fail(
          new Error("Recovery of a cancelled workflow requires explicit resume_cancelled: true"),
        )
      }
      const config = parseWorkflowConfig(workflow.config)
      if (!config) return yield* Effect.fail(new Error(`Recovery cannot read the workflow definition: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      const plan = yield* Effect.try({
        try: () =>
          planRecovery(
            config,
            nodes,
            input.nodeIDs,
            workflow.graphRev + 1,
            config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
            DagLocation.fingerprintTarget(workflow.executionDirectory || workflow.directory || ""),
          ),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const selected = config.delivery_node
      const replacement = plan.replacements.find((node) => node.previous === selected)
      plan.config = reconcileDeliveryNode(
        { ...plan.config, ...(replacement ? { delivery_node: replacement.current } : {}) },
        config,
      )
      const addedIDs = new Set(plan.replacements.map((replacement) => replacement.current))
      const added = plan.config.nodes.filter((node) => addedIDs.has(node.id))
      const diagnostics = DagValidation.replanStructuralDiagnostics({
        fragmentNodes: added,
        rerunNodes: added,
        existingNodeIds: new Set(plan.preserved),
        existingNodeCount: nodes.length,
        addCount: added.length,
        merged: plan.config,
        terminalNodeIds: new Set(plan.reused),
        // Recovery authors no definitions: retries and termination collateral
        // are copies of stored nodes, so every gate keeps its accepted form.
        grandfatheredNodeIds: new Set(plan.config.nodes.map((node) => node.id)),
        action: "recover",
        config,
      }).filter((diagnostic) => diagnostic.severity === "error")
      if (diagnostics.length > 0) return yield* Effect.fail(new StructuralValidationError({ diagnostics }))

      // Hashing is outside the workflow mutex. Both workflow and node sequence
      // fences are rechecked in the durable batch before any projection changes.
      for (const id of plan.reused) {
        const node = nodes.find((candidate) => candidate.id === id)!
        yield* verifyOutputFileRef(node.capturedOutput).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `Recovery cannot reuse artifact from node "${id}": ${error.message}; include this node in node_ids to recompute it`,
              ),
          ),
        )
      }
      return yield* withWorkflowLock(dagID)((_lock) =>
        Effect.gen(function* () {
          const current = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (!current || current.seq !== workflow.seq || current.graphRev !== input.expectedGraphRev) {
            return yield* Effect.fail(
              new Error("Recovery rejected: workflow changed during artifact verification; inspect status and retry"),
            )
          }
          const timestamp = yield* DateTime.now
          // This fenced event is first so its projector can validate the original
          // snapshot. publishMany commits all new attempts/config atomically.
          const batch: BatchEvent[] = [
            {
              definition: DagEvent.WorkflowReplanned,
              data: {
                dagID: ID.make(dagID),
                added: added.length,
                removed: plan.superseded.length,
                replaced: 0,
                restarted: 0,
                superseded: plan.superseded.map((id) => NodeID.make(id)),
                recovery: {
                  expectedGraphRev: input.expectedGraphRev,
                  expectedSeq: workflow.seq,
                  nodeSeqs: nodes.map((node) => ({ nodeID: NodeID.make(node.id), seq: node.seq })),
                  resumeCancelled: input.resumeCancelled === true,
                },
                timestamp,
              },
            },
          ]
          for (const id of plan.superseded) {
            const node = nodes.find((candidate) => candidate.id === id)!
            if (isNodeTerminalStatus(node.status as NodeStatus)) continue
            batch.push({
              definition: DagEvent.NodeCancelled,
              data: { dagID: ID.make(dagID), nodeID: NodeID.make(id), timestamp },
            })
          }
          for (const node of added) {
            batch.push({
              definition: DagEvent.NodeRegistered,
              data: {
                dagID: ID.make(dagID),
                nodeID: NodeID.make(node.id),
                name: node.name,
                workerType: node.worker_type,
                dependsOn: node.depends_on.map((id) => NodeID.make(id)),
                required: node.required ?? false,
                ...(node.model ? { model: node.model } : {}),
                timestamp,
              },
            })
          }
          batch.push({
            definition: DagEvent.WorkflowConfigUpdated,
            data: {
              dagID: ID.make(dagID),
              config: JSON.stringify(plan.config),
              timestamp,
            },
          })
          yield* withMailbox(dagID, undefined, events.publishMany(batch))
          const { config: _config, ...result } = plan
          return { ...result, graphRev: workflow.graphRev + 1 }
        }),
      )
    })

    const retarget = Effect.fn("Dag.retarget")(function* (
      lock: WorkflowLock,
      dagID: string,
      input: { workspace?: string; fingerprint?: string; nodeIDs?: readonly string[]; reason?: string },
    ) {
      const workflow = yield* guardWorkflowNotTerminal(dagID, "retarget")
      if (input.workspace === undefined && input.fingerprint === undefined) {
        return yield* Effect.fail(new Error("Retarget rejected: provide workspace or fingerprint"))
      }
      const ownerDirectory = workflow.directory ?? ""
      let toDirectory: string | undefined
      if (input.workspace !== undefined) {
        const resolved = DagLocation.resolveWorkspace(input.workspace, ownerDirectory)
        if (resolved._tag === "invalid") {
          return yield* Effect.fail(new Error(`Retarget rejected: ${resolved.reason}`))
        }
        toDirectory = resolved.directory
      }
      // #945: the fingerprint is always computed from the bound tree. A caller
      // that supplies an expected value gets fail-closed validation, not a
      // writable field: durable fingerprints must remain runtime-derived.
      const executionDirectory = toDirectory ?? workflow.executionDirectory ?? workflow.directory ?? ""
      const toFingerprint = DagLocation.fingerprintTarget(executionDirectory)
      if (input.fingerprint !== undefined) {
        const actual = toFingerprint.kind === "git" ? toFingerprint.value : "none"
        if (input.fingerprint !== actual) {
          return yield* Effect.fail(
            new Error(`Retarget rejected: expected target fingerprint ${input.fingerprint}, but ${actual} is current`),
          )
        }
      }
      const config = parseWorkflowConfig(workflow.config)
      if (!config) return yield* Effect.fail(new Error(`Retarget rejected: workflow config is invalid: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      const configByID = new Map(config.nodes.map((node) => [node.id, node]))
      const fromDirectory = workflow.executionDirectory ?? workflow.directory ?? undefined
      const fromFingerprint = workflow.targetFingerprint ?? undefined
      const targetChanged =
        DagLocation.canonicalDirectory(executionDirectory) !== DagLocation.canonicalDirectory(fromDirectory ?? "") ||
        !fromFingerprint ||
        !DagLocation.sameFingerprint(fromFingerprint, toFingerprint)
      const completed = targetChanged
        ? nodes.filter(
            (node) =>
              !node.superseded &&
              node.status === "completed" &&
              targetSensitiveNode(configByID.get(node.id), node.workerType),
          )
        : []
      if (completed.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Retarget rejected: completed target-sensitive node(s) ${completed.map((node) => node.id).join(", ")}; recover them before retargeting, then re-run their evidence on the new target`,
          ),
        )
      }
      const sensitive = nodes.filter(
        (node) =>
          node.status === "running" &&
          targetSensitiveNode(configByID.get(node.id), node.workerType),
      )
      let selected = sensitive
      if (input.nodeIDs !== undefined) {
        if (input.nodeIDs.length === 0) {
          return yield* Effect.fail(new Error("Retarget rejected: node_ids must not be empty"))
        }
        const requested = new Set(input.nodeIDs)
        const rejected = [...requested].filter((id) => !sensitive.some((node) => node.id === id))
        if (rejected.length > 0) {
          return yield* Effect.fail(
            new Error(
              `Retarget rejected: node(s) are not running target-sensitive attempts: ${rejected.join(", ")}`,
            ),
          )
        }
        selected = sensitive.filter((node) => requested.has(node.id))
      }
      const timestamp = yield* DateTime.now
      const batch: BatchEvent[] = selected.map((node) => ({
        definition: DagEvent.NodeRestarted,
        data: {
          dagID: ID.make(dagID),
          nodeID: NodeID.make(node.id),
          childSessionID: SessionID.make(node.childSessionId ?? ""),
          timestamp,
        },
      }))
      if (toDirectory !== undefined) {
        batch.push({
          definition: DagEvent.WorkflowConfigUpdated,
          data: {
            dagID: ID.make(dagID),
            config: JSON.stringify({ ...config, workspace: toDirectory }),
            timestamp,
          },
        })
      }
      const restarted = selected.map((node) => NodeID.make(node.id))
      batch.push({
        definition: DagEvent.WorkflowReplanned,
        data: {
          dagID: ID.make(dagID),
          added: 0,
          removed: 0,
          replaced: 0,
          restarted: restarted.length,
          retarget: {
            ...(fromDirectory !== undefined ? { fromDirectory } : {}),
            ...(toDirectory !== undefined ? { toDirectory } : {}),
            ...(fromFingerprint !== undefined ? { fromFingerprint } : {}),
            toFingerprint,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            nodes: restarted,
          },
          timestamp,
        },
      })
      yield* withMailbox(dagID, undefined, events.publishMany(batch))
      return {
        nodes: restarted,
        fromDirectory,
        toDirectory,
        fromFingerprint,
        toFingerprint,
        graphRev: workflow.graphRev + 1,
      }
    })

    const nodeQueued = Effect.fn("Dag.nodeQueued")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      deadlineMs?: number,
      attempt?: NodeExecutionAttempt,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.QUEUED, attempt)
      yield* events.publish(DagEvent.NodeQueued, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        deadlineMs,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeStarted = Effect.fn("Dag.nodeStarted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
      deadlineMs?: number,
      wakeEligible?: boolean,
      attempt?: NodeExecutionAttempt,
      directory?: string,
      baseHead?: string,
      targetFingerprint?: DagEvent.TargetFingerprint,
      worktree?: DagEvent.NodeWorktree,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.RUNNING, attempt)
      yield* events.publish(DagEvent.NodeStarted, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        deadlineMs,
        wakeEligible,
        ...(directory !== undefined ? { directory } : {}),
        ...(baseHead !== undefined ? { baseHead } : {}),
        ...(targetFingerprint !== undefined ? { targetFingerprint } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        timestamp: yield* DateTime.now,
      })
    })
    const nodeCompleted = Effect.fn("Dag.nodeCompleted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      output: unknown,
      attempt?: NodeExecutionAttempt,
      capturedOutput?: unknown,
      worktree?: DagEvent.NodeWorktree,
      touchedPaths?: readonly string[],
    ) {
      const node = yield* guardNode(dagID, nodeID, NodeStatus.COMPLETED, attempt)
      const workflow = yield* store.getWorkflow(dagID)
      // #944: recompute the target identity for a node that recorded a start
      // fingerprint. Legacy and target-insensitive nodes carry none and are
      // never stale. The computation is synchronous inside the workflow lock;
      // it is the bounded git fingerprint from DagLocation.
      const startFingerprint = node.targetFingerprint ?? undefined
      const executionDirectory =
        node.directory || workflow?.executionDirectory || workflow?.directory || undefined
      const completionFingerprint =
        startFingerprint && executionDirectory ? DagLocation.fingerprintTarget(executionDirectory) : undefined
      const staleTarget = startFingerprint ? !DagLocation.sameFingerprint(startFingerprint, completionFingerprint) : false
      // #946: compare an isolated node's touched paths with the completed
      // isolated nodes already in this workflow. This is a report, never an
      // auto-merge: integration stays a normal downstream node.
      const completedNodes = worktree
        ? yield* Effect.suspend(() => store.getCurrentNodes(dagID)).pipe(
            Effect.catchCause(() => Effect.succeed([] as DagStore.NodeRow[])),
          )
        : []
      const conflicts = worktree
        ? DagIsolation.conflictsFor(
            worktree.touchedPaths,
            completedNodes
              .filter(
                (candidate) =>
                  candidate.id !== nodeID &&
                  candidate.status === "completed" &&
                  candidate.worktreeState !== null &&
                  candidate.worktreeState !== undefined &&
                  (candidate.touchedPaths?.length ?? 0) > 0,
              )
              .map((candidate) => ({ id: candidate.id, touchedPaths: candidate.touchedPaths ?? [] })),
          )
        : []
      const finalWorktree = worktree
        ? {
            ...worktree,
            conflictsWith: conflicts.map((conflict) => conflict.nodeID),
          }
        : undefined
      const messages = mailboxService
      const commit = Effect.gen(function* () {
        yield* guardNode(dagID, nodeID, NodeStatus.COMPLETED, attempt)
        yield* events.publish(
          DagEvent.NodeCompleted,
          Schema.decodeUnknownSync(DagEvent.NodeCompleted.data)({
            dagID,
            nodeID,
            output,
            ...(capturedOutput !== undefined ? { capturedOutput } : {}),
            ...(completionFingerprint !== undefined ? { targetFingerprint: completionFingerprint } : {}),
            ...(staleTarget ? { staleTarget: true } : {}),
            ...(finalWorktree !== undefined ? { worktree: finalWorktree } : {}),
            ...(touchedPaths !== undefined || finalWorktree !== undefined
              ? { touchedPaths: touchedPaths ?? finalWorktree?.touchedPaths ?? [] }
              : {}),
            durationMs: 0,
            timestamp: yield* Clock.currentTimeMillis,
          }),
        )
      })
      if (Option.isNone(messages) || !workflow?.directory || !node.childSessionId) {
        yield* commit
        return
      }
      const guarded = yield* messages.value.guard(
        { projectID: workflow.projectId, directory: workflow.directory, sessionID: workflow.sessionId },
        {
          workflowID: dagID,
          nodeID,
          attemptID: DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts),
          snapshotID: attempt?.inputSnapshotID ?? node.capturedSnapshotID ?? undefined,
        },
        commit,
      )
      if (!guarded.ok) {
        if (guarded.reason === "stale_input" || guarded.reason === "unassociated")
          yield* new StaleMessageInputError({ dagID, nodeID, reason: guarded.reason })
        if (guarded.reason === "stopped")
          yield* Effect.fail(new Error("The node input snapshot was blocked or failed; it cannot complete"))
        yield* Effect.fail(
          new StaleNodeAttemptError(nodeID, attempt ?? { replanAttempts: node.replanAttempts }, {
            replanAttempts: node.replanAttempts,
            childSessionID: node.childSessionId,
            nodeSeq: node.seq,
            graphRev: workflow.graphRev,
          }),
        )
      }
    })
    const nodeFailed = Effect.fn("Dag.nodeFailed")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      reason: string,
      trigger: string,
      attempt?: NodeExecutionAttempt,
      errorClass?: string,
      worktree?: DagEvent.NodeWorktree,
    ) {
      const node = yield* guardNode(dagID, nodeID, NodeStatus.FAILED, attempt)
      const workflow = yield* store.getWorkflow(dagID)
      const messages = mailboxService
      const commit = Effect.gen(function* () {
        yield* guardNode(dagID, nodeID, NodeStatus.FAILED, attempt)
        yield* events.publish(
          DagEvent.NodeFailed,
          Schema.decodeUnknownSync(DagEvent.NodeFailed.data)({
            dagID,
            nodeID,
            reason,
            trigger,
            ...(errorClass ? { errorClass } : {}),
            ...(worktree !== undefined ? { worktree } : {}),
            timestamp: yield* Clock.currentTimeMillis,
          }),
        )
      })
      if (Option.isNone(messages) || !workflow?.directory || !node.childSessionId || node.status !== "running") {
        yield* commit
        return
      }
      const guarded = yield* messages.value.guard(
        { projectID: workflow.projectId, directory: workflow.directory, sessionID: workflow.sessionId },
        {
          workflowID: dagID,
          nodeID,
          attemptID: DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts),
          failureReason: trigger,
          snapshotID: attempt?.inputSnapshotID,
          requireCurrentInput:
            trigger === "verdict_fail" &&
            (attempt?.inputSnapshotID !== undefined ||
              parseWorkflowConfig(workflow.config)?.result_protocol === "final_response"),
          expectedAcceptedRevision: attempt?.expectedAcceptedRevision,
        },
        commit,
      )
      if (!guarded.ok) {
        if (guarded.reason === "stale_input" || guarded.reason === "unassociated")
          yield* Effect.fail(new StaleMessageInputError({ dagID, nodeID, reason: guarded.reason }))
        yield* Effect.fail(new TerminalViolationError(nodeID, node.status, "failed"))
      }
    })
    const nodeSkipped = Effect.fn("Dag.nodeSkipped")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      reason: string,
      attempt?: NodeExecutionAttempt,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.SKIPPED, attempt)
      yield* events.publish(DagEvent.NodeSkipped, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        reason: reason as never,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeCancelled = Effect.fn("Dag.nodeCancelled")(function* (lock: WorkflowLock, dagID: string, nodeID: string) {
      // Cancellation is valid from any non-terminal status; no single target
      // NodeStatus is a legal transition from all of pending/queued/running/paused
      // (e.g. PAUSED -> SKIPPED is not in the table), so guard on terminality.
      yield* guardWorkflowNotTerminal(dagID, "cancelled")
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      if (isNodeTerminalStatus(node.status as NodeStatus)) {
        return yield* Effect.fail(new TerminalViolationError(nodeID, node.status, "cancelled"))
      }
      yield* events.publish(DagEvent.NodeCancelled, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeRestarted = Effect.fn("Dag.nodeRestarted")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
    ) {
      yield* guardNode(dagID, nodeID, NodeStatus.PENDING)
      yield* events.publish(DagEvent.NodeRestarted, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        timestamp: yield* DateTime.now,
      })
    })
    // Timeout escalation publishes no status transition — the node stays
    // RUNNING (see the NodeTimeoutEscalated projector). Only the extension
    // count, seq, and wake flag change.
    //
    // Ticket B (method-A — stale-read suppression): the deadline watcher reads
    // the durable row WITHOUT the workflow lock (spawn.ts readNode). Between
    // that stale snapshot and this command acquiring the lock, a replan's
    // nodeExtendTimeout may have moved the deadline into the future. Escalating
    // then would charge a max_timeout_extensions budget unit for a node that is
    // no longer overdue — a spurious T8 (the cosmetic residue self-documented
    // at loop.ts:870-880). The caller passes the deadline it OBSERVED
    // (node.deadlineMs); this command re-reads the node FRESH under the workflow
    // lock and, when the deadline has moved strictly past the observed value,
    // suppresses the escalation (no publish, no budget increment). Budget only
    // counts a real extension (a deadline that actually moved), not a stale-read
    // cosmetic recount. Suppression returns void, exactly like a publish, so the
    // watcher's self-renewal loop (S1) keeps supervising — a running node is
    // never orphaned (N1). When staleDeadlineMs is omitted (existing callers,
    // test setups) the guard is inert: back-compat is unconditional publish.
    const nodeTimeoutEscalated = Effect.fn("Dag.nodeTimeoutEscalated")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      childSessionID: string,
      timeoutExtensions: number,
      staleDeadlineMs?: number | null,
      attempt?: NodeExecutionAttempt,
    ) {
      const workflow = yield* guardWorkflowNotTerminal(dagID, "timeout escalation")
      if (attempt || staleDeadlineMs != null) {
        const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
        if (!node) return yield* Effect.fail(new InvalidTransitionError(nodeID, "missing", "timeout escalation"))
        yield* guardNodeAttempt(node, workflow.graphRev, attempt)
        if (attempt && node.status !== "running") {
          return yield* Effect.fail(new InvalidTransitionError(nodeID, node.status, "timeout escalation"))
        }
        if (
          staleDeadlineMs != null &&
          node.status === "running" &&
          node.deadlineMs != null &&
          node.deadlineMs > staleDeadlineMs
        )
          return
      }
      yield* events.publish(DagEvent.NodeTimeoutEscalated, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        childSessionID: childSessionID as never,
        timeoutExtensions,
        timestamp: yield* DateTime.now,
      })
    })
    // Adjudication of a timeout escalation (ADR-0003). Replan with a new
    // worker_config.timeout_ms recomputes the absolute deadline and records it
    // as a durable event — the direct-write path (store.updateNodeDeadline) is
    // abolished so the deadline survives replay. The guard runs HERE, in the
    // command layer, holding the workflow lock and BEFORE publish. The return
    // is a synchronous state verdict (error = state — the orchestrator observes
    // it directly, NOT via the publish chain, whose projector return value is
    // discarded). NodeDeadlineExtended is only appended on success, so it is the
    // success log; the projector does a pure idempotent fold. The contract is
    // FOUR-VALUED so the rejection reasons stay distinguishable (C1):
    //   1  = success (deadline written, NodeDeadlineExtended appended)
    //   0  = TERMINAL rejection (node not running / missing — caller drops the
    //        stale watcher; the node is done)
    //  -2  = Q2 delivery-gate rejection (node STILL running but its escalation
    //        wake is undelivered — caller MUST keep supervision; killing the
    //        watcher here would orphan a running node and defeat the cap
    //        backstop, violating N1)
    //  -3  = cumulative timeout-extension cap exhausted; the watcher still
    //        owns the running node and enforces the terminal timeout verdict
    // The single caller (loop.ts WorkflowReplanned handler) branches on this:
    // < 0 keeps the watcher (covers -2 here and -1 write-failure mapped by the
    // caller's catchCause), === 0 clears it. Dag.extendTimeout (the dedicated
    // parent-facing re-time command below) is the second caller: it maps 1 →
    // extended, -2 → escalation_undelivered, -3 → cap_exhausted,
    // 0 → not_running, and needs no
    // watcher swap (the self-healing watcher re-reads the moved deadline). The
    // only typed-error channel beyond this explicit 1/0/-2 is withWorkflowLock
    // (getNode/publish orDie their work).
    const nodeExtendTimeout = Effect.fn("Dag.nodeExtendTimeout")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      newDeadlineMs: number,
      attempt?: NodeExecutionAttempt,
    ) {
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      // running-guard: a node that terminalized between the caller's read and
      // this command is rejected (race-free — we hold the workflow lock).
      if (!node || node.status !== "running") return 0
      if (
        attempt &&
        (node.replanAttempts !== attempt.replanAttempts ||
          (attempt.childSessionID !== undefined && node.childSessionId !== attempt.childSessionID))
      )
        return 0
      // Q2 delivery gate (ADR-0002): never re-time an escalation the main agent
      // has not seen. Defense in depth — the primary gate is loop.ts:800, but
      // the command stays self-protecting so a future caller cannot bypass it.
      // Returns -2 (NOT 0): the node is still running, so the caller must keep
      // its watcher (N1). See the four-valued contract above.
      if (node.escalationPending && !node.wakeReported) return -2
      // The watcher enforces the same cap on its next deadline read. Reject
      // re-timing here under the workflow lock as well: otherwise a delivered
      // escalation at the cap can be moved up to 24 hours into the future.
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return 0
      const maxExtensions =
        parseWorkflowConfig(workflow.config)?.max_timeout_extensions ?? DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions
      if (node.timeoutExtensions >= maxExtensions) return -3
      yield* events.publish(DagEvent.NodeDeadlineExtended, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        deadlineMs: newDeadlineMs,
        timeoutExtensions: node.timeoutExtensions,
        timestamp: yield* DateTime.now,
      })
      return 1
    })

    // P0-A: dedicated parent-facing timeout extension. Grants an escalated
    // RUNNING node more time WITHOUT a full graph replan — the incident chain
    // this replaces forced the parent to resubmit the entire fragment (an
    // envelope-error trap) just to change one number, and a rejected replan then
    // drove a whole-workflow cancel. Reuses the exact durable path the replan
    // re-time uses (nodeExtendTimeout → NodeDeadlineExtended, with its Q2
    // delivery gate and cumulative cap). A formal escalation must be pending
    // and delivered before this command can extend the deadline; an elapsed
    // clock alone is not an adjudication token.
    // Does NOT bump replanAttempts, restart the agent, or touch the graph; the
    // self-healing deadline watcher (spawn.ts) re-reads the moved deadline on its
    // next wake, so supervision is never absent and no watcher swap is needed.
    const extendTimeout = Effect.fn("Dag.extendTimeout")(function* (
      lock: WorkflowLock,
      dagID: string,
      nodeID: string,
      timeoutMs: number,
    ) {
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node || node.status !== "running") return { status: "not_running" as const }
      if (!node.escalationPending) return { status: "no_escalation" as const }
      if (!node.wakeReported) return { status: "escalation_undelivered" as const }
      const now = yield* Clock.currentTimeMillis
      const deadlineMs = now + timeoutMs
      const written = yield* nodeExtendTimeout(lock, dagID, nodeID, deadlineMs, {
        replanAttempts: node.replanAttempts,
        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
      })
      if (written === 1) return { status: "extended" as const, deadlineMs }
      // -2 = Q2 delivery-gate rejection (escalation wake undelivered, node still
      // running); 0 = the node is not running (pending/queued/terminal). Neither
      // grants an extension.
      if (written === -2) return { status: "escalation_undelivered" as const }
      if (written === -3) return { status: "cap_exhausted" as const }
      return { status: "not_running" as const }
    })

    return Service.of({
      create,
      store,
      pause: (dagID) => withWorkflowLock(dagID)((lock) => pause(lock, dagID)),
      pauseForCheckpoint: (dagID, checkpointSeq) =>
        withWorkflowLock(dagID)((lock) => pauseForCheckpoint(lock, dagID, checkpointSeq)),
      resume: (dagID) => withWorkflowLock(dagID)((lock) => resume(lock, dagID)),
      step: (dagID) => withWorkflowLock(dagID)((lock) => step(lock, dagID)),
      cancel: (dagID) => withWorkflowLock(dagID)((lock) => withMailbox(dagID, "cancelled", cancel(lock, dagID))),
      complete: (dagID, options) =>
        withWorkflowLock(dagID)((lock) => withMailbox(dagID, "completed", complete(lock, dagID, options))),
      fail: (dagID, reason) =>
        withWorkflowLock(dagID)((lock) => withMailbox(dagID, "failed", fail(lock, dagID, reason))),
      failUnrecoverable: (dagID, reason) =>
        withWorkflowLock(dagID)((lock) =>
          // An `ignored` outcome means the workflow moved or terminalized
          // concurrently: the transaction must not close a live mailbox.
          withMailbox(
            dagID,
            (outcome) => (outcome === "failed" ? "failed" : undefined),
            failUnrecoverable(lock, dagID, reason),
          ),
        ),
      settleCompletion: (dagID, options) =>
        withWorkflowLock(dagID)((lock) => settleCompletion(lock, dagID, options)),
      replan: (dagID, fragment) =>
        withWorkflowLock(dagID)((lock) => withMailbox(dagID, undefined, _replan(lock, dagID, fragment))),
      extend: (dagID, nodes, fence) =>
        withWorkflowLock(dagID)((lock) => withMailbox(dagID, undefined, _extend(lock, dagID, nodes, fence))),
      recover,
      retarget: (dagID, input) =>
        withWorkflowLock(dagID)((lock) =>
          withMailbox(dagID, undefined, retarget(lock, dagID, input)),
        ),
      nodeQueued: (dagID, nodeID, deadlineMs, attempt) =>
        withWorkflowLock(dagID)((lock) => nodeQueued(lock, dagID, nodeID, deadlineMs, attempt)),
      nodeStarted: (dagID, nodeID, childSessionID, deadlineMs, wakeEligible, attempt, directory, baseHead, targetFingerprint, worktree) =>
        withWorkflowLock(dagID)((lock) =>
          nodeStarted(
            lock,
            dagID,
            nodeID,
            childSessionID,
            deadlineMs,
            wakeEligible,
            attempt,
            directory,
            baseHead,
            targetFingerprint,
            worktree,
          ),
        ),
      nodeCompleted: (dagID, nodeID, output, attempt, capturedOutput, worktree, touchedPaths) =>
        withWorkflowLock(dagID)((lock) =>
          nodeCompleted(lock, dagID, nodeID, output, attempt, capturedOutput, worktree, touchedPaths),
        ),
      nodeFailed: (dagID, nodeID, reason, trigger, attempt, errorClass, worktree) =>
        withWorkflowLock(dagID)((lock) =>
          nodeFailed(lock, dagID, nodeID, reason, trigger, attempt, errorClass, worktree),
        ),
      nodeSkipped: (dagID, nodeID, reason, attempt) =>
        withWorkflowLock(dagID)((lock) =>
          withMailbox(dagID, undefined, nodeSkipped(lock, dagID, nodeID, reason, attempt)),
        ),
      nodeCancelled: (dagID, nodeID) =>
        withWorkflowLock(dagID)((lock) => withMailbox(dagID, undefined, nodeCancelled(lock, dagID, nodeID))),
      nodeRestarted: (dagID, nodeID, childSessionID) =>
        withWorkflowLock(dagID)((lock) =>
          withMailbox(dagID, undefined, nodeRestarted(lock, dagID, nodeID, childSessionID)),
        ),
      nodeTimeoutEscalated: (dagID, nodeID, childSessionID, timeoutExtensions, staleDeadlineMs, attempt) =>
        withWorkflowLock(dagID)((lock) =>
          nodeTimeoutEscalated(lock, dagID, nodeID, childSessionID, timeoutExtensions, staleDeadlineMs, attempt),
        ),
      nodeExtendTimeout: (dagID, nodeID, newDeadlineMs, attempt) =>
        withWorkflowLock(dagID)((lock) => nodeExtendTimeout(lock, dagID, nodeID, newDeadlineMs, attempt)),
      extendTimeout: (dagID, nodeID, timeoutMs) =>
        withWorkflowLock(dagID)((lock) => extendTimeout(lock, dagID, nodeID, timeoutMs)),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagProjector.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node, DagProjector.node, DagMessages.node])
