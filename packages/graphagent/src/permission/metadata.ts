// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

type Json = null | string | boolean | number | Json[] | { [key: string]: Json }

const CIRCULAR = "[Circular]"

/**
 * The `metadata` of a pending permission request in the form JSON can carry (#1557).
 *
 * A tool fills `metadata` for the dialog it raises (paths, a diff, the call's arguments) and for rules that read it
 * (the safety list reads `files[].movePath`). `GET /permission` lists every pending request of the instance in one
 * response, encoded as strict JSON, which rejects an `undefined` anywhere in a value: an omitted optional argument
 * copied in as `timeout: params.timeout`, a `movePath: change.movePath` on a file that is not moved. One such request
 * failed the encoding of the whole list, so every session's pending requests became unreadable until it was answered.
 * The request is stored in this form once, where it is created, so what a tool writes into `metadata` cannot do that.
 *
 * The result is what `JSON.parse(JSON.stringify(metadata))` gives, except that it never throws: a bigint becomes its
 * digits and a cycle becomes `"[Circular]"`. An `undefined` property is dropped and an `undefined` array slot becomes
 * `null`, so positions hold.
 */
export function jsonMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return jsonRecord(metadata, new Set([metadata]))
}

/** `undefined` for a value JSON cannot carry at all (`undefined`, a function, a symbol): its holder drops it. */
function jsonValue(value: unknown, parents: Set<object>): Json | undefined {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : null
    case "bigint":
      return value.toString()
    case "object":
      return jsonObject(value, parents)
    default:
      return undefined
  }
}

/** `parents` holds the objects being converted above this one, which tells a cycle from a value that is only shared. */
function jsonObject(value: object, parents: Set<object>): Json | undefined {
  if (parents.has(value)) return CIRCULAR
  parents.add(value)
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === "function") return jsonValue(toJSON.call(value), parents)
    if (Array.isArray(value)) return Array.from(value, (item) => jsonValue(item, parents) ?? null)
    return jsonRecord(value, parents)
  } finally {
    parents.delete(value)
  }
}

function jsonRecord(value: object, parents: Set<object>): { [key: string]: Json } {
  // `fromEntries` defines own properties, so a `__proto__` key stays a key instead of replacing the prototype.
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const json = jsonValue(item, parents)
      return json === undefined ? [] : [[key, json]]
    }),
  )
}
