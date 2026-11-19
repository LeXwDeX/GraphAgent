// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagCommandCore from "./command-core"

import { Effect, Option } from "effect"
import type { Cause, Context } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagStore } from "@graphagent/core/dag/store"
import type { DagMessages } from "@graphagent/core/dag/messages"
import { DagTransact } from "@graphagent/core/dag/transact"
import type { EventV2Bridge } from "@/event-v2-bridge"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import {
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
  InvalidTransitionError,
  StaleNodeAttemptError,
  TerminalViolationError,
} from "@graphagent/core/dag/core/types"
import type { WorkflowStatus, NodeStatus } from "@graphagent/core/dag/core/types"
import type { NodeExecutionAttempt } from "./dag"

// Re-export domain types
export const ID = DagEvent.DagID
export type ID = typeof ID.Type
export const NodeID = DagEvent.NodeID
export type NodeID = typeof NodeID.Type

/**
 * The user's node ceiling while `dag.max_total_nodes` is unset (Issue #1031 M4,
 * #1290). It belongs to the user cap, not to a workflow: a workflow declares its
 * own `max_total_nodes` (or none) and the effective ceiling is the lower of that
 * and this cap (`DagValidation.effectiveMaxTotalNodes`). Validation, the mode
 * announcement and the status read all fall back to this one value.
 */
export const DEFAULT_USER_MAX_TOTAL_NODES = 100

/**
 * The user's global node ceiling (`dag.max_total_nodes`, Issue #1031 M4), read
 * from the global config layer when the caller's environment provides one. The
 * mode announcement and the scheduler read the same key, so a workflow sees one
 * ceiling everywhere. Direct service callers and unit harnesses without Config
 * keep the documented default (`DEFAULT_USER_MAX_TOTAL_NODES`).
 */
export const readUserMaxTotalNodes = Effect.fn("Dag.readUserMaxTotalNodes")(function* () {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(config)) return undefined
  const dag = yield* config.value.dagGlobal()
  return dag.max_total_nodes
})

// Cap on workflow-lock acquisition + critical section (ADR-0004). The critical
// section is a synchronous DB write, so exceeding this means the workflow is
// already broken — interrupt loudly via Effect's builtin TimeoutException. The
// critical section must never await async work; that is the only way this bound
// can fire.
export const WORKFLOW_LOCK_TIMEOUT = "30 seconds" as const

// The per-workflow KeyedMutex is single-permit and NOT reentrant: a guarded
// command invoked without the lock races its status guards, and one invoked
// while the lock is already held deadlocks silently (the permit never frees).
// The witness turns that convention into a type — only withWorkflowLock mints
// a WorkflowLock, so every guarded command below carries compile-time proof
// that it runs inside the lock's critical section. Internal composition
// (extend → replan → nodeFailed) forwards the caller's witness instead of
// re-acquiring the lock.
declare const WorkflowLockHeld: unique symbol
export type WorkflowLock = { readonly [WorkflowLockHeld]: true }

/** What the layer reads from the services: the inputs of every helper below. */
export interface Environment {
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly store: DagStore.Interface
  readonly mailboxService: Option.Option<DagMessages.Interface>
  readonly transactService: DagTransact.Interface
}

/** What the command modules receive: the services plus the lock, transaction and guard helpers built over them. */
export interface Core extends Pick<Environment, "events" | "store" | "mailboxService"> {
  readonly withMailbox: <A, E, R>(
    dagID: string,
    reason: string | undefined | ((result: A) => string | undefined),
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly withWorkflowLock: (
    dagID: string,
  ) => <A, E, R>(body: (lock: WorkflowLock) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | Cause.TimeoutError, R>
  readonly transact: <A, E, R>(
    dagID: string,
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DagTransact.StaleRunnerError, R>
  readonly command: (
    dagID: string,
  ) => <A, E, R>(
    body: (lock: WorkflowLock) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DagTransact.StaleRunnerError | Cause.TimeoutError, R>
  readonly exclusive: <A, E, R>(dagID: string, body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly guardWorkflow: (
    dagID: string,
    target: WorkflowStatus,
  ) => Effect.Effect<DagStore.WorkflowRow, Error | InvalidTransitionError>
  readonly guardWorkflowNotTerminal: (
    dagID: string,
    attemptedStatus: string,
  ) => Effect.Effect<DagStore.WorkflowRow, Error | TerminalViolationError>
  readonly guardNodeAttempt: (
    node: DagStore.NodeRow,
    graphRev: number,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<void, StaleNodeAttemptError>
  readonly guardNode: (
    dagID: string,
    nodeID: string,
    target: NodeStatus,
    attempt?: NodeExecutionAttempt,
  ) => Effect.Effect<DagStore.NodeRow, Error | TerminalViolationError | InvalidTransitionError | StaleNodeAttemptError>
}

/**
 * Builds the shared command helpers once per layer build. `workflowLocks` is
 * created here, so every module of one layer must receive this one `Core`:
 * a second `make` would give a second lock table and the per-workflow
 * mutual exclusion would no longer hold.
 */
export const make = (environment: Environment) =>
  Effect.gen(function* () {
    const { events, store, mailboxService, transactService } = environment
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
    // ADR-0008 decision 3: the guard and the publish of a write run in ONE
    // IMMEDIATE transaction (`DagTransact`, a required service), so nothing can
    // change the workflow between them.
    //
    // A runner write carries its lease token (ADR-0008 decision 4): the runner
    // port provides it around the call (`DagTransact.Fence`) and `underFence`
    // hands it to the transaction's fence. An intent write finds none.
    const transact = <A, E, R>(
      dagID: string,
      body: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | DagTransact.StaleRunnerError, R> => DagTransact.underFence(transactService, dagID, body)
    // A command that changes workflow state: the in-process lock queues it, then
    // one transaction carries its guard and its publish.
    const command =
      (dagID: string) =>
      <A, E, R>(body: (lock: WorkflowLock) => Effect.Effect<A, E, R>) =>
        withWorkflowLock(dagID)((lock) => transact(dagID, body(lock)))
    // The witness convention exists to type-proof internal guarded calls;
    // external critical sections (worktree settlement) cannot hold a witness,
    // so the timeout is folded into a defect here instead.
    const exclusive = <A, E, R>(dagID: string, body: Effect.Effect<A, E, R>) =>
      withWorkflowLock(dagID)(() => body).pipe(
        Effect.catchTag("TimeoutError", (error) => Effect.die(error)),
      )

    const guardWorkflow = Effect.fn("Dag.guardWorkflow")(function* (dagID: string, target: WorkflowStatus) {
      const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const current = wf.status as WorkflowStatus
      if (!getValidNextWorkflowStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(dagID, current, target))
      }
      return wf
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

    return {
      events,
      store,
      mailboxService,
      withMailbox,
      withWorkflowLock,
      transact,
      command,
      exclusive,
      guardWorkflow,
      guardWorkflowNotTerminal,
      guardNodeAttempt,
      guardNode,
    } satisfies Core
  })
