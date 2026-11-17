// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ReconcileDecide from "./reconcile-decide"

import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"

/**
 * The reconciler's judgment (Issue #1029, ADR-0008 decision 6): one pure function
 * from what the shell observed about a workflow to the one action it takes.
 * `decide` reads nothing and writes nothing, so every row of the truth table is a
 * plain unit test, and a new policy is a new row here, not a new recovery path.
 * The shell (`reconciler.ts`) makes the observation, runs the action and
 * single-flights the evaluation.
 *
 * The first matching row wins:
 *
 *   1.  the workflow is terminal or gone                         -> noop
 *   2.  this instance's directory does not own it                -> evict (not-owned) if there is an entry, else noop
 *   3.  an entry, and the lease row no longer names its token    -> evict (lease-lost)
 *   4.  the location is unusable, no other runner holds it live  -> fail-unrecoverable
 *   5.  another runner holds a live lease                        -> defer
 *   6.  an entry (its lease is held)                             -> renew
 *   7.  another runner's lease expired, and this round or the
 *       previous one follows a clock jump                        -> defer (no preemption)
 *   8.  pending, every node pending, past the grace period       -> terminalize-orphan
 *   9.  pending otherwise                                        -> defer
 *   10. otherwise: no lease row, another runner's expired row,
 *       or a row that names this runner while there is no entry  -> adopt
 *
 * Why the order is the order: a workflow nobody can act on ends the evaluation
 * first (1, 2); an entry whose lease is gone must stop before anything else is
 * judged (3); an unusable location is a durable fact that needs no lease, unless
 * somebody live drives the workflow (4, 5); a live lease is never judged or
 * claimed (5); the clock rule only holds back a takeover from another runner,
 * never a claim of a workflow that has no lease row, which takes nothing from
 * anyone (7, 10).
 */

/**
 * How long a `pending` workflow whose nodes are all still `pending` is left
 * alone before it is terminalized as an orphan. `Dag.create` commits the
 * workflow, its nodes and `WorkflowStarted` in one transaction, so a `pending`
 * row only comes from an older version; the grace period is the margin for a
 * writer that is still at it, measured by the reconciler's clock against
 * `workflow.time_created`.
 */
export const ORPHAN_PENDING_GRACE_MS = 60_000

/** What the lease row says, as seen from this runner. */
export type LeaseView =
  /** No row: nobody claimed the workflow (or it is gone or terminal, which `DagLease.held` reports the same way). */
  | "none"
  /** The row names this runner, whether or not the instance has an entry. */
  | "mine"
  /** The row names another runner and has not expired. */
  | "other-live"
  /** The row names another runner and `expires_at <= now`. */
  | "other-expired"

/** A plain record of what the shell found; `decide` is a function of this and nothing else. */
export interface Observation {
  /** The durable status of the workflow row, or `"gone"` when there is none. */
  readonly status: string
  /** Only read for a `pending` workflow: every node of it is still `pending` (vacuously true for none). */
  readonly allNodesPending: boolean
  /** Only read for a `pending` workflow: milliseconds since its row was created, by the reconciler's clock. */
  readonly ageMs: number
  /** Whether this instance's directory owns the workflow. */
  readonly owned: boolean
  /** The verdict of `DagLocation.resolveExecution` on the durable execution location. */
  readonly location: "ok" | "unusable"
  readonly lease: LeaseView
  /** Whether this instance has a runtime entry for the workflow. */
  readonly hasEntry: boolean
  /** Only read when there is an entry: the lease row still names the entry's token. */
  readonly entryTokenHeld: boolean
  /** This round or the previous one follows a clock jump (`clockJumped`, measured by the renewal tick). */
  readonly afterClockJump: boolean
}

export type EvictReason = "not-owned" | "lease-lost"

export type DeferReason = "other-live" | "clock-jump" | "pending"

export type Action =
  | { readonly _tag: "noop" }
  | { readonly _tag: "evict"; readonly reason: EvictReason }
  | { readonly _tag: "fail-unrecoverable" }
  | { readonly _tag: "defer"; readonly reason: DeferReason }
  | { readonly _tag: "renew" }
  | { readonly _tag: "terminalize-orphan" }
  | { readonly _tag: "adopt" }

const NOOP: Action = { _tag: "noop" }
const RENEW: Action = { _tag: "renew" }
const ADOPT: Action = { _tag: "adopt" }
const FAIL_UNRECOVERABLE: Action = { _tag: "fail-unrecoverable" }
const TERMINALIZE_ORPHAN: Action = { _tag: "terminalize-orphan" }
const EVICT_NOT_OWNED: Action = { _tag: "evict", reason: "not-owned" }
const EVICT_LEASE_LOST: Action = { _tag: "evict", reason: "lease-lost" }
const DEFER_OTHER_LIVE: Action = { _tag: "defer", reason: "other-live" }
const DEFER_CLOCK_JUMP: Action = { _tag: "defer", reason: "clock-jump" }
const DEFER_PENDING: Action = { _tag: "defer", reason: "pending" }

/** The truth table of ADR-0008 decision 6, first matching row wins. */
export const decide = (o: Observation): Action => {
  if (o.status === "gone" || isTerminalWorkflowStatusValue(o.status)) return NOOP
  if (!o.owned) return o.hasEntry ? EVICT_NOT_OWNED : NOOP
  if (o.hasEntry && !o.entryTokenHeld) return EVICT_LEASE_LOST
  if (o.location === "unusable" && o.lease !== "other-live") return FAIL_UNRECOVERABLE
  if (o.lease === "other-live") return DEFER_OTHER_LIVE
  if (o.hasEntry) return RENEW
  if (o.lease === "other-expired" && o.afterClockJump) return DEFER_CLOCK_JUMP
  if (o.status === "pending")
    return o.allNodesPending && o.ageMs >= ORPHAN_PENDING_GRACE_MS ? TERMINALIZE_ORPHAN : DEFER_PENDING
  return ADOPT
}

/**
 * The lease row as `DagLease.held` reports it, judged against `runnerID` and
 * `now`. The expiry test is the one `DagLease.claim` makes (`expires_at <= now`),
 * so "other-expired" is exactly the row that a claim at `now` would take over.
 */
export const classifyLease = (
  lease: { readonly runnerID: string; readonly epoch: number; readonly expiresAt: number } | undefined,
  runnerID: string,
  now: number,
): LeaseView => {
  if (lease === undefined) return "none"
  if (lease.runnerID === runnerID) return "mine"
  return lease.expiresAt <= now ? "other-expired" : "other-live"
}

/**
 * ADR-0008 decision 2: whether two successive readings of the wall clock by one
 * reconciler are more than two periods apart. A tick every period is the norm,
 * so a longer gap means that the machine slept or the process stalled, and
 * everything on the machine saw the same jump: an expired lease seen right
 * after it is evidence of the stall, not of a dead owner. No earlier reading,
 * or exactly two periods, is not a jump.
 */
export const clockJumped = (previousAt: number | undefined, at: number, periodMs: number): boolean =>
  previousAt !== undefined && at - previousAt > 2 * periodMs
