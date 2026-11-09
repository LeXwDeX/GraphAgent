/**
 * Per-instance hook engine state and dedup helpers.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import type { Fiber } from "effect"
import type { HookCommand, HookSummary, Settings } from "../types"
import type { TriggerResult } from "../trigger-result"
import type { HookExecution } from "../handlers/shared"

export interface StopRewakeChain {
  count: number
  unregister?: () => void
}

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

export function removeStopChain(state: State, key: string, expected?: StopRewakeChain): boolean {
  const chain = state.stopRewakeChains.get(key)
  if (!chain || (expected && chain !== expected)) return false
  state.stopRewakeChains.delete(key)
  chain.unregister?.()
  return true
}

export interface State {
  settings: Settings
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
  stopRewakeChains: Map<string, StopRewakeChain>
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
