// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Stand-in values for template inputs (#1073).
 *
 * `spec list`, `spec read`, and the template CI judge a template on its own,
 * before any caller supplied a value. A required input then gets a stand-in. A
 * stand-in of the declared type alone is not enough: a field can take only some
 * values of its type, and a template whose real callers pass valid values must
 * not be judged unstartable because its stand-in broke a constraint on the
 * value (a strict writer needs 1-50 acceptance items; `review_gate` allows two
 * strings). So a stand-in follows the field it fills: this module reads the
 * start document's own schema and returns the smallest value that field accepts.
 *
 * What this cannot know stays with the type sample: a constraint no schema states
 * (an absolute path, a reference to a block of the same document) still needs a
 * default on the input for the template to be judged with it.
 */

import { Schema } from "effect"
import { isRecord } from "@/util/record"
import { DagValidation } from "./validation"

type Json = Readonly<Record<string, unknown>>

interface Document {
  readonly root: unknown
  readonly definitions: Readonly<Record<string, unknown>>
}

/** The start document's schema, built on first use: it is only needed when a
 * required input is a stand-in, which is rare. A schema that cannot be built
 * leaves every stand-in at its type sample. */
let cached: Document | null | undefined
function startDocument(): Document | undefined {
  if (cached === undefined) {
    try {
      const built = Schema.toJsonSchemaDocument(DagValidation.StartSpec)
      cached = { root: built.schema, definitions: built.definitions }
    } catch {
      cached = null
    }
  }
  return cached ?? undefined
}

const MAX_DEPTH = 8

/** Follow `$ref` to the definition it names. */
function dereference(schema: unknown, definitions: Document["definitions"], depth = 0): unknown {
  if (!isRecord(schema) || typeof schema.$ref !== "string" || depth > MAX_DEPTH) return schema
  return dereference(definitions[schema.$ref.replace(/^#\/\$defs\//, "")], definitions, depth + 1)
}

/** The alternatives of a union, flattened and resolved, without the `null` an
 * optional field also encodes. A schema that is not a union is its own single
 * alternative. */
function alternatives(schema: unknown, definitions: Document["definitions"], depth = 0): Json[] {
  const resolved = dereference(schema, definitions)
  if (!isRecord(resolved) || depth > MAX_DEPTH) return []
  const members = Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : undefined
  const flat =
    members === undefined ? [resolved] : members.flatMap((member) => alternatives(member, definitions, depth + 1))
  return flat.filter((option) => option.type !== "null")
}

/** The schema of one step down: a property of an object, or the items of a list. */
function descend(schema: unknown, segment: string | number, definitions: Document["definitions"]): unknown {
  for (const option of alternatives(schema, definitions)) {
    if (typeof segment === "number") {
      if (option.type === "array" && option.items !== undefined) return option.items
    } else if (isRecord(option.properties) && segment in option.properties) {
      return option.properties[segment]
    }
  }
  return undefined
}

/** Whether a list's items are objects or enumerated values: the kind of list a
 * rule can require to be non-empty. */
function structured(items: unknown, definitions: Document["definitions"]): boolean {
  const first = alternatives(items, definitions)[0]
  return first !== undefined && (first.type === "object" || "const" in first || Array.isArray(first.enum))
}

function sampleOne(option: Json, definitions: Document["definitions"], depth: number): unknown {
  if ("const" in option) return option.const
  if (Array.isArray(option.enum) && option.enum.length > 0) return option.enum[0]
  if (option.type === "string") return "sample"
  if (option.type === "number" || option.type === "integer")
    return typeof option.minimum === "number" ? option.minimum : 1
  if (option.type === "boolean") return false
  if (option.type === "array") {
    // One element where the field takes objects or enumerated values. A list of
    // plain strings or numbers stays empty: such items are usually references,
    // and any element would name something that is not there.
    const element = sample(option.items, definitions, depth + 1)
    return element !== undefined && structured(option.items, definitions) ? [element] : []
  }
  if (option.type === "object") {
    const properties = isRecord(option.properties) ? option.properties : {}
    const required = Array.isArray(option.required) ? option.required : []
    return Object.fromEntries(
      required.flatMap((name) => {
        if (typeof name !== "string") return []
        const value = sample(properties[name], definitions, depth + 1)
        return value === undefined ? [] : [[name, value]]
      }),
    )
  }
  return undefined
}

function sample(schema: unknown, definitions: Document["definitions"], depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined
  for (const option of alternatives(schema, definitions)) {
    const value = sampleOne(option, definitions, depth)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * The smallest value the start document accepts at `trail` (object keys and list
 * indexes from the document root), or `undefined` when the path is not a field
 * of it or its schema says nothing usable.
 */
export function sampleAt(trail: readonly (string | number)[]): unknown {
  const document = startDocument()
  if (document === undefined) return undefined
  let current: unknown = document.root
  for (const segment of trail) {
    current = descend(current, segment, document.definitions)
    if (current === undefined) return undefined
  }
  return sample(current, document.definitions)
}

export * as DagTemplateSample from "./template-sample"
