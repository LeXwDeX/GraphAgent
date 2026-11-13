// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Deferred, Effect } from "effect"
import { EngineProcess, type ActiveChildRun, type ChildReport, type IssuedCredential } from "../engine-process"
import type { ChildCancelBy, ChildOwner, ChildPermissionPolicy, ChildRunCredential, ChildRunOutcome } from "./types"

/**
 * Zero-dependency access to the active child runs of this process (Issue
 * #1026, PR1). The state itself is `EngineProcess.children`; this module is the
 * only writer of an entry's phase and the access point later admission and loop
 * code reads (`activeFor`, `credentialOf`) without importing the run factory.
 *
 * Every mutation is synchronous, so a decision taken here (who ended a run
 * first, whether a child session already has an active run) cannot interleave
 * with another fiber. The durable rows follow the registry, never the other
 * way round, within one process; across processes the partial unique index
 * `child_run_active` is the backstop.
 */

const registry = EngineProcess.children

/** The one place a credential is issued: with the run it belongs to, by nothing else. */
function issue(runID: string, childSessionID: ActiveChildRun["childSessionID"]): IssuedCredential {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the brand has no runtime value: issuing is the cast
  return { runID, childSessionID, revoked: false } as IssuedCredential
}

export function create(input: {
  readonly id: string
  readonly childSessionID: ActiveChildRun["childSessionID"]
  readonly parentSessionID: ActiveChildRun["parentSessionID"]
  readonly ownerKind: ActiveChildRun["ownerKind"]
  readonly ownerKey: ChildOwner
  readonly permission: ChildPermissionPolicy
  readonly detached: boolean
  readonly directory: string | undefined
  readonly owner: object
}): ActiveChildRun {
  return {
    ...input,
    phase: "queued",
    outcome: undefined,
    stopDelegated: false,
    credential: issue(input.id, input.childSessionID),
    held: false,
    stopped: false,
    written: false,
    cancelled: Deferred.makeUnsafe<ChildCancelBy>(),
    done: Deferred.makeUnsafe<ChildRunOutcome>(),
    released: Deferred.makeUnsafe<void>(),
  }
}

/** Registers a queued run. False, and nothing registered, when the child session already has an active run. */
export function register(entry: ActiveChildRun): boolean {
  if (registry.bySession.has(entry.childSessionID)) return false
  registry.bySession.set(entry.childSessionID, entry.id)
  registry.byRun.set(entry.id, entry)
  // Only a task run makes its parent a delegations-slot reader: the slot is
  // the model's task view, and a DAG-only parent must keep costing no read.
  if (entry.ownerKind === "task") registry.parents.add(entry.parentSessionID)
  return true
}

/**
 * Whether this process registered a run for `parentSessionID`. The delegations
 * slot reads the database only for such parents: a session that never
 * delegated costs no read.
 */
export function delegated(parentSessionID: string): boolean {
  return registry.parents.has(parentSessionID)
}

/** A deleted parent no longer carries a slot. */
export function forgetParent(parentSessionID: string): void {
  registry.parents.delete(parentSessionID)
}

export function get(runID: string): ActiveChildRun | undefined {
  return registry.byRun.get(runID)
}

/** The active run of a child session, if any. */
export function activeFor(childSessionID: string): ActiveChildRun | undefined {
  const runID = registry.bySession.get(childSessionID)
  return runID === undefined ? undefined : registry.byRun.get(runID)
}

export function activeWhere(predicate: (entry: ActiveChildRun) => boolean): ActiveChildRun[] {
  return [...registry.byRun.values()].filter(predicate)
}

/**
 * The credential of a child session's active run. Admission and the loop of
 * later PRs call this instead of reading the process state themselves.
 */
export function credentialOf(childSessionID: string): ChildRunCredential | undefined {
  const entry = activeFor(childSessionID)
  return entry && !entry.credential.revoked ? entry.credential : undefined
}

/** Whether `credential` is the live credential of its child session's active run: the check PR5 refuses on. */
export function live(credential: ChildRunCredential): boolean {
  return credentialOf(credential.childSessionID) === credential
}

/**
 * The child's own loop calls this when it exits cleanly: true while the run
 * that drives the child session owns the Stop event itself. A foreground task's
 * tool call delivers `SubagentStop` (and drives its continuation); a DAG node's
 * owner delivers its one notification when the attempt settles. Every other
 * child session (SDK created, background task) keeps firing its own. The
 * delegation is recorded on the run, so a task promoted after that exit can
 * still deliver the stop event.
 */
export function delegateStop(childSessionID: string): boolean {
  const entry = activeFor(childSessionID)
  if (!entry || entry.phase === "ended") return false
  if (entry.ownerKind === "task" && entry.detached) return false
  entry.stopDelegated = true
  return true
}

/**
 * The permission subject of a child session's active run, if this process has
 * one. Synchronous and read-free: permission hot paths use it to decide
 * whether an ask is unattended. A session with no active run has no subject
 * (the SDK, a finished child, a dead process's row).
 */
export function subjectOf(
  childSessionID: string,
):
  | { readonly owner: ChildOwner; readonly permission: ChildPermissionPolicy; readonly rootSessionID: string }
  | undefined {
  const entry = activeFor(childSessionID)
  if (!entry || entry.phase === "ended") return undefined
  return { owner: entry.ownerKey, permission: entry.permission, rootSessionID: entry.parentSessionID }
}

/**
 * The run becomes detached: its result goes to the parent through the ledger,
 * and the child's own loop fires its own `Stop` from here on. Idempotent.
 */
export function detach(entry: ActiveChildRun): void {
  entry.detached = true
}

/** queued -> running. False when the run already ended. */
export function begin(entry: ActiveChildRun): boolean {
  if (entry.phase === "ended") return false
  entry.phase = "running"
  return true
}

/**
 * Ends the run; the first caller wins. Its credential is revoked and everyone
 * waiting on it is woken; a cancelled ending also fires the cancellation
 * signal. The entry stays registered after that, and the child session with
 * it, until the row write has finished (`persisted`). With `hold` it also
 * waits for the run's driver to stop (`driverStopped`): a cancellation ends the
 * run at once, but the job carrying it may still be running, and a new run
 * registered in that window would be handed the old job instead of its own.
 */
export function end(
  entry: ActiveChildRun,
  outcome: ChildRunOutcome,
  options: { readonly hold?: boolean } = {},
): boolean {
  if (entry.phase === "ended") return false
  entry.phase = "ended"
  entry.outcome = outcome
  entry.held = options.hold === true && !entry.stopped
  entry.credential.revoked = true
  Deferred.doneUnsafe(entry.done, Effect.succeed(outcome))
  if (outcome.type === "cancelled") Deferred.doneUnsafe(entry.cancelled, Effect.succeed(outcome.by))
  return true
}

/** The ending row write finished, or failed. The entry leaves now unless a cancellation still holds it. */
export function persisted(entry: ActiveChildRun): void {
  entry.written = true
  if (!entry.held) release(entry)
}

/**
 * The driver that carries the run (the background job, or the tool call that
 * awaits it) has stopped, or never will run. A held entry leaves as soon as its
 * row is written; for any other entry this changes nothing.
 */
export function driverStopped(entry: ActiveChildRun): void {
  entry.stopped = true
  entry.held = false
  if (entry.written) release(entry)
}

/** Removes an ended run from the registry and wakes whoever waited for the child session to become free. */
export function release(entry: ActiveChildRun): void {
  registry.byRun.delete(entry.id)
  if (registry.bySession.get(entry.childSessionID) === entry.id) registry.bySession.delete(entry.childSessionID)
  Deferred.doneUnsafe(entry.released, Effect.void)
}

/**
 * The reports of detached runs that ended in this process and wait for their
 * delivery (`EngineProcess.children.reports`). Like the entries above they
 * are only memory: the row is the ledger, and a report that is lost with the
 * process leaves a row the next process delivers without a turn.
 */
export function record(report: ChildReport): void {
  registry.reports.set(report.runID, report)
}

export function reportOf(runID: string): ChildReport | undefined {
  return registry.reports.get(runID)
}

/** Whether a run of `parentSessionID` ended here and still waits for its delivery in `directory`. */
export function hasReport(parentSessionID: string, directory: string): boolean {
  for (const report of registry.reports.values())
    if (report.parentSessionID === parentSessionID && report.directory === directory) return true
  return false
}

export function dropReport(runID: string): void {
  registry.reports.delete(runID)
}

export function dropReportsWhere(predicate: (report: ChildReport) => boolean): void {
  for (const [runID, report] of registry.reports) if (predicate(report)) registry.reports.delete(runID)
}

export * as ChildRegistry from "./registry"
