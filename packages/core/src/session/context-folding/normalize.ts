// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ContextFoldingPolicy } from "./policy"
import {
  consumeContainerEntries,
  consumeNode,
  consumeOutputCharacters,
  consumeString,
  createWorkBudget,
  type WorkBudget,
} from "./work-budget"

export type NormalizedParameters =
  | Readonly<{
      ok: true
      value: string
    }>
  | Readonly<{
      ok: false
    }>

const emit = (budget: WorkBudget, length: number, make: () => string) => {
  if (!consumeOutputCharacters(budget, length)) return undefined
  return make()
}

const encodeString = (value: string, budget: WorkBudget) => {
  if (!consumeString(budget, value)) return undefined
  const prefix = `${value.length}:`
  return emit(budget, prefix.length + value.length, () => prefix + value)
}

const encode = (value: unknown, ancestors: Set<object>, budget: WorkBudget, depth: number): string | undefined => {
  if (!consumeNode(budget, depth)) return undefined
  if (value === null) {
    if (!consumeString(budget, "null")) return undefined
    return emit(budget, 5, () => "null;")
  }

  switch (typeof value) {
    case "boolean": {
      const encoded = value ? "bool:1;" : "bool:0;"
      if (!consumeString(budget, value ? "true" : "false")) return undefined
      return emit(budget, encoded.length, () => encoded)
    }
    case "number": {
      if (!Number.isFinite(value)) return undefined
      const number = Object.is(value, -0) ? "-0" : String(value)
      if (!consumeString(budget, number)) return undefined
      return emit(budget, 8 + number.length, () => `number:${number};`)
    }
    case "string": {
      const encoded = encodeString(value, budget)
      if (encoded === undefined) return undefined
      return emit(budget, 8 + encoded.length, () => `string:${encoded};`)
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return undefined
    case "object":
      break
  }

  if (ancestors.has(value)) return undefined
  ancestors.add(value)

  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return undefined
      if (!consumeContainerEntries(budget, value.length)) return undefined

      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1) return undefined
      if (ownKeys.some((key) => typeof key === "symbol")) return undefined

      const items: string[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) return undefined
        const item = encode(descriptor.value, ancestors, budget, depth + 1)
        if (item === undefined) return undefined
        items.push(item)
      }
      const length = `array:${value.length}:[`.length + items.reduce((total, item) => total + item.length, 0) + 1
      return emit(budget, length, () => `array:${value.length}:[${items.join("")}]`)
    }

    if (prototype !== Object.prototype && prototype !== null) return undefined

    const ownKeys = Reflect.ownKeys(value)
    if (!consumeContainerEntries(budget, ownKeys.length)) return undefined
    const keys: string[] = []
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined
      keys.push(key)
    }
    keys.sort()
    const entries: string[] = []

    for (const key of keys) {
      const normalizedKey = encodeString(key, budget)
      if (normalizedKey === undefined) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      const item = encode(descriptor.value, ancestors, budget, depth + 1)
      if (item === undefined) return undefined
      const length = 5 + normalizedKey.length + item.length
      const entry = emit(budget, length, () => `key:${normalizedKey};${item}`)
      if (entry === undefined) return undefined
      entries.push(entry)
    }

    const length = `object:${keys.length}:{`.length + entries.reduce((total, entry) => total + entry.length, 0) + 1
    return emit(budget, length, () => `object:${keys.length}:{${entries.join("")}}`)
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Produces a deterministic, lossless representation of JSON-like tool parameters.
 * Unsupported values, accessors, sparse arrays, cycles, exotic prototypes, and throwing proxies fail closed.
 */
export const normalizeParameters = (
  value: unknown,
  budget: WorkBudget = createWorkBudget(ContextFoldingPolicy.workLimits),
): NormalizedParameters => {
  try {
    const normalized = encode(value, new Set(), budget, 0)
    if (normalized === undefined) return { ok: false }
    return { ok: true, value: normalized }
  } catch {
    return { ok: false }
  }
}
