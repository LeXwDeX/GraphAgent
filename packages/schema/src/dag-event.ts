// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagEvent from "./dag-event"

import { Schema } from "effect"
import { NODE_STATUS_VALUES, WORKFLOW_STATUS_VALUES } from "./dag-status"
import { Event } from "./event"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { withStatics } from "./schema"
import { descending } from "./identifier"
import { SessionID } from "./session-id"
import { ProjectID } from "./project-id"
import { Provider } from "./provider"
import { Model } from "./model"

// ============================================================================
// Branded IDs
// ============================================================================

// Fully anchored pattern: llama.cpp's tool-schema conversion rejects any
// `pattern` that doesn't start with '^' and end with '$'. `^dag.*$` keeps the
// exact starts-with("dag") semantics of the previous isStartsWith filter.
export const DagID = Schema.String.check(Schema.isPattern(/^dag.*$/u)).pipe(
  Schema.brand("DagID"),
  withStatics((schema) => {
    const create = () => schema.make("dag_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type DagID = typeof DagID.Type

export const NodeID = Schema.String.pipe(Schema.brand("DagNodeID"))
export type NodeID = typeof NodeID.Type

/**
 * Optional model override for a node. When absent, the node uses its resolved
 * agent's model or falls back to the workflow-owning session's model — same
 * resolution path as the `task` tool. Lets the main agent pin different models
 * per node (e.g. GPT-5.5 for review, Sonnet-5 for code).
 */
export const NodeModel = Schema.Struct({
  modelID: Model.ID,
  providerID: Provider.ID,
})
export type NodeModel = typeof NodeModel.Type

// ============================================================================
// Shared fragments
// ============================================================================

const Base = {
  timestamp: DateTimeUtcFromMillis,
  dagID: DagID,
}

const options = {
  durable: {
    aggregate: "dagID",
    version: 1,
  },
} as const

// ============================================================================
// Status enums (D11: literal values come from the single dag-status source;
// core/types.ts derives its scheduling enums from the same arrays)
// ============================================================================

export const WorkflowStatus = Schema.Literals(WORKFLOW_STATUS_VALUES)
export type WorkflowStatus = typeof WorkflowStatus.Type

/**
 * #944: the identity of the tree a node result is bound to. `git` carries the
 * HEAD, a hash of the tracked diff, a hash of the untracked-file metadata, and
 * the combined value; `none` is the explicit marker for a non-git directory
 * (or an unborn HEAD), which is stable and never stale.
 */
export const TargetFingerprint = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    head: Schema.String,
    diff: Schema.String,
    untracked: Schema.String,
    value: Schema.String,
  }),
])
export type TargetFingerprint = typeof TargetFingerprint.Type

export const NodeStatus = Schema.Literals(NODE_STATUS_VALUES)
export type NodeStatus = typeof NodeStatus.Type

/** #946: the worktree an isolated node ran in. `started` carries only the
 * creation identity; completion/failure add the commit and patch evidence.
 * Every field is optional except state so legacy durable events decode. */
export const WorktreeState = Schema.Literals(["active", "removed", "kept"])
export type WorktreeState = typeof WorktreeState.Type

export const NodeWorktree = Schema.Struct({
  directory: Schema.String,
  branch: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  baseHead: Schema.optional(Schema.String),
  patchPath: Schema.optional(Schema.String),
  patchSha256: Schema.optional(Schema.String),
  touchedPaths: Schema.Array(Schema.String),
  state: WorktreeState,
  conflictsWith: Schema.Array(NodeID),
})
export type NodeWorktree = typeof NodeWorktree.Type

// ============================================================================
// Workflow lifecycle events
// ============================================================================

export const WorkflowCreated = Event.define({
  type: "dag.workflow.created",
  ...options,
  schema: {
    ...Base,
    projectID: ProjectID,
    sessionID: SessionID,
    title: Schema.String,
    config: Schema.String, // YAML string (validated separately by the runtime)
    status: WorkflowStatus,
    // Execution-location key (DAG-LOC-01): the creating instance's directory,
    // stamped at create. Optional so legacy durable events and manual
    // publishers still decode; the projector maps an absent directory to the
    // empty string, which no instance owns (fail-closed, never adopted).
    directory: Schema.optional(Schema.String),
    /** #943: the bound workspace (absolute realpath) where child sessions run.
     * Optional so legacy durable events still decode; absent means the owner
     * `directory`. Kept separate from `directory`, which stays the ownership
     * key used by adoption, recovery and wake. */
    executionDirectory: Schema.optional(Schema.String),
    /** #944: the target fingerprint captured when the workflow started.
     * Optional so legacy durable events still decode; an absent value projects
     * to the explicit `{ kind: "none" }` marker (non-git). */
    targetFingerprint: Schema.optional(TargetFingerprint),
  },
})
export type WorkflowCreated = typeof WorkflowCreated.Type

export const WorkflowStarted = Event.define({
  type: "dag.workflow.started",
  ...options,
  schema: Base,
})
export type WorkflowStarted = typeof WorkflowStarted.Type

export const WorkflowPaused = Event.define({
  type: "dag.workflow.paused",
  ...options,
  schema: {
    ...Base,
    /** D12: why the pause happened (e.g. "budget_exhausted"). Optional and
     * open so legacy durable events and future reasons both decode; the write
     * side narrows to the PauseReason union at the call site. */
    reason: Schema.optional(Schema.String),
  },
})
export type WorkflowPaused = typeof WorkflowPaused.Type

export const WorkflowResumed = Event.define({
  type: "dag.workflow.resumed",
  ...options,
  schema: Base,
})
export type WorkflowResumed = typeof WorkflowResumed.Type

export const WorkflowStepped = Event.define({
  type: "dag.workflow.stepped",
  ...options,
  schema: {
    ...Base,
    nodeID: Schema.optional(NodeID),
  },
})
export type WorkflowStepped = typeof WorkflowStepped.Type

export const WorkflowCompleted = Event.define({
  type: "dag.workflow.completed",
  ...options,
  schema: {
    ...Base,
    durationMs: NonNegativeInt,
  },
})
export type WorkflowCompleted = typeof WorkflowCompleted.Type

export const WorkflowFailed = Event.define({
  type: "dag.workflow.failed",
  ...options,
  schema: {
    ...Base,
    reason: Schema.String,
    failedNodes: Schema.Array(NodeID),
  },
})
export type WorkflowFailed = typeof WorkflowFailed.Type

export const WorkflowCancelled = Event.define({
  type: "dag.workflow.cancelled",
  ...options,
  schema: Base,
})
export type WorkflowCancelled = typeof WorkflowCancelled.Type

export const WorkflowReplanned = Event.define({
  type: "dag.workflow.replanned",
  ...options,
  schema: {
    ...Base,
    added: NonNegativeInt,
    removed: NonNegativeInt,
    replaced: NonNegativeInt,
    restarted: NonNegativeInt,
    // Rev-view (v1.0.15 Train A): nodes the replan pushes OUT of the current
    // graph revision — terminal rows the fragment bypasses (a failed node the
    // new path routes around). NodeCancelled covers the plan.cancel bucket
    // separately at projection; this list covers replacements the engine
    // never cancels. Optional so legacy durable events still decode (same
    // precedent as WorkflowCreated.directory); absent lists project nothing.
    superseded: Schema.optional(Schema.Array(NodeID)),
    recovery: Schema.optional(Schema.Struct({
      expectedGraphRev: NonNegativeInt,
      expectedSeq: NonNegativeInt,
      nodeSeqs: Schema.Array(Schema.Struct({ nodeID: NodeID, seq: NonNegativeInt })),
      resumeCancelled: Schema.Boolean,
    })),
    /** #945: a mid-run target change. Optional so legacy durable events
     * decode; absent means this replan did not retarget. */
    retarget: Schema.optional(Schema.Struct({
      fromDirectory: Schema.optional(Schema.String),
      toDirectory: Schema.optional(Schema.String),
      fromFingerprint: Schema.optional(TargetFingerprint),
      toFingerprint: Schema.optional(TargetFingerprint),
      reason: Schema.optional(Schema.String),
      nodes: Schema.Array(NodeID),
    })),
  },
})
export type WorkflowReplanned = typeof WorkflowReplanned.Type

export const WorkflowConfigUpdated = Event.define({
  type: "dag.workflow.config_updated",
  ...options,
  schema: {
    ...Base,
    config: Schema.String, // merged YAML/JSON string (single source of truth after replan)
  },
})
export type WorkflowConfigUpdated = typeof WorkflowConfigUpdated.Type

// ============================================================================
// Node lifecycle events
// ============================================================================

export const NodeRegistered = Event.define({
  type: "dag.node.registered",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    name: Schema.String,
    workerType: Schema.String,
    dependsOn: Schema.Array(NodeID),
    required: Schema.Boolean,
    model: Schema.optional(NodeModel),
  },
})
export type NodeRegistered = typeof NodeRegistered.Type

// Admission: the scheduler accepted the node into an execution attempt but it
// has not acquired an execution permit yet — no child session exists. The
// queued row carries no deadline: the execution budget starts at permit
// acquisition (nodeStarted), so queue wait does not count toward it.
export const NodeQueued = Event.define({
  type: "dag.node.queued",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    deadlineMs: Schema.optional(Schema.Number),
  },
})
export type NodeQueued = typeof NodeQueued.Type

export const NodeStarted = Event.define({
  type: "dag.node.started",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    childSessionID: SessionID,
    deadlineMs: Schema.optional(Schema.Number),
    wakeEligible: Schema.optional(Schema.Boolean),
    /** Execution directory for this attempt. Optional so legacy durable
     * events still decode; absent projects to NULL and reports no path. */
    directory: Schema.optional(Schema.String),
    /** Repo HEAD when the attempt started. Optional for the same reason as
     * `directory`; absent while the directory is not a git repository. */
    baseHead: Schema.optional(Schema.String),
    /** #944: target fingerprint captured before this attempt started, for
     * nodes that judge the working tree. Optional so legacy events decode. */
    targetFingerprint: Schema.optional(TargetFingerprint),
    /** #946: the per-node worktree this attempt runs in. Optional so legacy
     * events decode; `state: "active"` marks a live worktree. */
    worktree: Schema.optional(NodeWorktree),
  },
})
export type NodeStarted = typeof NodeStarted.Type

export const NodeCompleted = Event.define({
  type: "dag.node.completed",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    output: Schema.Unknown,
    capturedOutput: Schema.optional(Schema.Unknown),
    durationMs: NonNegativeInt,
    /** #944: target fingerprint recomputed at completion, for nodes that
     * recorded a start fingerprint. Optional so legacy events decode. */
    targetFingerprint: Schema.optional(TargetFingerprint),
    /** #944: true when the recomputed fingerprint differs from the start one.
     * When absent (legacy), consumers treat the result as not stale. */
    staleTarget: Schema.optional(Schema.Boolean),
    /** #946: paths this attempt changed. Optional so legacy events decode;
     * isolated nodes also carry the same list inside `worktree`. */
    touchedPaths: Schema.optional(Schema.Array(Schema.String)),
    /** #946: commit, patch and conflict evidence for an isolated node. */
    worktree: Schema.optional(NodeWorktree),
  },
})
export type NodeCompleted = typeof NodeCompleted.Type

export const NodeFailed = Event.define({
  type: "dag.node.failed",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    reason: Schema.String,
    trigger: Schema.Literals(["exec_failed", "push_exhausted", "verdict_fail", "timeout"]),
    /** Optional triage detail, e.g. schema_invalid for a malformed final
     * response. Optional keeps the durable event readable across versions:
     * older readers ignore it and fall back to trigger. */
    errorClass: Schema.optional(Schema.String),
    /** #946: an isolated attempt keeps its worktree for inspection. */
    worktree: Schema.optional(NodeWorktree),
  },
})
export type NodeFailed = typeof NodeFailed.Type

export const NodeSkipped = Event.define({
  type: "dag.node.skipped",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    reason: Schema.Literals(["condition_false", "agent_complete", "orphan_cascade", "workflow_cancelled", "workflow_failed"]),
  },
})
export type NodeSkipped = typeof NodeSkipped.Type

/** A node with an execution attempt was stopped by a workflow-level control.
 * Legacy rows terminated before this event existed remain `skipped`. */
export const NodeAborted = Event.define({
  type: "dag.node.aborted",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    reason: Schema.Literals(["agent_complete", "workflow_cancelled", "workflow_failed"]),
  },
})
export type NodeAborted = typeof NodeAborted.Type

export const NodeCancelled = Event.define({
  type: "dag.node.cancelled",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    /** Who cancelled the node: a replan fragment (the row leaves the current
     * graph revision) or an agent control call (the row stays in the current
     * revision and only its execution attempt ends). Optional so rows written
     * before #1030 keep decoding; an absent source is a replan cancellation,
     * the only producer at the time. */
    source: Schema.optional(Schema.Literals(["replan", "control"])),
    /** Optional audit text for a control cancellation. */
    reason: Schema.optional(Schema.String),
  },
})
export type NodeCancelled = typeof NodeCancelled.Type

export const NodeRestarted = Event.define({
  type: "dag.node.restarted",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    childSessionID: SessionID,
  },
})
export type NodeRestarted = typeof NodeRestarted.Type

// Timeout is a signal, not a failure: the node keeps running and the main
// agent is woken to adjudicate (extend via replan with a new timeout_ms, or
// cancel/replan). The node row stays RUNNING; only timeout_extensions counts.
export const NodeTimeoutEscalated = Event.define({
  type: "dag.node.timeout_escalated",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    childSessionID: SessionID,
    timeoutExtensions: Schema.Number, // current extension count (inclusive)
  },
})
export type NodeTimeoutEscalated = typeof NodeTimeoutEscalated.Type

// Adjudication of a timeout escalation: the main agent replanned with a new
// timeout_ms and nodeExtendTimeout persisted the recomputed absolute deadline
// (now + new timeout) as a durable event (ADR-0003). The old direct-write path
// (store.updateNodeDeadline) is abolished — the deadline now survives replay.
// The guard (status='running' + Q2 delivery gate) runs in the COMMAND layer
// before publish; this event is only appended on a successful extension, so it
// is the success log. The projector does a pure idempotent fold (single write
// authority, no event publish, no return-value contract).
export const NodeDeadlineExtended = Event.define({
  type: "dag.node.deadline_extended",
  ...options,
  schema: {
    ...Base,
    nodeID: NodeID,
    deadlineMs: Schema.Number, // absolute deadline (ms) recomputed at adjudication
    timeoutExtensions: Schema.Number, // extension count at adjudication moment (audit)
  },
})
export type NodeDeadlineExtended = typeof NodeDeadlineExtended.Type

// ============================================================================
// Inventories + tagged unions
// ============================================================================

export const DurableDefinitions = Event.inventory(
  WorkflowCreated,
  WorkflowStarted,
  WorkflowPaused,
  WorkflowResumed,
  WorkflowStepped,
  WorkflowCompleted,
  WorkflowFailed,
  WorkflowCancelled,
  WorkflowReplanned,
  WorkflowConfigUpdated,
  NodeRegistered,
  NodeQueued,
  NodeStarted,
  NodeCompleted,
  NodeFailed,
  NodeSkipped,
  NodeAborted,
  NodeCancelled,
  NodeRestarted,
  NodeTimeoutEscalated,
  NodeDeadlineExtended,
)

export const Definitions = DurableDefinitions

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
