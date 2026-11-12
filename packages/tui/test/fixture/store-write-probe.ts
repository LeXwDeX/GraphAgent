// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createComputed, createRoot, untrack } from "solid-js"

/**
 * Observes real writes to slices of a Solid store.
 *
 * `sync.tsx` writes through a `setStore` it never exposes, so a test cannot wrap
 * the setter. The store does expose its notifications, though: every write that
 * changes a value notifies the computations that read it. A computation that
 * deep-reads one key of a slice therefore reruns exactly when that key changed,
 * and never when the write was a no-op or went to another slice.
 *
 * Counting rules:
 * - A write is counted once per changed top-level key of a slice (for example
 *   `part[messageID]` or `message[sessionID]`) and once per flush. Writes of one
 *   `batch()` to the same key coalesce into a single count, which is also what
 *   renders: one reactive update.
 * - A key that appears after the probe attached counts as one write.
 * - Writes that leave every value unchanged count zero.
 *
 * Only slices whose value is an object or an array can be watched.
 */
export interface StoreWriteProbe<K extends string> {
  /** Writes counted for one slice since the probe attached. */
  writes(slice: K): number
  /** Writes counted across every watched slice. */
  total(): number
  dispose(): void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Reads every reachable value so the running computation subscribes to each of them. */
function touch(value: unknown, seen: Set<object>) {
  if (!isObject(value) || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) touch(value[index], seen)
    return
  }
  for (const key of Object.keys(value)) touch(value[key], seen)
}

export function probeStoreWrites<T extends object, K extends keyof T & string>(
  store: T,
  slices: readonly K[],
  onWrite?: (slice: K, key: string) => void,
): StoreWriteProbe<K> {
  const counts = new Map<K, number>(slices.map((slice) => [slice, 0]))
  let live = true
  const stops: Array<() => void> = []

  const record = (slice: K, key: string) => {
    if (!live) return
    counts.set(slice, (counts.get(slice) ?? 0) + 1)
    onWrite?.(slice, key)
  }

  for (const slice of slices) {
    const read = () => store[slice]
    if (!isObject(untrack(read))) throw new Error(`store slice "${slice}" is not an object or array`)
    const children = new Map<string, () => void>()
    let attached = false

    const watchKey = (key: string) =>
      createRoot((dispose) => {
        let first = true
        createComputed(() => {
          const slot = read()
          touch(isObject(slot) ? slot[key] : undefined, new Set())
          if (first) first = false
          else record(slice, key)
        })
        return dispose
      })

    stops.push(
      createRoot((dispose) => {
        // Tracks the container itself: a key appearing later is a write that no
        // existing per-key computation can see, because it did not exist yet.
        createComputed(() => {
          const slot = read()
          const keys = isObject(slot) ? Object.keys(slot) : []
          untrack(() => {
            for (const key of keys) {
              if (children.has(key)) continue
              children.set(key, watchKey(key))
              if (attached) record(slice, key)
            }
          })
          attached = true
        })
        return () => {
          for (const stop of children.values()) stop()
          children.clear()
          dispose()
        }
      }),
    )
  }

  return {
    writes: (slice) => counts.get(slice) ?? 0,
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    dispose() {
      live = false
      for (const stop of stops.splice(0)) stop()
    },
  }
}
