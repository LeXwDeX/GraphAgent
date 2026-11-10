// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry normalization for project trust (T1).
 *
 * A fingerprint covers only fields that can change what an entry executes or
 * where it sends data. The per-category field list below is the contract:
 * adding a field is a deliberate decision and must be covered by a test.
 * Environment and header *values* are deliberately reduced to their key
 * names, so a rotated secret does not send the user back through the panel.
 */
import type { CanonicalObject, CanonicalValue, TrustCategory } from "./types"

/**
 * How a field is normalized:
 * - `value`: JSON value with sorted nested keys (commands, args, URLs, timeouts).
 * - `keys`: object's sorted key names only (environment, headers).
 * - `names`: array of strings, deduplicated and sorted (allowedEnvVars).
 * - `deep`: recursively key-sorted JSON value (tool input, plugin options).
 */
export type FieldMode = "value" | "keys" | "names" | "deep"

export interface FieldSpec {
  readonly field: string
  readonly mode?: FieldMode
}

// Hook handler fields that change execution. Display-only fields
// (`statusMessage`), lifecycle flags (`once`) and loader metadata
// (`__source`, `__sourceDir`) are excluded on purpose.
const HOOK_FIELDS: readonly FieldSpec[] = [
  { field: "type" },
  { field: "event" },
  { field: "matcher" },
  { field: "command" },
  { field: "args" },
  { field: "server" },
  { field: "tool" },
  { field: "input", mode: "deep" },
  { field: "url" },
  { field: "prompt" },
  { field: "headers", mode: "keys" },
  { field: "allowedEnvVars", mode: "names" },
  { field: "timeout", mode: "deep" },
  { field: "onFailure" },
  { field: "continueOnBlock" },
  { field: "model" },
  { field: "shell" },
  { field: "inputFormat" },
  { field: "if" },
  { field: "async" },
  { field: "asyncRewake" },
  { field: "options", mode: "deep" },
]

/** Explicit field list per entry category. */
export const CATEGORY_FIELDS: Record<TrustCategory, readonly FieldSpec[]> = {
  hook: HOOK_FIELDS,
  "skill-hook": HOOK_FIELDS,
  // Settings entries also carry the agent name: the same hook only runs inside
  // that agent, so moving it to another agent changes execution.
  "agent-hook": [...HOOK_FIELDS, { field: "agent" }],
  mcp: [
    { field: "type" },
    { field: "command" },
    { field: "cwd" },
    { field: "environment", mode: "keys" },
    { field: "url" },
    { field: "headers", mode: "keys" },
    { field: "timeout", mode: "deep" },
    { field: "disabled" },
  ],
  "command-shell": [{ field: "command" }],
  // `extensions` only decides when a formatter runs; the command and its
  // environment decide what runs.
  formatter: [{ field: "command" }, { field: "environment", mode: "keys" }, { field: "disabled" }],
  // `initialization` is sent to the server but does not change the local
  // process that is spawned.
  lsp: [{ field: "command" }, { field: "env", mode: "keys" }, { field: "disabled" }],
}

/** Pick the execution-relevant fields of one raw entry and normalize them. */
export function canonicalize(category: TrustCategory, raw: Record<string, unknown>): CanonicalObject {
  const result: CanonicalObject = {}
  for (const spec of CATEGORY_FIELDS[category]) {
    const value = normalizeField(raw[spec.field], spec.mode)
    if (value !== undefined) result[spec.field] = value
  }
  return result
}

/** Serialize a canonical value with recursively sorted object keys. */
export function canonicalJSON(value: CanonicalValue): string {
  return JSON.stringify(sortKeys(value))
}

/** Convert an arbitrary parsed JSON value into a canonical value. */
export function toCanonical(value: unknown): CanonicalValue | undefined {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : undefined
    case "object": {
      if (Array.isArray(value)) return value.map((item) => toCanonical(item) ?? null)
      if (!isRecord(value)) return undefined
      const result: CanonicalObject = {}
      for (const key of Object.keys(value).toSorted()) {
        const item = toCanonical(value[key])
        if (item !== undefined) result[key] = item
      }
      return result
    }
    default:
      return undefined
  }
}

function normalizeField(value: unknown, mode: FieldMode | undefined): CanonicalValue | undefined {
  if (value === undefined) return undefined
  switch (mode) {
    case "keys":
      return objectKeys(value)
    case "names":
      return sortedNames(value)
    case "deep":
    case "value":
    default:
      return toCanonical(value)
  }
}

function objectKeys(value: unknown): CanonicalValue | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).toSorted()
  return keys.length ? keys : undefined
}

function sortedNames(value: unknown): CanonicalValue | undefined {
  if (!Array.isArray(value)) return undefined
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return undefined
    strings.push(item)
  }
  const names = Array.from(new Set(strings)).toSorted()
  return names.length ? names : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sortKeys(value: CanonicalValue): CanonicalValue {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== "object") return value
  const result: CanonicalObject = {}
  for (const key of Object.keys(value).toSorted()) result[key] = sortKeys(value[key])
  return result
}
