// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-instance hook engine state and dedup helpers.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import type { Fiber } from "effect"
import { SessionCancellation } from "@/session/cancellation"
import type { HookCommand, HookEvent, HookSummary, RewakeToken, Settings } from "../types"
import type { TriggerResult } from "../trigger-result"
import type { HookExecution } from "../handlers/shared"

/**
 * One running foreground handler per (session, hook digest). Several fibers may
 * share a digest when the same handler runs concurrently in parallel triggers;
 * `cancelled` names the fibers a `Hooks.cancel` call actually interrupted so an
 * unrelated interruption is never misreported as a user cancellation.
 */
export interface RunningHook {
  readonly fibers: Set<Fiber.Fiber<HookExecution>>
  readonly cancelled: Set<Fiber.Fiber<HookExecution>>
}

export interface State {
  settings: Settings
  /**
   * Chain commands the project-trust gate refused. Checked before eligibility,
   * dedup and `once` claims so a refused entry can never run or consume a
   * one-shot reservation. Replaced wholesale when the chain or trust changes.
   */
  untrusted: WeakSet<HookCommand>
  cwd: string
  /** Stable project root; survives deletion of `cwd`, so hooks can fall back to it. */
  root: string
  /**
   * Deduplicated additionalContext strings, bucketed per sessionID. Each
   * session sees every distinct context once; a second session is NOT
   * starved by what the first already saw. The bucket for a session is
   * evicted on SessionEnd (see trigger) so the map does not grow unboundedly
   * across the process lifetime. Headless / no-session triggers collapse to
   * the "" bucket, preserving the prior global-dedup behavior for those.
   */
  seen: Map<string, Set<string>>
  once: Map<string, WeakSet<HookCommand>>
  onceRunning: Map<string, WeakMap<HookCommand, string>>
  /**
   * Rewake-chain generation per session (default 0). Advanced whenever the
   * chain resets: a real UserPromptSubmit, SessionEnd, clearSession, or cancel.
   * A pending async Stop callback captured under an older generation is stale.
   * Never evicted: a reused session ID must not validate an old generation-0
   * token, at the cost of one number per historical session.
   */
  rewakeGenerations: Map<string, number>
  /**
   * Consecutive blocked Stop continuations per session and event. Stop,
   * StopFailure and SubagentStop each keep an independent budget so a main
   * Stop rewake cannot exhaust (or leak `stop_hook_active` into) a later
   * subagent stop.
   */
  stopContinuations: Map<string, Map<HookEvent, number>>
  asyncResults: Map<string, TriggerResult>
  asyncFibers: Map<string, Set<Fiber.Fiber<unknown, unknown>>>
  /** Running foreground handlers keyed by `${sessionID}:${hookID}`; backs `Hooks.cancel`. */
  runningHooks: Map<string, RunningHook>
  /**
   * Async SessionEnd commands. Their session is gone by design, so ending it must not
   * interrupt them; they run for their side effects and stop only with the instance.
   */
  endFibers: Set<Fiber.Fiber<unknown, unknown>>
  /**
   * Scope-tagged summaries of the currently-effective hooks, computed by
   * `summarizeChain` alongside `settings` (same closure, same hot-reload
   * watcher). `list()` reads this without touching files.
   */
  hooksList: HookSummary[]
}

// Per-session additionalContext dedup bucket cap. A normal session never
// approaches this; the bound exists for the headless "" bucket (sessionID=""),
// which is shared across every prompt of a long-lived headless process and
// would otherwise accumulate without limit. Eviction is insertion-order-oldest
// (Set iterates in insertion order), so the least-recently-injected context is
// dropped first — acceptable since re-injection only matters within a session.
const MAX_SEEN_PER_BUCKET = 1000

/**
 * Add `text` to the per-session dedup bucket; returns true when newly added
 * (the caller then injects it into additionalContexts). Caps the bucket at
 * MAX_SEEN_PER_BUCKET by evicting the oldest entry — see the constant comment
 * for why the headless "" bucket needs this.
 */
export const addSeen = (seen: Map<string, Set<string>>, sessionID: string, text: string): boolean => {
  const bucket = seen.get(sessionID) ?? new Set<string>()
  if (bucket.has(text)) return false
  bucket.add(text)
  if (bucket.size > MAX_SEEN_PER_BUCKET) {
    const oldest = bucket.values().next().value
    if (oldest !== undefined) bucket.delete(oldest)
  }
  seen.set(sessionID, bucket)
  return true
}

/** Snapshot of the session's current rewake-chain identity. */
export function rewakeTokenFor(state: State, sessionID: string): RewakeToken {
  return { epoch: SessionCancellation.epoch(sessionID), generation: state.rewakeGenerations.get(sessionID) ?? 0 }
}

/** True when `token` still identifies the session's live rewake chain. */
export function rewakeTokenValid(state: State, sessionID: string, token: unknown): boolean {
  if (!token || typeof token !== "object") return false
  const { epoch, generation } = token as Partial<RewakeToken>
  return epoch === SessionCancellation.epoch(sessionID) && generation === (state.rewakeGenerations.get(sessionID) ?? 0)
}

/**
 * Reset the session's rewake chain: advance the generation so every captured
 * token becomes stale, and drop the Stop-continuation counts with it. Used by
 * every chain boundary (UserPromptSubmit, SessionEnd, clearSession, cancel).
 */
export function advanceRewakeGeneration(state: State, sessionID: string): void {
  state.rewakeGenerations.set(sessionID, (state.rewakeGenerations.get(sessionID) ?? 0) + 1)
  state.stopContinuations.delete(sessionID)
}

/** Blocked-continuation count for one event, without consuming a slot. */
export function stopContinuationCount(state: State, sessionID: string, event: HookEvent): number {
  return state.stopContinuations.get(sessionID)?.get(event) ?? 0
}

/**
 * Consume one Stop-continuation slot. Returns false when `cap` consecutive
 * blocked continuations have already been issued for this (session, event).
 * The read and write are synchronous, so concurrent completions cannot both
 * claim the last slot.
 */
export function claimStopContinuation(state: State, sessionID: string, event: HookEvent, cap: number): boolean {
  const counts = state.stopContinuations.get(sessionID) ?? new Map<HookEvent, number>()
  const count = counts.get(event) ?? 0
  if (count >= cap) return false
  counts.set(event, count + 1)
  state.stopContinuations.set(sessionID, counts)
  return true
}

/** Literal FileChanged matcher entries are the static watch list. */
export function staticWatchPaths(settings: Settings): readonly string[] {
  return [
    ...new Set(
      (settings.hooks?.FileChanged ?? [])
        .flatMap((group) => (group.matcher === undefined || group.matcher === "" ? [] : group.matcher.split("|")))
        .filter(Boolean),
    ),
  ]
}
