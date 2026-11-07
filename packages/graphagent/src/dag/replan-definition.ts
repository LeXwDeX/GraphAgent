// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    )
  }
  if (!isObject(left) || !isObject(right)) return false

  const leftKeys = Object.keys(left)
    .filter((key) => left[key] !== undefined)
    .sort()
  const rightKeys = Object.keys(right)
    .filter((key) => right[key] !== undefined)
    .sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]))
  )
}

function changedObjectFields(
  prefix: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignored: ReadonlySet<string>,
): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys]
    .filter((key) => !ignored.has(key) && !structurallyEqual(left[key], right[key]))
    .map((key) => `${prefix}.${key}`)
}

/**
 * Execution fields changed by a replan replacement after a node was admitted.
 * Control markers are not part of the node definition. A running attempt may
 * hot-update only timeout_ms; queued attempts have already fixed that deadline.
 */
export function changedAdmittedNodeFields<T extends object>(
  current: T,
  next: T,
  options: { allowTimeoutUpdate: boolean },
): string[] {
  const left = Object.fromEntries(Object.entries(current))
  const right = Object.fromEntries(Object.entries(next))
  const ignored = new Set(["id", "restart", "cancel", "worker_config"])
  const changed = changedObjectFields("", left, right, ignored).map((field) => field.slice(1))

  const leftWorker = isObject(left.worker_config) ? left.worker_config : {}
  const rightWorker = isObject(right.worker_config) ? right.worker_config : {}
  changed.push(
    ...changedObjectFields(
      "worker_config",
      leftWorker,
      rightWorker,
      options.allowTimeoutUpdate ? new Set(["timeout_ms"]) : new Set(),
    ),
  )
  return changed.sort()
}

export * as ReplanDefinition from "./replan-definition"
