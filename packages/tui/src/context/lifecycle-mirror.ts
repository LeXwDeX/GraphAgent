// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type {
  EventLifecycleTransitioned,
  Goal,
  LifecycleDomain,
  LifecyclePhase,
  LifecycleState,
  LifecycleStateRef,
} from "@graphagent/sdk"

/**
 * Client mirror of the runtime lifecycle contract (#1069).
 *
 * `lifecycle.transitioned` is a transient event: it names a `StateRef` and the
 * value it moved to, and a client that was disconnected never sees it again.
 * The mirror therefore treats the event as a hint, not as the record. Each
 * transition writes the entry the event describes and queues the ref; one
 * batched read of `POST /lifecycle/states` per frame lets the owner confirm or
 * correct it, and a ref the owner no longer knows is dropped. The same batch
 * is what a reconnect sends for everything the mirror holds. Only refs of a
 * domain the owner can resolve (`isPullableDomain`) are queued.
 */

/** Entries kept at most; finished ones are dropped first, oldest first. */
export const LIFECYCLE_MIRROR_MAX = 256

/**
 * The domains whose owner registers a resolver with the server's lifecycle
 * service (`BackgroundLifecycle` for `job`, `GoalLifecycle` for `goal`,
 * `PrWatchLifecycle` for `pr_watch`). A ref of any other domain, a `turn` for
 * example, always comes back unknown, so asking about it only costs a request
 * per transition for an answer that is always null. Add a domain here in the
 * same change that registers its resolver.
 */
const PULLABLE_DOMAINS: ReadonlySet<LifecycleDomain> = new Set<LifecycleDomain>(["job", "goal", "pr_watch"])

export interface LifecycleMirrorEntry {
  domain: LifecycleDomain
  id: string
  /** Owning session, when the producer names one. */
  sessionID?: string
  /** The domain's own status literal, for example `running` or `paused`. */
  value: string
  phase: LifecyclePhase
  reason?: string
  /** Event time for a transition, observation time for a pulled state. */
  at: number
}

export type LifecycleTransition = EventLifecycleTransitioned["properties"]

export function lifecycleKey(ref: LifecycleStateRef): string {
  return `${ref.domain}:${ref.id}`
}

/**
 * Whether the owner can answer a read for refs of this domain. The mirror
 * keeps what the events of the other domains described and never asks.
 */
export function isPullableDomain(domain: LifecycleDomain): boolean {
  return PULLABLE_DOMAINS.has(domain)
}

export function entryFromTransition(transition: LifecycleTransition): LifecycleMirrorEntry {
  return {
    domain: transition.domain,
    id: transition.stateID,
    sessionID: transition.sessionID,
    value: transition.to,
    phase: transition.phase,
    reason: transition.reason,
    at: transition.timestamp,
  }
}

/**
 * An owner's answer for one ref. `sessionID` carries over from the transition
 * that introduced the ref: the answer itself does not name the session.
 */
export function entryFromState(state: LifecycleState, sessionID: string | undefined): LifecycleMirrorEntry {
  return {
    domain: state.domain,
    id: state.id,
    sessionID,
    value: state.value,
    phase: state.phase,
    // The wire encodes non-finite numbers as strings; a finite time is the only useful one.
    at: typeof state.observedAt === "number" ? state.observedAt : Date.now(),
  }
}

/** A phase that will not change again on its own. */
export function isFinishedPhase(phase: LifecyclePhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "skipped"
}

/** Keys to evict so that at most `max` entries remain: finished first, then oldest. */
export function overflowKeys(entries: ReadonlyMap<string, LifecycleMirrorEntry>, max = LIFECYCLE_MIRROR_MAX): string[] {
  const excess = entries.size - max
  if (excess <= 0) return []
  return [...entries]
    .toSorted(([, a], [, b]) => {
      const finished = Number(isFinishedPhase(b.phase)) - Number(isFinishedPhase(a.phase))
      return finished !== 0 ? finished : a.at - b.at
    })
    .slice(0, excess)
    .map(([key]) => key)
}

/** The goal statuses the lifecycle vocabulary shares with the goal slice. */
export function goalStatus(value: string): Goal["status"] | undefined {
  switch (value) {
    case "active":
    case "waiting":
    case "paused":
    case "done":
      return value
    default:
      return undefined
  }
}
