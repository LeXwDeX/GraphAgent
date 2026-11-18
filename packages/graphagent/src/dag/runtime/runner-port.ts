// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as RunnerPort from "./runner-port"

import { Effect } from "effect"
import { InvalidTransitionError } from "@graphagent/core/dag/core/types"
import type { DagLease } from "@graphagent/core/dag/lease"
import { DagTransact } from "@graphagent/core/dag/transact"
import type { Dag } from "../dag"

/**
 * The runner port (Issue #1029, ADR-0008 decisions 4 and 5): the one way runtime
 * code makes a **runner write**, a `Dag` command whose decision rests on the
 * runner's own scheduling state (its runtime entry, a watcher, a child it
 * started, or the node-level reconciliation after a claim).
 *
 * `make` binds the lease token of a runtime entry to every runner write, so a
 * call site that holds the port cannot leave the token out: each command in
 * `COMMANDS` runs with `DagTransact.Fence` provided, and the transaction's fence
 * step refuses it when the lease no longer names the token. Everything else on
 * the port is the `Dag` service itself, unchanged: reads, and the writes that
 * carry no token (intent writes, `failUnrecoverable`, which rests on the row's
 * execution location alone). Runtime code receives the port as its `Dag.Service`
 * (`Effect.provideService(Dag.Service, port)`), which is how `spawn.ts` and
 * `recovery.ts` write under the token without a line about it.
 *
 * The port is the only place that handles `StaleRunnerError`, and it never lets
 * it through. A refused write means the runner no longer owns the workflow, so
 * it first starts what the runner does about that (`lost`: evict the workflow,
 * ADR-0008 decision 2) and then fails the call with a transition rejection, the
 * failure every call site already treats as "a concurrent change made this write
 * obsolete". It is deliberately not `StaleRunnerError`, which `isTransitionRejection`
 * does not cover: a caller that carried on regardless would keep scheduling, and
 * one that turns an error it does not recognise into `nodeFailed(exec_failed)`
 * (the fan-out expansion does) would publish a failure for work that is not its
 * to fail. A refused write leaves nothing in the log: the transaction rolled back.
 *
 * Classification of the `Dag` commands (ADR-0008 decision 4), by the origin of
 * the decision, not the name of the command:
 *   - runner writes, on the port: `COMMANDS`;
 *   - intent writes (a user, an agent or a policy asked), no token: everything
 *     `DagControl` applies (`pause`, `resume`, `step`, `cancel`, `complete`,
 *     `nodeCancelled`, `replan`, `extend`, `recover`, `extendTimeout`,
 *     `retarget`), `create`, `cancel` on session removal, and `DagBudget`
 *     (`pauseForBudget`, `requeueNodes`, `resume`);
 *   - durable-fact writes, no token: `failUnrecoverable`; and the writes of the
 *     host sweep, which holds no lease.
 * `pause` and `extend` appear in both lists: the runner's own use of them (the
 * recovery pause, fan-out planning) goes through the port, a user's does not.
 * `fail` has only runner callers (`orchestrator_unresponsive`), and so has
 * `failOrphan`, the orphan `pending` workflow's terminalization: pending ->
 * running -> failed in one fenced transaction, the command that replaced the bare
 * `WorkflowStarted` the reconciler used to publish ahead of `fail`.
 */

/**
 * The `Dag` commands the runtime issues as runner writes. Checked against the
 * service's interface, so a command that is renamed or removed breaks the build
 * here instead of dropping out of the fence unnoticed.
 */
export const COMMANDS = [
  "nodeQueued",
  "nodeStarted",
  "nodeCompleted",
  "nodeFailed",
  "nodeSkipped",
  "nodeTimeoutEscalated",
  "nodeExtendTimeout",
  "settleCompletion",
  "extend",
  "pause",
  "pauseForCheckpoint",
  "fail",
  "failOrphan",
] as const satisfies ReadonlyArray<keyof Dag.Interface>

const COMMAND_SET: ReadonlySet<string | symbol> = new Set(COMMANDS)

export interface Input {
  /** The service the port writes through. */
  readonly dag: Dag.Interface
  /** The lease token of the runtime entry the port belongs to. */
  readonly token: DagLease.Token
  /**
   * What the runner does when its token is refused: it no longer drives the
   * workflow, so it drops it (ADR-0008 decision 2). Started before the failing
   * call returns, and it must not wait for the entry's fibers or its evaluation
   * lock: the refused write may be made by a fiber the eviction interrupts, or
   * under the lock it takes.
   */
  readonly lost: Effect.Effect<void>
}

const isRefused = (error: unknown): error is DagTransact.StaleRunnerError =>
  error instanceof DagTransact.StaleRunnerError

/** What a caller sees of a refused write: an existing transition rejection, never the fence's own error. */
const rejection = (error: DagTransact.StaleRunnerError) =>
  new InvalidTransitionError(
    error.dagID,
    `lease of runner ${error.runnerID} (epoch ${error.epoch}) lost`,
    "runner write",
  )

/** The `Dag` service with its runner writes bound to `input.token`. */
export const make = (input: Input): Dag.Interface => {
  const bound =
    (run: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>) =>
    (...args: ReadonlyArray<unknown>) =>
      run(...args).pipe(
        Effect.provideService(DagTransact.Fence, input.token),
        Effect.catchIf(isRefused, (error) => input.lost.pipe(Effect.andThen(Effect.fail(rejection(error))))),
      )
  return new Proxy(input.dag, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (!COMMAND_SET.has(property) || typeof value !== "function") return value
      return bound((...args) => Reflect.apply(value, target, args))
    },
  })
}
