// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopEntry from "./entry"

import { Cause, Effect, Exit } from "effect"
import type { Fiber, Semaphore } from "effect"
import type { DagLease } from "@graphagent/core/dag/lease"
import type { DagStore } from "@graphagent/core/dag/store"
import type { WorkflowRuntime } from "@graphagent/core/dag/core/scheduling"
import type { Dag, WorkflowConfig } from "../dag"

/** State the schema's enum values at the end of the output contract so the
 * runtime answer wins over conflicting verdict wording in the instruction. */
export function allowedVerdictHint(schema: Record<string, unknown>): string {
  const properties = schema.properties
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return ""
  const allowed = Object.entries(properties).flatMap(([field, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return []
    const values = (value as Record<string, unknown>).enum
    if (!Array.isArray(values) || !values.every((item) => typeof item === "string")) return []
    return [`${field} in ${JSON.stringify(values)}`]
  })
  return allowed.length === 0
    ? ""
    : ` Allowed values: ${allowed.join("; ")}. This output contract overrides any conflicting verdict wording in the instruction or objective.`
}

/** Explicit input text for a dependency that settled without output. */
export function settledWithoutOutputPlaceholder(node: DagStore.NodeRow | undefined) {
  if (node?.status === "failed") return `Dependency "${node.id}" failed: ${node.errorReason ?? "unknown error"}`
  if (node?.status === "skipped") return `Dependency "${node.id}" skipped: ${node.errorReason ?? "no output"}`
  if (node?.status === "aborted") return `Dependency "${node.id}" aborted`
  return undefined
}

export interface WorkflowEntry {
  /** ADR-0008: the runner lease this entry drives the workflow under. Renewed every period; losing it evicts the entry. */
  token: DagLease.Token
  /** ADR-0008 decision 5: `Dag` with this entry's runner writes bound to `token`. The entry's runner writes go through it. */
  port: Dag.Interface
  runtime: WorkflowRuntime
  /** Per-workflow child-run cap, enforced by the process-level scheduler. */
  concurrency: number
  evalLock: Semaphore.Semaphore
  parentSessionID: string
  config: WorkflowConfig | undefined
  /** #943: bound workspace where children run; undefined means the owner directory. */
  executionDirectory?: string
  /** Durable graph revision paired with config and the scheduling runtime. */
  graphRev: number
  fibers: Map<string, Fiber.Fiber<unknown, unknown>>
  watchers: Map<string, Fiber.Fiber<unknown, unknown>>
  /** ADR-0008: the child session each fiber of `fibers` drives, recorded by its own attempt where the fiber is registered. Eviction cancels these (`RunnerLease.Evictable`). */
  attemptChild: WeakMap<Fiber.Fiber<unknown, unknown>, () => string | undefined>
  /** Accepted messages preserve an existing running attempt through recovery. */
  messageContinuations: Set<string>
  /** DAG-03/F2: a replan-verdict veto whose durable pause could not be
   * persisted. While set, the in-memory paused flag survives the durable-row
   * re-syncs performed by node terminal events and refreshControlFlags, so
   * no stimulus spawns the vetoed direction before the parent acts. Released
   * by the parent's explicit control events — replan and step are reachable
   * from every hold state; resume only when the durable row is not running
   * (paused/stepping — a held row reads "running" and resume is an invalid
   * transition there until a durable pause lands; control(replan) is the
   * disposition the verdict asked for). This is only the process-local
   * fallback: restart reconstruction re-evaluates the durable checkpoint and
   * its later control-event sequence before scheduling or completion. */
  vetoHold: boolean
}

// Subscription handlers must never die. dag.ts guards and checkCompletion
// use orDie, whose defects punch straight through Effect.ignore (it only
// absorbs the error channel) and would kill the forked runForEach fiber —
// leaving that event type permanently unhandled for the rest of the
// process. catchCause absorbs failures AND defects at the boundary.
export const guarded =
  (event: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.catchCause((cause) => Effect.logWarning("DagLoop handler failed", { event, cause })))

// Node-terminal handlers fork the parent wake drain after their
// evalLock body even when that body fails or dies (e.g. a rejected
// workflow transition): the durable node row is already terminal and
// unreported, so the parent must still be woken. Interruption (scope
// teardown) skips the fork. `nudge` is the instance's: the trigger of the
// parent session's delivery.
export const makeForkWakeAfter =
  (nudge: (sessionID: string) => Effect.Effect<void>) =>
  (sessionID: string) =>
  <A, E>(exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : nudge(sessionID)
