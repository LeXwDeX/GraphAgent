// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1013 (C1 PR5): global configuration keys that take effect without
// recreating directory instances.
//
// DAG execution policy is read from the global config layer when a workflow
// starts, so changing it must not dispose instances or interrupt in-flight
// nodes. Every other global key keeps the historical behavior: instances are
// disposed and rebuilt after the write.
export const HOT_RELOAD_GLOBAL_KEYS = ["dag"] as const

export type HotReloadGlobalKey = (typeof HOT_RELOAD_GLOBAL_KEYS)[number]

const HOT_RELOAD: ReadonlySet<string> = new Set(HOT_RELOAD_GLOBAL_KEYS)

/** Global event emitted instead of `server.instance.disposed` for a hot-only update. */
export const CONFIG_UPDATED_EVENT = "config.updated"

function plainEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => plainEqual(item, right[index]))
  }
  if (typeof left !== "object" || left === null || Array.isArray(left)) return false
  if (typeof right !== "object" || right === null || Array.isArray(right)) return false
  const previous = new Map(Object.entries(left))
  const next = new Map(Object.entries(right))
  if (previous.size !== next.size) return false
  for (const [key, value] of previous) {
    if (!next.has(key) || !plainEqual(value, next.get(key))) return false
  }
  return true
}

/**
 * Top-level keys whose values differ between two parsed config objects.
 * Nested changes surface under their top-level key (`dag`); key order alone is
 * not a change.
 */
export function changedTopLevelKeys(before: object, after: object): string[] {
  const previous = new Map(Object.entries(before))
  const next = new Map(Object.entries(after))
  const changed: string[] = []
  for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    if (!plainEqual(previous.get(key), next.get(key))) changed.push(key)
  }
  return changed
}

/** True only when at least one key changed and every changed key is hot-read. */
export function isHotReloadOnly(changedKeys: readonly string[]): boolean {
  return changedKeys.length > 0 && changedKeys.every((key) => HOT_RELOAD.has(key))
}

export * as ConfigHotReload from "./hot-reload"
