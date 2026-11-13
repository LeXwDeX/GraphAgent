// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Deferred, Effect } from "effect"
import { EngineProcess, type ActiveChildRun } from "../engine-process"
import type { ChildCancelBy, ChildRunOutcome } from "./types"

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

export function create(input: {
  readonly id: string
  readonly childSessionID: ActiveChildRun["childSessionID"]
  readonly parentSessionID: ActiveChildRun["parentSessionID"]
  readonly directory: string | undefined
  readonly owner: object
}): ActiveChildRun {
  return {
    ...input,
    phase: "queued",
    outcome: undefined,
    credential: { runID: input.id, revoked: false },
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
  return true
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
export function credentialOf(childSessionID: string): ActiveChildRun["credential"] | undefined {
  const entry = activeFor(childSessionID)
  return entry && !entry.credential.revoked ? entry.credential : undefined
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

export * as ChildRegistry from "./registry"
