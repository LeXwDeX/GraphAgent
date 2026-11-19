// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as Dag from "./dag"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagTransact } from "@graphagent/core/dag/transact"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import type { PauseReason } from "@graphagent/core/dag/core/types"
import { AdmissionRecord, ExecutionMode } from "./admission"
import type { AcceptanceItem, PriorFinding, ReviewGate, WorkflowBlockKind } from "./blocks"
import { DagCommandCore, ID } from "./command-core"
import { DagNodeTimeout } from "./node-timeout"
import { DagWorkflowPause } from "./workflow-pause"
import { DagWorkflowTerminal } from "./workflow-terminal"
import { DagGraphMutation } from "./graph-mutation"
import { DagNodeEvents } from "./node-events"
import { DagWorkflowRecover } from "./workflow-recover"
import { DagWorkflowCreate } from "./workflow-create"
import type { RecoveryPlan } from "./recovery-plan"

export { StructuralValidationError } from "./validation"
export { DEFAULT_WORKFLOW_CONFIG, computeMergedConfig, normalizeModel, parseWorkflowConfig } from "./workflow-config"
export { CompletionGateError, ReviewGateError, requiredCompletionGaps } from "./completion-gate"
export { DEFAULT_USER_MAX_TOTAL_NODES, ID, NodeID, WORKFLOW_LOCK_TIMEOUT } from "./command-core"
export { StaleMessageInputError, isStaleMessageInput } from "./node-events"

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
    /** The config was compiled from blocks in this request, so the compiler
     * owns `skip_ok` on its review decisions and the standard review-coverage
     * advisory leaves it out. The strict re-check is unchanged. */
    blockCompiled?: boolean
  }) => Effect.Effect<ID, Error>
  readonly store: DagStore.Interface
  readonly pause: (dagID: string, reason?: PauseReason) => Effect.Effect<void, Error>
  readonly pauseForCheckpoint: (
    dagID: string,
    checkpointSeq: number,
  ) => Effect.Effect<"paused" | "acknowledged" | "inactive", Error>
  /**
   * D12 budget exhaustion: pause a live workflow with reason
   * `budget_exhausted` and immediately fail every in-flight attempt
   * (`running`/`queued`) with error_class `budget_exhausted`. Idempotent: a
   * workflow already paused for budget only has its remaining in-flight
   * attempts failed; any other state is left untouched (`ignored`).
   */
  readonly pauseForBudget: (dagID: string) => Effect.Effect<"paused" | "ignored", Error>
  /**
   * #1289: the owner session was archived. A `running` or `stepping` workflow
   * is paused with reason `archived` (`paused`); a workflow that is already
   * paused, whatever its reason, keeps its pause and only the reason becomes
   * `archived` (`relabeled`). A terminal, `pending` or missing workflow, and one
   * already held for the archive, is left untouched (`ignored`). In-flight
   * nodes are not cancelled: this is the same pause a control request makes,
   * and archiving is reversible where cancelling is not. Relabeling a budget
   * pause also requeues the nodes the budget cancelled, as the budget's own
   * resume would have (it no longer sees the workflow), so a later resume reruns
   * them. An intent write, like `pauseForBudget`: no lease token, and a user
   * action that has to take effect whichever process drives the workflow.
   */
  readonly pauseForArchive: (dagID: string) => Effect.Effect<"paused" | "relabeled" | "ignored", Error>
  /**
   * D12 requeue primitive: return budget-cancelled nodes of a budget-paused
   * workflow to `pending` for a fresh attempt. It consumes no replan count and
   * only touches rows failed with error_class `budget_exhausted`.
   */
  readonly requeueNodes: (
    dagID: string,
    nodeIDs: readonly string[],
    reason: string,
  ) => Effect.Effect<{ readonly requeued: readonly string[] }, Error>
  readonly resume: (dagID: string) => Effect.Effect<void, Error>
  /**
   * #1289: the automatic resume of one pause episode (`DagBudget`'s own, held
   * for `budget_exhausted`). It lifts the pause only while the workflow is
   * still paused for `reason`, checked under the workflow lock and again inside
   * the transaction that publishes `WorkflowResumed`: a pause the owner's
   * archive relabeled in between (or a workflow someone else already resumed or
   * ended) is left alone and reported as `skipped`, not as an error. A resume
   * that goes ahead consults the `ResumeGuard` like `resume`. The explicit
   * `resume` is unchanged and lifts any pause, an archive's included: that is
   * the main agent's decision.
   */
  readonly resumeIfPausedFor: (dagID: string, reason: PauseReason) => Effect.Effect<"resumed" | "skipped", Error>
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
   * Terminalize an orphan `pending` workflow (ADR-0008 Amendment 3, 4b-C): the
   * legal pending -> running -> failed sequence in ONE transaction, a runner
   * write that carries the lease token like `fail`. The projector accepts
   * `WorkflowFailed` only from running or stepping, so `WorkflowStarted` has
   * to land first; in one transaction nothing can observe the `running` midpoint
   * and a refused fence leaves neither event. Failed, not cancelled (an
   * interrupted create), with `reason` in the durable event. Rejects a workflow
   * that is not `pending`: this is not `failUnrecoverable`.
   */
  readonly failOrphan: (dagID: string, reason: string) => Effect.Effect<void, Error>
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
  /** #1030 D9-g: run an external workflow-scoped critical section — workflow
   * worktree settlement — under the same per-workflow mutex that serializes
   * recovery and every guarded command. The body must not call a guarded Dag
   * command (the mutex is not reentrant); a lock timeout surfaces as a defect
   * because a stuck holder already means the workflow is broken. */
  readonly exclusive: <A, E, R>(dagID: string, body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly replan: (
    dagID: string,
    /** `blockCompiled`: the fragment was compiled from blocks (see `create`). */
    fragment: { nodes: NodeConfig[]; blockCompiled?: boolean },
  ) => Effect.Effect<{ cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] }, Error>
  readonly extend: (
    dagID: string,
    nodes: NodeConfig[],
    /** Runtime-initiated extends (fan-out) apply only while this pending node
     * still matches the scheduling attempt that planned them. */
    fence?: { nodeID: string; attempt: NodeExecutionAttempt },
    /** `blockCompiled`: the fragment was compiled from blocks (see `create`). */
    options?: { blockCompiled?: boolean },
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
  readonly nodeCancelled: (dagID: string, nodeID: string, reason?: string) => Effect.Effect<void, Error>
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

export class Service extends Context.Service<Service, Interface>()("@graphagent/Dag") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const mailboxService = yield* Effect.serviceOption(DagMessages.Service)
    const transactService = yield* DagTransact.Service
    const core = yield* DagCommandCore.make({ events, store, mailboxService, transactService })
    const { withMailbox, withWorkflowLock, command, exclusive } = core

    const { create } = yield* DagWorkflowCreate.make(core)

    const {
      pause,
      pauseForCheckpoint,
      resume,
      guardedResume,
      guardedResumeIfPausedFor,
      guardedStep,
      pauseForBudget,
      requeueNodes,
      pauseForArchive,
    } = yield* DagWorkflowPause.make(core)

    const { cancel, complete, fail, failOrphan, failUnrecoverable, settleCompletion } =
      yield* DagWorkflowTerminal.make(core, { resume })

    const { _replan, _extend } = yield* DagGraphMutation.make(core)

    const { recover, retarget } = yield* DagWorkflowRecover.make(core)

    const {
      nodeQueued,
      nodeStarted,
      nodeCompleted,
      nodeFailed,
      nodeSkipped,
      nodeCancelled,
      nodeRestarted,
    } = yield* DagNodeEvents.make(core)
    const { nodeTimeoutEscalated, nodeExtendTimeout, extendTimeout } = yield* DagNodeTimeout.make(core)

    return Service.of({
      create,
      store,
      pause: (dagID, reason) => command(dagID)((lock) => pause(lock, dagID, reason)),
      pauseForBudget: (dagID) => command(dagID)((lock) => pauseForBudget(lock, dagID)),
      pauseForArchive: (dagID) => command(dagID)((lock) => pauseForArchive(lock, dagID)),
      requeueNodes: (dagID, nodeIDs, reason) => command(dagID)((lock) => requeueNodes(lock, dagID, nodeIDs, reason)),
      pauseForCheckpoint: (dagID, checkpointSeq) =>
        command(dagID)((lock) => pauseForCheckpoint(lock, dagID, checkpointSeq)),
      resume: guardedResume,
      resumeIfPausedFor: guardedResumeIfPausedFor,
      step: guardedStep,
      cancel: (dagID) => command(dagID)((lock) => withMailbox(dagID, "cancelled", cancel(lock, dagID))),
      complete: (dagID, options) =>
        command(dagID)((lock) => withMailbox(dagID, "completed", complete(lock, dagID, options))),
      fail: (dagID, reason) => command(dagID)((lock) => withMailbox(dagID, "failed", fail(lock, dagID, reason))),
      failOrphan: (dagID, reason) =>
        command(dagID)((lock) => withMailbox(dagID, "failed", failOrphan(lock, dagID, reason))),
      failUnrecoverable: (dagID, reason) =>
        command(dagID)((lock) =>
          withMailbox(
            dagID,
            DagWorkflowTerminal.failUnrecoverableMailboxReason,
            failUnrecoverable(lock, dagID, reason),
          ),
        ),
      settleCompletion: (dagID, options) => command(dagID)((lock) => settleCompletion(lock, dagID, options)),
      exclusive,
      replan: (dagID, fragment) =>
        command(dagID)((lock) => withMailbox(dagID, undefined, _replan(lock, dagID, fragment))),
      extend: (dagID, nodes, fence, options) =>
        command(dagID)((lock) => withMailbox(dagID, undefined, _extend(lock, dagID, nodes, fence, options))),
      recover,
      retarget,
      nodeQueued: (dagID, nodeID, deadlineMs, attempt) =>
        command(dagID)((lock) => nodeQueued(lock, dagID, nodeID, deadlineMs, attempt)),
      nodeStarted: (dagID, nodeID, childSessionID, deadlineMs, wakeEligible, attempt, directory, baseHead, targetFingerprint, worktree) =>
        command(dagID)((lock) =>
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
        command(dagID)((lock) => withMailbox(dagID, undefined, nodeSkipped(lock, dagID, nodeID, reason, attempt))),
      nodeCancelled: (dagID, nodeID, reason) =>
        command(dagID)((lock) => withMailbox(dagID, undefined, nodeCancelled(lock, dagID, nodeID, reason))),
      nodeRestarted: (dagID, nodeID, childSessionID) =>
        command(dagID)((lock) => withMailbox(dagID, undefined, nodeRestarted(lock, dagID, nodeID, childSessionID))),
      nodeTimeoutEscalated: (dagID, nodeID, childSessionID, timeoutExtensions, staleDeadlineMs, attempt) =>
        command(dagID)((lock) =>
          nodeTimeoutEscalated(lock, dagID, nodeID, childSessionID, timeoutExtensions, staleDeadlineMs, attempt),
        ),
      nodeExtendTimeout: (dagID, nodeID, newDeadlineMs, attempt) =>
        command(dagID)((lock) => nodeExtendTimeout(lock, dagID, nodeID, newDeadlineMs, attempt)),
      extendTimeout: (dagID, nodeID, timeoutMs) =>
        command(dagID)((lock) => extendTimeout(lock, dagID, nodeID, timeoutMs)),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagProjector.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(DagTransact.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  DagStore.node,
  DagProjector.node,
  DagMessages.node,
  DagTransact.node,
])
