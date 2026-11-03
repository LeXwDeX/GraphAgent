import { Deferred, Effect } from "effect"
import { SessionAdmission } from "@opencode-ai/core/session/admission"

type Owner = {
  readonly epoch: number
  readonly directory?: string
  readonly snapshot: () => Effect.Effect<void>
}

type State = {
  epoch: number
  requests: number
  aborts: number
  owners: Set<Owner>
  barrier?: Effect.Effect<void>
}

const sessions = new Map<string, State>()
const epochs = new Map<string, number>()

// The admission registry must be shared by every layer graph in this process.
export const admissions = SessionAdmission.make()

export function epoch(sessionID: string): number {
  return epochs.get(sessionID) ?? 0
}

function stateFor(sessionID: string) {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const state: State = { epoch: epoch(sessionID), requests: 0, aborts: 0, owners: new Set() }
  sessions.set(sessionID, state)
  return state
}

function releaseIfUnused(sessionID: string, state: State) {
  if (state.requests === 0 && state.aborts === 0 && state.owners.size === 0 && sessions.get(sessionID) === state)
    sessions.delete(sessionID)
}

/** Register before the request's first asynchronous operation. */
export function request(sessionID: string) {
  const state = stateFor(sessionID)
  const epoch = state.epoch
  const wait = state.barrier ?? Effect.void
  let released = false
  state.requests++
  const current = () => sessions.get(sessionID) === state && state.epoch === epoch
  return {
    epoch,
    wait,
    current,
    valid: () => !released && current(),
    register(snapshot: () => Effect.Effect<void>, directory?: string) {
      if (released || sessions.get(sessionID) !== state || state.epoch !== epoch) return undefined
      const owner: Owner = { epoch, snapshot, directory }
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

/** Advance and capture owners without yielding to another request. */
export function begin(sessionID: string) {
  const state = stateFor(sessionID)
  const epoch = ++state.epoch
  epochs.set(sessionID, epoch)
  const previous = state.barrier ?? Effect.void
  const released = Deferred.makeUnsafe<void>()
  state.aborts++
  state.barrier = previous.pipe(Effect.andThen(Deferred.await(released)))
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    Deferred.doneUnsafe(released, Effect.void)
    state.aborts--
    if (state.aborts === 0) state.barrier = undefined
    releaseIfUnused(sessionID, state)
  }
  try {
    const targets = [...state.owners]
      .filter((owner) => owner.epoch < epoch)
      .map((owner) => ({ directory: owner.directory, cancel: owner.snapshot() }))
    return { epoch, previous, owners: targets.map((target) => target.cancel), targets, finish }
  } catch (error) {
    finish()
    throw error
  }
}

export * as SessionCancellation from "./cancellation"
