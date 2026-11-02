import { Clock, Effect, Semaphore } from "effect"

export interface PollEntry {
  count: number
  at: number
  change?: number | string
  lock: Semaphore.Semaphore
  lastReadAt?: number
  active: number
}

export const POLL_TTL_MS = 10 * 60_000
export const POLL_MAX_ENTRIES = 256
export const POLL_DELAY_MS = 1_000

export function prunePollState(state: Map<string, PollEntry>, now = Date.now()) {
  for (const [key, entry] of state) {
    if (entry.active > 0) continue
    if (now - entry.at >= POLL_TTL_MS) state.delete(key)
  }
  while (state.size > POLL_MAX_ENTRIES) {
    const oldest = [...state].find(([, entry]) => entry.active === 0)
    if (!oldest) break
    state.delete(oldest[0])
  }
}

export function ensurePollEntry(state: Map<string, PollEntry>, key: string) {
  const existing = state.get(key)
  if (existing) {
    // Refresh insertion order so eviction is least-recently-used.
    state.delete(key)
    state.set(key, existing)
    return existing
  }
  while (state.size >= POLL_MAX_ENTRIES) {
    const oldest = [...state].find(([, entry]) => entry.active === 0)
    if (!oldest) return undefined
    state.delete(oldest[0])
  }
  const entry: PollEntry = { count: 0, at: Date.now(), lock: Semaphore.makeUnsafe(1), active: 0 }
  state.set(key, entry)
  return entry
}

/** Keep only one bounded, expiring counter per poll key. Map insertion order
 * is refreshed on every hit, which makes eviction least-recently-used. */
export function bumpPollState(
  state: Map<string, PollEntry>,
  key: string,
  empty: boolean,
  now = Date.now(),
  change?: number | string,
) {
  prunePollState(state, now)
  if (!empty) {
    // Keep the entry (and its lock identity) so a concurrent slot cannot
    // replace the lock; a non-empty read simply clears the empty streak.
    const existing = state.get(key)
    if (existing) {
      existing.count = 0
      existing.at = now
    }
    return 0
  }
  // Mutate the shared entry so fibers holding this reference observe the
  // latest count and timestamp instead of a stale snapshot.
  const entry = ensurePollEntry(state, key)
  if (!entry) return 0
  const durableChange = change !== undefined && entry.change !== undefined && change !== entry.change
  entry.count = (durableChange ? 0 : entry.count) + 1
  entry.at = now
  entry.change = change
  prunePollState(state, now)
  return entry.count
}

export type PollSlotResult<A> =
  | { readonly kind: "read"; readonly value: A }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number; readonly count: number }

/**
 * Serialize reads for one poll key and, after repeated empty polls, wait a
 * bounded interval before the next real read. With a budget, an unaffordable
 * cooldown returns `rate_limited` instead of delaying beyond the caller's
 * deadline. The returned effect always performs the caller's read when it
 * reports `read`; it never serves cached data. Cancellation releases the slot.
 */
export const withPollReadSlot = <A, E, R>(
  state: Map<string, PollEntry>,
  key: string,
  intervalMs: number,
  budgetMs: () => number,
  effect: (entry: PollEntry) => Effect.Effect<A, E, R>,
  isRead: (value: A) => boolean = () => true,
): Effect.Effect<PollSlotResult<A>, E, R> =>
  Effect.gen(function* () {
    const entry = ensurePollEntry(state, key)
    if (!entry || entry.active > 0) {
      return { kind: "rate_limited", retryAfterMs: intervalMs || POLL_DELAY_MS, count: entry?.count ?? 0 } as const
    }
    entry.active += 1
    return yield* entry.lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = entry
          if (current.count >= 3) {
            const now = yield* Clock.currentTimeMillis
            const remaining =
              current.lastReadAt === undefined ? 0 : Math.max(0, intervalMs - (now - current.lastReadAt))
            const budget = Math.max(0, budgetMs())
            if (remaining > budget) {
              return { kind: "rate_limited", retryAfterMs: remaining, count: current.count } as const
            }
            if (remaining > 0) yield* Effect.sleep(remaining)
          }
          const value = yield* effect(current)
          if (isRead(value)) current.lastReadAt = yield* Clock.currentTimeMillis
          return { kind: "read", value } as const
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.active -= 1
          }),
        ),
      )
  })

/**
 * Delay-only slot used by callers without a wait budget (observe). It always
 * performs the read after the bounded delay and never returns cached data.
 */
export const withPollSlot = <A, E, R>(
  state: Map<string, PollEntry>,
  key: string,
  intervalMs: number,
  delay: boolean,
  effect: (entry: PollEntry) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const entry = ensurePollEntry(state, key)
    if (!entry) return yield* Effect.die("poll state capacity exhausted")
    entry.active += 1
    return yield* entry.lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = entry
          if (delay && current.count >= 3) {
            const now = yield* Clock.currentTimeMillis
            const remaining =
              current.lastReadAt === undefined ? 0 : Math.max(0, intervalMs - (now - current.lastReadAt))
            if (remaining > 0) yield* Effect.sleep(remaining)
          }
          const result = yield* effect(current)
          current.lastReadAt = yield* Clock.currentTimeMillis
          return result
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.active -= 1
          }),
        ),
      )
  })

export * as PollState from "./poll-state"
