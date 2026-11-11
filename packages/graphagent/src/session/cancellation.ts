// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Deferred, Effect } from "effect"
import { EngineProcess, type CancellationOwner, type CancellationSession } from "./engine-process"

// All process-level state lives in `engine-process.ts`: a cancel must be
// visible to every ManagedRuntime layer graph in this process.
const cancellation = EngineProcess.cancellation

/** Publication is innermost: never wait for a cancel decision while holding it. */
export const publication = cancellation.publication

/** The admission registry must be shared by every layer graph in this process. */
export const admissions = cancellation.admissions

export function epoch(sessionID: string): number {
  return cancellation.epochs.get(sessionID) ?? 0
}

function stateFor(sessionID: string): CancellationSession {
  const existing = cancellation.sessions.get(sessionID)
  if (existing) return existing
  const state: CancellationSession = {
    epoch: epoch(sessionID),
    requests: 0,
    aborts: 0,
    goalCancels: 0,
    owners: new Set(),
  }
  cancellation.sessions.set(sessionID, state)
  return state
}

function releaseIfUnused(sessionID: string, state: CancellationSession) {
  if (
    state.requests === 0 &&
    state.aborts === 0 &&
    state.owners.size === 0 &&
    cancellation.sessions.get(sessionID) === state
  )
    cancellation.sessions.delete(sessionID)
}

/** Register before the request's first asynchronous operation. */
export function request(sessionID: string) {
  const state = stateFor(sessionID)
  const epoch = state.epoch
  const wait = state.barrier ?? Effect.void
  let released = false
  state.requests++
  const current = () => cancellation.sessions.get(sessionID) === state && state.epoch === epoch
  return {
    epoch,
    wait,
    current,
    valid: () => !released && current(),
    register(snapshot: () => Effect.Effect<void>, directory?: string) {
      if (released || cancellation.sessions.get(sessionID) !== state || state.epoch !== epoch) return undefined
      const owner: CancellationOwner = { epoch, snapshot, directory }
      state.owners.add(owner)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        state.owners.delete(owner)
        releaseIfUnused(sessionID, state)
      }
    },
    release() {
      if (released) return
      released = true
      state.requests--
      releaseIfUnused(sessionID, state)
    },
  }
}

/**
 * Fenced form of `request` (Issue #1021): create the request only when the
 * session's cancellation epoch still matches the caller's claim-time
 * observation. A mismatch means an ESC advanced the epoch after the claim, so
 * the input must not be admitted; the comparison runs before any state is
 * created, so nothing needs a release.
 */
export function requestIfEpoch(sessionID: string, expected: number): ReturnType<typeof request> | undefined {
  if (epoch(sessionID) !== expected) return undefined
  return request(sessionID)
}

export function goalCancelPending(sessionID: string): boolean {
  return (cancellation.sessions.get(sessionID)?.goalCancels ?? 0) > 0
}

export function waitForGoalCancels(sessionID: string): Effect.Effect<void> {
  const released = cancellation.sessions.get(sessionID)?.goalReleased
  return released ? Deferred.await(released) : Effect.void
}

/** Advance and capture owners without yielding to another request. */
export function begin(sessionID: string) {
  const state = stateFor(sessionID)
  // Failed runner startup can publish idle as soon as cancellation advances.
  if (state.goalCancels === 0) state.goalReleased = Deferred.makeUnsafe<void>()
  state.goalCancels++
  const epoch = ++state.epoch
  cancellation.epochs.set(sessionID, epoch)
  const previous = state.barrier ?? Effect.void
  const released = Deferred.makeUnsafe<void>()
  state.aborts++
  state.barrier = previous.pipe(Effect.andThen(Deferred.await(released)))
  let finished = false
  let goalCancelFinished = false
  const finishGoalCancel = () => {
    if (goalCancelFinished) return
    goalCancelFinished = true
    state.goalCancels--
    if (state.goalCancels === 0 && state.goalReleased) {
      Deferred.doneUnsafe(state.goalReleased, Effect.void)
      state.goalReleased = undefined
    }
  }
  const finish = () => {
    if (finished) return
    finished = true
    finishGoalCancel()
    Deferred.doneUnsafe(released, Effect.void)
    state.aborts--
    if (state.aborts === 0) state.barrier = undefined
    releaseIfUnused(sessionID, state)
  }
  try {
    const targets = [...state.owners]
      .filter((owner) => owner.epoch < epoch)
      .map((owner) => ({ directory: owner.directory, cancel: owner.snapshot() }))
    return { epoch, previous, owners: targets.map((target) => target.cancel), targets, finishGoalCancel, finish }
  } catch (error) {
    finish()
    throw error
  }
}

export * as SessionCancellation from "./cancellation"
