// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"

// #1013 (C1 PR5): global configuration keys that take effect without
// recreating directory instances.
//
// DAG execution policy is read from the global config layer when a workflow
// starts, so changing it must not dispose instances or interrupt in-flight
// nodes. Every other global key keeps the historical behavior: instances are
// disposed and rebuilt after the write.
//
// #1678: permission rules are resolved again at every permission check
// (`Agent.permissionPolicy` reads the instance configuration each time), so an
// edit made in `/config` only has to refresh the cached instance configuration
// to govern the next tool call of every open session. Disposing the instances
// instead interrupted the running turn and rejected the questions waiting for
// the user, which is exactly when a permission is edited.
export const HOT_RELOAD_GLOBAL_KEYS = ["dag", "permission", "permissions"] as const

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

// Hot keys the merged instance configuration caches. `dag` is not one of them: the DAG policy is read through the
// global layer, which `updateGlobal` always refreshes.
const INSTANCE_CONFIG_KEYS: ReadonlySet<string> = new Set(["permission", "permissions"])

/** True when a changed key is cached in every directory's merged configuration, which then has to be rebuilt. */
export function readsInstanceConfig(changedKeys: readonly string[]): boolean {
  return changedKeys.some((key) => INSTANCE_CONFIG_KEYS.has(key))
}

const field = (config: object, key: string): unknown => Object.entries(config).find(([name]) => name === key)?.[1]

interface RuleView {
  readonly permission: string
  readonly pattern: string
  readonly action: string
}

/**
 * The permission rules a configuration object holds, per permission key, in file order. Both spellings count: the
 * `permission` map (a bare string is the whole-key `*` pattern) and the `permissions` list (`action` names the
 * permission, `resource` the pattern, `effect` the verdict).
 */
function permissionRulesByKey(config: object): Map<string, RuleView[]> {
  const result = new Map<string, RuleView[]>()
  const add = (permission: string, pattern: unknown, action: unknown) => {
    if (typeof action !== "string") return
    const rules = result.get(permission) ?? []
    rules.push({ permission, pattern: typeof pattern === "string" ? pattern : "*", action })
    result.set(permission, rules)
  }
  const map = field(config, "permission")
  if (typeof map === "string") add("*", "*", map)
  else if (isRecord(map)) {
    for (const [permission, value] of Object.entries(map)) {
      if (typeof value === "string") add(permission, "*", value)
      else if (isRecord(value)) for (const [pattern, action] of Object.entries(value)) add(permission, pattern, action)
    }
  }
  const list = field(config, "permissions")
  if (Array.isArray(list)) {
    for (const rule of list) {
      if (isRecord(rule) && typeof rule.action === "string") add(rule.action, rule.resource, rule.effect)
    }
  }
  return result
}

/**
 * The permission keys an edit made stricter (#1678): the rules written for the key differ, and the new ones hold an
 * `ask` or a `deny`. An "always allow" the user gave earlier in a session outranks an `ask` rule, so it must be
 * forgotten for these keys or the new rule would never be met; an edit that only loosens a key (`allow`, or no rule
 * at all) leaves what the user approved alone. A key written as `*` covers every permission.
 */
export function tightenedPermissionKeys(before: object, after: object): string[] {
  const previous = permissionRulesByKey(before)
  const next = permissionRulesByKey(after)
  const keys: string[] = []
  for (const [permission, rules] of next) {
    if (!rules.some((rule) => rule.action === "ask" || rule.action === "deny")) continue
    if (plainEqual(previous.get(permission) ?? [], rules)) continue
    keys.push(permission)
  }
  return keys.sort()
}

export * as ConfigHotReload from "./hot-reload"
