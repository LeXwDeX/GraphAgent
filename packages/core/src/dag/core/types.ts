// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG scheduling core — status vocabulary, transition tables, and error types.
 *
 * Pure: zero Effect/DB/I/O imports. This is the single source of truth for the
 * iron-law state machine (validated transitions, terminal irreversibility)
 * that the runtime layer enforces around every status change. The literal
 * values themselves live in `@graphagent/schema/dag-status` (also pure), so
 * schema events and the TUI consume the same list.
 *
 * Ported from the dag-iron-laws branch's state-machine/{types,errors}.ts with
 * shadow-node / old-event-union / old-state.json cruft dropped (sub-DAG nesting
 * is deferred; EventV2 events are defined separately in schema/dag-event.ts;
 * read-model tables replace state.json).
 */

import {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  ERROR_CLASS_CANCELLED,
  NODE_TERMINAL_STATUS_VALUES,
  NODE_STATUS_VALUES,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  PAUSE_REASON_CHECKPOINT,
  WORKFLOW_TERMINAL_STATUS_VALUES,
  WORKFLOW_STATUS_VALUES,
  displayState,
  isActive,
  isSettled,
  isTerminal,
} from "@graphagent/schema/dag-status"
import type { DisplayState, PauseReason } from "@graphagent/schema/dag-status"

export {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  ERROR_CLASS_CANCELLED,
  NODE_TERMINAL_STATUS_VALUES,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  PAUSE_REASON_CHECKPOINT,
  WORKFLOW_TERMINAL_STATUS_VALUES,
  displayState,
  isActive,
  isSettled,
  isTerminal,
}
export type { DisplayState, PauseReason }

// ============================================================================
// Status vocabulary (derived from schema/dag-status — computed string enum
// members are not allowed by TypeScript, so the runtime objects are literal
// consts with a same-named union type)
// ============================================================================

export const WorkflowStatus = {
  PENDING: WORKFLOW_STATUS_VALUES[0],
  RUNNING: WORKFLOW_STATUS_VALUES[1],
  PAUSED: WORKFLOW_STATUS_VALUES[2],
  STEPPING: WORKFLOW_STATUS_VALUES[3],
  COMPLETED: WORKFLOW_STATUS_VALUES[4],
  FAILED: WORKFLOW_STATUS_VALUES[5],
  CANCELLED: WORKFLOW_STATUS_VALUES[6],
} as const
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus]

export const NodeStatus = {
  PENDING: NODE_STATUS_VALUES[0],
  QUEUED: NODE_STATUS_VALUES[1],
  RUNNING: NODE_STATUS_VALUES[2],
  COMPLETED: NODE_STATUS_VALUES[3],
  FAILED: NODE_STATUS_VALUES[4],
  ABORTED: NODE_STATUS_VALUES[5],
  SKIPPED: NODE_STATUS_VALUES[6],
} as const
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus]

/** Why a node entered FAILED — recorded for diagnostics and replan decisions. */
export enum FallbackTrigger {
  EXEC_FAILED = "exec_failed",
  PUSH_EXHAUSTED = "push_exhausted",
  VERDICT_FAIL = "verdict_fail",
  TIMEOUT = "timeout",
}

/** Why a node entered SKIPPED — distinguishes condition-skip from agent-abandon (D13). */
export enum SkipReason {
  /** Node's `condition` evaluated false. Non-violation even if required. */
  CONDITION_FALSE = "condition_false",
  /** Agent called `control(complete)` early; remaining nodes abandoned. Non-violation. */
  AGENT_COMPLETE = "agent_complete",
  /** An upstream dependency was cancelled/failed, cascading failure to this node. */
  ORPHAN_CASCADE = "orphan_cascade",
}

// ============================================================================
// Error codes + base error
// ============================================================================

export enum ErrorCode {
  INVALID_TRANSITION = "INVALID_TRANSITION",
  STALE_NODE_ATTEMPT = "STALE_NODE_ATTEMPT",
  TERMINAL_VIOLATION = "TERMINAL_VIOLATION",
  STATE_MACHINE_VIOLATION = "STATE_MACHINE_VIOLATION",
  EVENT_NOT_BROADCAST = "EVENT_NOT_BROADCAST",
  STATE_NOT_PERSISTED = "STATE_NOT_PERSISTED",
  MISSING_REQUIRED_NODE = "MISSING_REQUIRED_NODE",
  DUPLICATE_NODE_NAME = "DUPLICATE_NODE_NAME",
  DEPENDENCY_NOT_MET = "DEPENDENCY_NOT_MET",
}

export class DagCoreError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>
  readonly timestamp: Date

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = "DagCoreError"
    this.code = code
    this.context = context
    this.timestamp = new Date()
  }
}

export class InvalidTransitionError extends DagCoreError {
  constructor(entityId: string, fromStatus: string, toStatus: string) {
    super(
      ErrorCode.INVALID_TRANSITION,
      `Invalid transition: ${entityId} (${fromStatus} -> ${toStatus})`,
      { entityId, fromStatus, toStatus },
    )
    this.name = "InvalidTransitionError"
  }
}

export class TerminalViolationError extends DagCoreError {
  constructor(entityId: string, terminalStatus: string, attemptedStatus: string, reason?: string) {
    super(
      ErrorCode.TERMINAL_VIOLATION,
      `Cannot transition from terminal state: ${entityId} (${terminalStatus} -> ${attemptedStatus})${reason ? `: ${reason}` : ""}`,
      { entityId, terminalStatus, attemptedStatus, reason },
    )
    this.name = "TerminalViolationError"
  }
}

export class StaleNodeAttemptError extends DagCoreError {
  constructor(
    nodeId: string,
    expected: { replanAttempts: number; nodeSeq?: number; childSessionID?: string; graphRev?: number },
    actual: { replanAttempts: number; nodeSeq: number; childSessionID: string | null; graphRev: number },
  ) {
    super(ErrorCode.STALE_NODE_ATTEMPT, `Stale execution attempt rejected: ${nodeId}`, {
      nodeId,
      expected,
      actual,
    })
    this.name = "StaleNodeAttemptError"
  }
}

/** Returns true when a concurrent status change made the requested transition obsolete. */
export function isTransitionRejection(
  error: unknown,
): error is InvalidTransitionError | TerminalViolationError | StaleNodeAttemptError {
  return (
    error instanceof InvalidTransitionError ||
    error instanceof TerminalViolationError ||
    error instanceof StaleNodeAttemptError
  )
}

export class StateNotPersistedError extends DagCoreError {
  constructor(workflowId: string, reason?: string) {
    super(
      ErrorCode.STATE_NOT_PERSISTED,
      `Workflow state not persisted for ${workflowId}${reason ? `: ${reason}` : ""}`,
      { workflowId, reason },
    )
    this.name = "StateNotPersistedError"
  }
}

// ============================================================================
// Iron-law enforcement: terminal predicates + transition tables
// ============================================================================

/** Iron law #2: terminal statuses are irreversible. The value set is shared
 * with schema/dag-status so durable-row predicates cannot drift from the
 * schema literals. */
const WORKFLOW_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_TERMINAL_STATUS_VALUES)
const NODE_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(NODE_TERMINAL_STATUS_VALUES)

/** Terminal-status predicate for durable rows, whose status field is a string. */
export function isTerminalWorkflowStatusValue(status: string): boolean {
  return WORKFLOW_TERMINAL_STATUS_SET.has(status)
}

/** Iron law #2: terminal statuses are irreversible. */
export function isWorkflowTerminalStatus(status: WorkflowStatus): boolean {
  return isTerminalWorkflowStatusValue(status)
}

/** Iron law #2: terminal statuses are irreversible. */
export function isNodeTerminalStatus(status: NodeStatus): boolean {
  return NODE_TERMINAL_STATUS_SET.has(status)
}

/**
 * Iron law #1: state changes only through validated transitions.
 *
 * Returns the list of statuses the node MAY move to from its current one.
 * An empty array means the node is terminal (no further transitions) —
 * callers MUST treat attempts to transition further as TerminalViolationError.
 *
 * The `restart` path is running -> pending -> running: RUNNING admits PENDING
 * and all terminal states (COMPLETED/FAILED/ABORTED/SKIPPED) return [] —
 * restarts never originate from a terminal node; the projector's NodeRestarted
 * resets the row to PENDING. (Node-level PAUSED was removed in D11: no
 * NodePaused durable event exists and no projector path writes it.)
 */
export function getValidNextNodeStatuses(currentStatus: NodeStatus): NodeStatus[] {
  switch (currentStatus) {
    case NodeStatus.PENDING:
      return [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED]
    case NodeStatus.QUEUED:
      // QUEUED→QUEUED is idempotent re-admission after crash recovery;
      // QUEUED→PENDING is the replan-replacement reset; QUEUED→FAILED covers
      // the permit-wait timeout (the bounded scheduler wait expires while the
      // node is queued; no deadline is persisted).
      return [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.PENDING, NodeStatus.SKIPPED, NodeStatus.FAILED]
    case NodeStatus.RUNNING:
      return [NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.ABORTED, NodeStatus.PENDING, NodeStatus.SKIPPED]
    case NodeStatus.COMPLETED:
    case NodeStatus.FAILED:
    case NodeStatus.ABORTED:
    case NodeStatus.SKIPPED:
      return []
    default:
      return []
  }
}

/**
 * Iron law #1: state changes only through validated transitions.
 *
 * Returns the list of statuses the workflow MAY move to from its current one.
 * Terminal statuses admit nothing (D11 removed the legacy workflow-only
 * terminal status: no durable event ever produced it).
 */
export function getValidNextWorkflowStatuses(currentStatus: WorkflowStatus): WorkflowStatus[] {
  switch (currentStatus) {
    case WorkflowStatus.PENDING:
      return [WorkflowStatus.RUNNING]
    case WorkflowStatus.RUNNING:
      return [WorkflowStatus.PAUSED, WorkflowStatus.STEPPING, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]
    case WorkflowStatus.STEPPING:
      // STEPPING -> STEPPING is the consecutive single-step path: each step
      // command re-enters stepping to run exactly one more node.
      return [WorkflowStatus.RUNNING, WorkflowStatus.PAUSED, WorkflowStatus.STEPPING, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]
    case WorkflowStatus.PAUSED:
      return [WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED]
    case WorkflowStatus.COMPLETED:
    case WorkflowStatus.FAILED:
    case WorkflowStatus.CANCELLED:
      return []
    default:
      return []
  }
}

/**
 * Iron law #1 helper: assert a transition is legal, throwing if not.
 * Used by the runtime layer before persisting any status change.
 */
export function assertValidNodeTransition(nodeId: string, from: NodeStatus, to: NodeStatus): void {
  if (isNodeTerminalStatus(from)) {
    throw new TerminalViolationError(nodeId, from, to)
  }
  if (!getValidNextNodeStatuses(from).includes(to)) {
    throw new InvalidTransitionError(nodeId, from, to)
  }
}

export function assertValidWorkflowTransition(workflowId: string, from: WorkflowStatus, to: WorkflowStatus): void {
  if (getValidNextWorkflowStatuses(from).includes(to)) return
  if (isWorkflowTerminalStatus(from)) {
    throw new TerminalViolationError(workflowId, from, to)
  }
  throw new InvalidTransitionError(workflowId, from, to)
}
