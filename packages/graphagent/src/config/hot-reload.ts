// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"
import type { PermissionV1 } from "@graphagent/core/v1/permission"

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

const isAction = (value: unknown): value is PermissionV1.Rule["action"] =>
  value === "allow" || value === "ask" || value === "deny"

/**
 * The permission rules a configuration object holds, in the order the permission check reads them (of the rules that
 * match, the last one decides). The ordered `permissions` list (`action` names the permission, `resource` the
 * pattern, `effect` the verdict) replaces the `permission` map when both are written, as
 * `HookPermissions.orderedRules` has it; in the map a bare string is the whole-key `*` pattern, and a bare string in
 * place of the whole map is the rule of the `*` key.
 */
function permissionRules(config: object): PermissionV1.Rule[] {
  const rules: PermissionV1.Rule[] = []
  const add = (permission: string, pattern: unknown, action: unknown) => {
    if (isAction(action)) rules.push({ permission, pattern: typeof pattern === "string" ? pattern : "*", action })
  }
  const list = field(config, "permissions")
  if (Array.isArray(list)) {
    for (const rule of list) {
      if (isRecord(rule) && typeof rule.action === "string") add(rule.action, rule.resource, rule.effect)
    }
    return rules
  }
  const map = field(config, "permission")
  if (typeof map === "string") add("*", "*", map)
  else if (isRecord(map)) {
    for (const [permission, value] of Object.entries(map)) {
      if (!isRecord(value)) add(permission, "*", value)
      else for (const [pattern, action] of Object.entries(value)) add(permission, pattern, action)
    }
  }
  return rules
}

const ruleId = (rule: PermissionV1.Rule) => JSON.stringify([rule.permission, rule.pattern, rule.action])

/** Where two sequences of rules part, the rules of both at those places. */
function whereTheyPart(left: readonly PermissionV1.Rule[], right: readonly PermissionV1.Rule[]): PermissionV1.Rule[] {
  const parted: PermissionV1.Rule[] = []
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const was = left[index]
    const now = right[index]
    if (was && now && ruleId(was) === ruleId(now)) continue
    parted.push(...[was, now].filter((rule) => rule !== undefined))
  }
  return parted
}

/**
 * The permission keys an edit made stricter (#1678): the keys for which a request that an `allow` let through may now
 * ask. An "always allow" the user gave earlier in a session outranks an `ask` rule, so it would keep letting such a
 * request through; it has to be forgotten for these keys, or the new rule would never be met. An edit that only loosens
 * a key (a new `allow`, a rule that asked removed) leaves what the user approved alone.
 *
 * The rules each side holds are compared whole, in the order the permission check reads them (of the rules that match a
 * request, the last decides). A key is stricter when
 * - a rule that asks or denies is new: a rule turned to `ask` or `deny`, or one added behind an `allow`;
 * - an `allow` is gone: deleted, narrowed or replaced, whatever the key falls back to afterwards (a `*` rule, the
 *   agent's own default); or
 * - a rule both sides hold sits elsewhere among those they share now, which can put an `allow` behind a rule that asks.
 *
 * This does not depend on what any one request matches, so it holds where two globs overlap as well: for a request that
 * an `allow` let through and that now asks, that `allow` is gone, or the rule that asks is new, or the two changed
 * places. What it gives up is precision: an `allow` that another rule still covers counts as gone when it is deleted,
 * which is one more question. A stricter `*` covers every key; another wildcard key stands for the keys it matches.
 */
export function tightenedPermissionKeys(before: object, after: object): string[] {
  const previous = permissionRules(before)
  const next = permissionRules(after)
  const had = new Set(previous.map(ruleId))
  const has = new Set(next.map(ruleId))
  const keys = new Set(
    [
      ...next.filter((rule) => rule.action !== "allow" && !had.has(ruleId(rule))),
      ...previous.filter((rule) => rule.action === "allow" && !has.has(ruleId(rule))),
      ...whereTheyPart(
        previous.filter((rule) => has.has(ruleId(rule))),
        next.filter((rule) => had.has(ruleId(rule))),
      ),
    ].map((rule) => rule.permission),
  )
  return keys.has("*") ? ["*"] : [...keys].sort()
}

export * as ConfigHotReload from "./hot-reload"
