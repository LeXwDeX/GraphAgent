// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The types of the `Dag` service that the command modules and the rest of the engine share: the workflow and
// node config as a YAML declares it, and what a few of the commands return. `dag.ts` re-exports every one of
// them, so the `@/dag/dag` export surface is the one it always was.

import type { DagEvent } from "@graphagent/schema/dag-event"
import type { AdmissionRecord, ExecutionMode } from "./admission"
import type { AcceptanceItem, PriorFinding, ReviewGate, WorkflowBlockKind } from "./blocks"

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
  /** #1158: the expansion slot of a compose block or a composer node, naming its
   * split node. A node that carries it is never to be spawned as authored: at
   * admission the split node's plan replaces it with the expanded subtree and the
   * join node under its id, as `fan_out` does for a writer
   * (`DagComposeExpansion`, in the loop's admission seam). Written by the
   * compiler (`DagCompose`), never by an author; no model-writable node schema
   * has the field. A recovery points it at the recovered split node, and a
   * replan can neither change nor clear it
   * (`ReplanDefinition.changedEngineOwnedFields`). */
  expand?: string
  /** #1158: what the join node of an expanded slot joins. Written at expansion,
   * in the same extend that replaces the slot, so the join's admission check and
   * the coverage section read the plan's items without reparsing the plan: the
   * split node the plan came from, per item the child node that runs it, its agent
   * and whether the item's work is required (the child's own `required` also
   * depends on the block, so it is not that), and the reason when the plan was not
   * expanded and one fallback worker took the whole task. Never authored. The ids
   * in it are also the keys of the join node's `input_mapping` and the keys its
   * prompt describes. A recovery points `plan` and every `node` at the attempts
   * that now count, and the keys with them; a replan can neither change nor clear
   * it, as with `expand`. An item the plan asked to split further is one of two
   * things: `nested` when its node is the join node of a nested expansion (its
   * `agent` is then the composer that joins it), or `unsplit` when it runs as one
   * worker after all, with the reason the engine did not split it (the deepest
   * level or no room left in the subtree). */
  join?: {
    plan: string
    items: { id: string; node: string; agent: string; required: boolean; nested?: true; unsplit?: string }[]
    degraded?: string
  }
  /** #1158: the mark of a node a compose expansion generated, nested expansions
   * included: its children, nested split nodes and slots, and fallback workers.
   * The author's own nodes do not carry it: the block's split node, its slot and
   * the join node that slot becomes. `root` is the id the top-level slot had when
   * it was expanded and only groups one block's subtree: it is a key, not a
   * reference, so a recovery that renames the slot leaves it alone. `depth` is the
   * level of the plan the node takes part in: the plan a worker's item came from, or
   * for a nested split node and slot the plan they make, one deeper than the plan
   * that listed the item. The expansion reads both from the persisted graph alone
   * (`DagCompose.positionOf`): the slot's own mark is its depth, and the marked
   * nodes of the current graph are what `dag.compose.max_subtree_nodes` has been
   * spent on. Planning the same persisted graph again, after a crash or a recovery,
   * therefore writes the same ids and definitions, and siblings share the quota in
   * the order they are expanded. Written by the expansion, never by an author; no
   * model-writable node schema has the field. A replan can neither change nor
   * clear it (`ReplanDefinition.changedEngineOwnedFields`). */
  compose_subtree?: { root: string; depth: number }
  /** #1158: the id of the expansion slot whose plan generated this node, which is what
   * lets a client group an expansion's nodes under it (`NodeView.expanded_from`). It is
   * on the nodes that carry `compose_subtree`: the children of the plan, the fallback
   * worker, and a nested split node and slot, which name the slot of the plan that
   * listed the item (the outer one). The children of a nested slot name the nested slot,
   * the node that expanded them, and the join node a slot becomes keeps the mark the slot
   * had. The author's own nodes, the block's split node and its top-level slot, carry
   * none. Unlike `compose_subtree.root`, which only groups, this is a reference to a
   * node of the graph: a recovery that renames the slot renames it on every node that
   * names it, the ones it reuses included (`planRecovery`). Written by the expansion,
   * never by an author; no model-writable node schema has the field. A replan can
   * neither change nor clear it (`ReplanDefinition.changedEngineOwnedFields`). */
  expanded_from?: string
  /** #943: absolute path to a linked worktree where this node runs. */
  workspace?: string
  /** #946: run this writer-capable node in a fresh worktree of the workflow
   * target. Mutually exclusive with `workspace`. */
  isolation?: "worktree"
  /** #1030 D9-h: whether the node's child may use tools that write the
   * workspace. Defaults to `deny` for review workers and the built-in auditor,
   * `allow` otherwise; shell commands keep their agent permission either way. */
  workspace_writes?: "allow" | "deny"
  /** #944: block compilation marks nodes that judge the current working tree
   * (review lanes, verify, synthesize). Their attempts record a target
   * fingerprint and a stale result cannot settle completion. */
  target_sensitive?: boolean
  /** Block-compiled node: the authored block kind that produced it. Persisted
   * so recover/retry validation keeps block semantics without the source. */
  block?: WorkflowBlockKind
  /** Review lane suffix (lens or skeptic-N). Lane nodes are read-only, and the
   * strict gate refuses an ACCEPT while any of them is not completed. */
  review_lane?: string
  /** Lenses a block-compiled review decision arbitrates. */
  review_lenses?: string[]
  /** Prior round a block-compiled review continues. */
  prior_round?: { workflow_id: string; review_id: string }
  /** Findings resolved from the referenced workflow's stored outputs. */
  prior_findings?: PriorFinding[]
  /** 1-based review round this decision belongs to. */
  review_round?: number
  /** Consecutive prior rounds that raised no new upheld finding. */
  review_quiet_rounds?: number
  /** New upheld findings the referenced round raised. */
  review_new_findings?: number
  /** The compiler-generated fan-out aggregator under a review block id. */
  aggregates_writers?: boolean
  /** Compiler-generated helper node: its worker was chosen by block
   * compilation (or by a fan-out expansion, for its aggregator), not by an
   * authored worker override. The model tier reads it (`DagConfig.tierOf`). */
  generated_helper?: "aggregate" | "evidence" | "split"
  /** #1031 M6: arbitration-depth marker for a block-compiled review decision;
   * unset for hand-authored review nodes, whose outputs keep the pre-arbitration
   * shape (no dispositions). */
  review_arbitration?: boolean
}

export interface NodeDefaults {
  required?: boolean
  worker_config?: { timeout_ms?: number }
  report_to_parent?: boolean
  model?: { modelID: string; providerID: string }
}

export interface WorkflowConfig {
  name: string
  delivery_node?: string
  mode?: ExecutionMode
  admission?: AdmissionRecord
  /** Acceptance criteria judged by the completeness review lane. */
  acceptance?: AcceptanceItem[]
  /** Review gate fixed at start; mutations validate against this value. */
  review_gate?: ReviewGate
  max_concurrency?: number
  max_node_replan_attempts?: number
  max_total_nodes?: number
  max_timeout_extensions?: number
  /** #943: absolute path to a linked worktree where child sessions run. */
  workspace?: string
  /** #1030 D9-g: run the entire workflow in one fresh worktree of the target.
   * Mutually exclusive with `workspace`; start-only (fragments cannot set it). */
  isolation?: "worktree"
  /** #1030 D9-g: runtime-owned pointer to the workflow worktree created at
   * start. Authoring never sets it; `Dag.create` records it after creation so
   * spawn, recovery, status and settlement agree on one directory/branch. */
  worktree?: WorkflowWorktreeConfig
  node_defaults?: NodeDefaults
  nodes: NodeConfig[]
}

/** #1030 D9-g: the persisted identity of a workflow-level worktree. */
export interface WorkflowWorktreeConfig {
  directory: string
  branch?: string
  baseHead?: string
}
