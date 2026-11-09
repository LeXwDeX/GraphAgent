// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Session interest aggregator (#886 5.1, 5.8).
 *
 * `events.setInterest({ full })` replaces the whole set, so every feature that
 * needs full events registers a source here and the aggregator submits the
 * union. Submissions are coalesced to at most one per frame, and `set()`
 * resolves only after the worker confirmed the new set — callers use that
 * ordering before hydrating a session snapshot.
 */
export type InterestSource = "route" | (string & {})

export interface InterestAggregatorOptions {
  submit: (full: readonly string[]) => Promise<void>
  /** Sessions with an unanswered permission or question, added client-side only. */
  pendingAsks?: () => ReadonlySet<string>
  frame?: { schedule(fn: () => void): void }
}

export interface InterestAggregator {
  /** Replace one source's sessions. Resolves after the worker applied the union. */
  set(source: InterestSource, sessionIDs: readonly string[]): Promise<void>
  delete(source: InterestSource): Promise<void>
  /** Explicit union submitted to the worker. */
  explicit(): ReadonlySet<string>
  /** Explicit union plus pending-ask sessions; this is what the gate uses. */
  full(): ReadonlySet<string>
  /** Re-submit if sources changed without a `set` (e.g. a new pending ask). */
  refresh(): void
  dispose(): void
}

function key(sessionIDs: ReadonlySet<string>) {
  return [...sessionIDs].toSorted().join("\u0000")
}

export function createInterestAggregator(options: InterestAggregatorOptions): InterestAggregator {
  const sources = new Map<string, Set<string>>()
  let submitted: string | undefined
  let scheduled = false
  let submitting = false
  let rerun = false
  let disposed = false
  let waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []

  function explicitSet() {
    const union = new Set<string>()
    for (const ids of sources.values()) {
      for (const id of ids) union.add(id)
    }
    return union
  }

  function fullSet() {
    const explicit = explicitSet()
    const asks = options.pendingAsks?.() ?? new Set<string>()
    if (asks.size === 0) return explicit
    const union = new Set(explicit)
    for (const id of asks) union.add(id)
    return union
  }

  function resolveWaiters() {
    const current = waiters
    waiters = []
    for (const waiter of current) waiter.resolve()
  }

  function rejectWaiters(error: unknown) {
    const current = waiters
    waiters = []
    for (const waiter of current) waiter.reject(error)
  }

  function schedule(run: () => void) {
    if (scheduled) return
    scheduled = true
    if (options.frame) options.frame.schedule(run)
    else queueMicrotask(run)
  }

  function ensureScheduled() {
    if (disposed || scheduled) return
    schedule(run)
  }

  function run() {
    scheduled = false
    void flush()
  }

  async function flush() {
    if (disposed) return
    if (submitting) {
      rerun = true
      return
    }
    const next = explicitSet()
    const nextKey = key(next)
    if (nextKey === submitted) {
      if (waiters.length > 0) resolveWaiters()
      return
    }
    submitting = true
    try {
      await options.submit([...next].toSorted())
      submitted = nextKey
      if (key(explicitSet()) === nextKey) resolveWaiters()
      else rerun = true
    } catch (error) {
      submitted = undefined
      rejectWaiters(error)
    } finally {
      submitting = false
      if (rerun) {
        rerun = false
        ensureScheduled()
      } else if (waiters.length > 0) {
        ensureScheduled()
      }
    }
  }

  return {
    set(source, sessionIDs) {
      const next = new Set(sessionIDs)
      const previous = sources.get(source)
      if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) {
        return Promise.resolve()
      }
      sources.set(source, next)
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject })
        ensureScheduled()
      })
    },
    delete(source) {
      if (!sources.delete(source)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject })
        ensureScheduled()
      })
    },
    explicit() {
      return explicitSet()
    },
    full() {
      return fullSet()
    },
    refresh() {
      ensureScheduled()
    },
    dispose() {
      disposed = true
      sources.clear()
      resolveWaiters()
    },
  }
}
