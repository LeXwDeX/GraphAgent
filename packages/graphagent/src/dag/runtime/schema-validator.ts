// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A near-miss on a present field: the payload has the field, but its value is
 * outside the declared enum or has the wrong scalar type. Structural failures
 * (missing fields, unparseable payloads, extra keys, array items) carry no fix. */
export type SchemaValidationFix =
  | { kind: "enum"; path: string; allowed: string; got: string }
  | { kind: "type"; path: string; expected: string; got: string }

export type SchemaValidationResult = { ok: true } | { ok: false; error: string; fix?: SchemaValidationFix }

// Pure JSON Schema subset. Production runs this entire computation in a bounded Worker.
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: readonly string[] = [],
): SchemaValidationResult {
  // JSON Schema allows `type` to be a single name or an array of names
  // (nullable/union types like ["string","null"]) — the value must match one.
  const type = schema["type"]
  const declared =
    typeof type === "string"
      ? [type]
      : Array.isArray(type)
        ? type.filter((t): t is string => typeof t === "string")
        : []
  if (declared.length > 0 && !declared.some((t) => matchesScalarType(value, t)))
    return {
      ok: false,
      error: `expected type ${declared.length === 1 ? `"${declared[0]}"` : JSON.stringify(declared)}, got ${describeType(value)}`,
      ...(path.length > 0
        ? {
            fix: {
              kind: "type" as const,
              path: path.join("."),
              expected: `type ${declared.length === 1 ? `"${declared[0]}"` : JSON.stringify(declared)}`,
              got: describeType(value),
            },
          }
        : {}),
    }

  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema["const"]))
    return {
      ok: false,
      error: `expected const ${truncate(JSON.stringify(schema["const"]))}, got ${truncate(JSON.stringify(value))}`,
    }

  const enumVals = schema["enum"]
  if (Array.isArray(enumVals) && !enumVals.some((v) => deepEqual(value, v)))
    return {
      ok: false,
      error: `expected one of ${truncate(JSON.stringify(enumVals))}, got ${truncate(JSON.stringify(value))}`,
      ...(path.length > 0
        ? {
            fix: {
              kind: "enum" as const,
              path: path.join("."),
              allowed: truncate(JSON.stringify(enumVals)),
              got: truncate(JSON.stringify(value)),
            },
          }
        : {}),
    }

  if (typeof value === "number") {
    const minimum = schema["minimum"]
    if (typeof minimum === "number" && value < minimum)
      return { ok: false, error: `expected minimum ${minimum}, got ${value}` }
    const maximum = schema["maximum"]
    if (typeof maximum === "number" && value > maximum)
      return { ok: false, error: `expected maximum ${maximum}, got ${value}` }
    const exclusiveMinimum = schema["exclusiveMinimum"]
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum)
      return { ok: false, error: `expected exclusiveMinimum ${exclusiveMinimum}, got ${value}` }
    const exclusiveMaximum = schema["exclusiveMaximum"]
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum)
      return { ok: false, error: `expected exclusiveMaximum ${exclusiveMaximum}, got ${value}` }
  }

  if (typeof value === "string") {
    const minLength = schema["minLength"]
    if (typeof minLength === "number" && value.length < minLength)
      return { ok: false, error: `expected minLength ${minLength}, got length ${value.length}` }
    const maxLength = schema["maxLength"]
    if (typeof maxLength === "number" && value.length > maxLength)
      return { ok: false, error: `expected maxLength ${maxLength}, got length ${value.length}` }
    const pattern = schema["pattern"]
    if (typeof pattern === "string" && value.length > REGEX_TEST_MAX_CHARS)
      return {
        ok: false,
        error: `pattern validation is capped at ${REGEX_TEST_MAX_CHARS} characters, got ${value.length}`,
      }
    if (typeof pattern === "string" && !safeRegexTest(pattern, value))
      return { ok: false, error: `expected value to match pattern ${pattern}` }
  }

  if (Array.isArray(value)) {
    const minItems = schema["minItems"]
    if (typeof minItems === "number" && value.length < minItems)
      return { ok: false, error: `expected minItems ${minItems}, got ${value.length}` }
    const maxItems = schema["maxItems"]
    if (typeof maxItems === "number" && value.length > maxItems)
      return { ok: false, error: `expected maxItems ${maxItems}, got ${value.length}` }
    if (schema["uniqueItems"] === true) {
      // #349/CAP-02: the pairwise deepEqual scan is O(n²); model outputs
      // with more items than this are pathological — fail loudly instead of
      // burning the validation path.
      if (value.length > UNIQUE_ITEMS_MAX) {
        return {
          ok: false,
          error: `uniqueItems validation is capped at ${UNIQUE_ITEMS_MAX} items, got ${value.length}`,
        }
      }
      const duplicate = value.findIndex((item, index) => value.slice(0, index).some((prev) => deepEqual(prev, item)))
      if (duplicate !== -1) return { ok: false, error: `expected uniqueItems, found duplicate at index ${duplicate}` }
    }
  }

  // #346: object-semantic keywords imply an object value even without an
  // explicit `type: "object"` — `{required, properties}` without a type is a
  // fully legal, common JSON Schema spelling, and a non-object value used to
  // skip the whole group silently (ok:true). A bare string could then slip
  // past a gated checkpoint's declared schema and resolve no fields
  // downstream (the DAG-01 consequence hiding inside the schema spelling).
  const hasRequired = Array.isArray(schema["required"])
  const hasProperties = isSchemaObject(schema["properties"])
  const hasAdditionalProperties =
    Object.hasOwn(schema, "additionalProperties") &&
    (typeof schema["additionalProperties"] === "boolean" || isSchemaObject(schema["additionalProperties"]))
  if ((hasRequired || hasProperties || hasAdditionalProperties) && !isSchemaObject(value)) {
    const keywords = [
      hasRequired && "required",
      hasProperties && "properties",
      hasAdditionalProperties && "additionalProperties",
    ]
      .filter(Boolean)
      .join("/")
    return { ok: false, error: `schema constrains object fields (${keywords}) but the value is ${describeType(value)}` }
  }

  const required = schema["required"]
  if (Array.isArray(required) && isSchemaObject(value)) {
    for (const field of required) {
      if (typeof field === "string" && !Object.hasOwn(value, field))
        return { ok: false, error: `missing required field: "${field}"` }
    }
  }

  const properties = schema["properties"]
  const narrowedProperties = isSchemaObject(properties) ? properties : undefined
  if (narrowedProperties !== undefined && isSchemaObject(value)) {
    for (const [key, propSchema] of Object.entries(narrowedProperties)) {
      if (Object.hasOwn(value, key) && isSchemaObject(propSchema)) {
        const result = validateAgainstSchema(value[key], propSchema, [...path, key])
        if (!result.ok)
          return { ok: false, error: `field "${key}": ${result.error}`, ...(result.fix ? { fix: result.fix } : {}) }
      }
    }
  }

  // #346: `additionalProperties: false` fences the value's keys against the
  // declared properties even when `properties` itself is absent (an empty
  // allowed set) — previously the check was nested inside the properties
  // branch and never ran for this spelling.
  if (schema["additionalProperties"] === false && isSchemaObject(value)) {
    const allowed: Record<string, unknown> = narrowedProperties ?? {}
    const extra = Object.keys(value).find((key) => !Object.hasOwn(allowed, key))
    if (extra !== undefined) return { ok: false, error: `unexpected additional property: "${extra}"` }
  }

  const items = schema["items"]
  if (Array.isArray(value) && isSchemaObject(items)) {
    for (let i = 0; i < value.length; i++) {
      const result = validateAgainstSchema(value[i], items)
      if (!result.ok) return { ok: false, error: `item[${i}]: ${result.error}` }
    }
  }

  return { ok: true }
}

/**
 * Keywords this subset validator enforces. Anything else present in an
 * output_schema is silently inert at runtime — surface it at workflow
 * create/replan time via unsupportedSchemaKeywords so authors aren't misled.
 */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "additionalProperties",
  // Annotations with no validation semantics — harmless, don't warn.
  "title",
  "description",
  "default",
  "examples",
  "$schema",
])

export function unsupportedSchemaKeywords(schema: Record<string, unknown>): string[] {
  const found = new Set<string>()
  const visit = (node: Record<string, unknown>) => {
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) found.add(key)
    }
    // Only the boolean `false` form is enforced; the schema form is inert.
    if (isSchemaObject(node["additionalProperties"])) found.add("additionalProperties (schema form)")
    const properties = node["properties"]
    if (isSchemaObject(properties)) {
      for (const child of Object.values(properties)) {
        if (isSchemaObject(child)) visit(child)
      }
    }
    const items = node["items"]
    if (isSchemaObject(items)) visit(items)
    // Tuple form items:[...] is not enforced by the validator either — flag it
    // and still descend so nested unsupported keywords surface.
    if (Array.isArray(items)) {
      found.add("items (tuple form)")
      for (const child of items) {
        if (isSchemaObject(child)) visit(child)
      }
    }
  }
  visit(schema)
  return [...found].sort()
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matchesScalarType(value: unknown, type: string): boolean {
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value)
  if (type === "array") return Array.isArray(value)
  if (type === "string") return typeof value === "string"
  if (type === "number") return typeof value === "number"
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "null") return value === null
  // #346: an unrecognized type name is a schema authoring error (e.g. a
  // misspelled "strng") — the old permissive pass accepted ANY value for it.
  return false
}

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number" && !Number.isInteger(value)) return "non-integer number"
  return typeof value
}

// Schema patterns come from workflow config; a malformed regex must not crash
// validation, it just fails the constraint.
// Reject oversize pattern inputs rather than validating a prefix and accepting
// an unchecked suffix. The cap bounds input size, not regex execution time:
// pathological patterns can still backtrack within the accepted size (#349).
const REGEX_TEST_MAX_CHARS = 100_000
// #349/CAP-02: bound for the O(n²) uniqueItems pairwise scan.
const UNIQUE_ITEMS_MAX = 1_000
function safeRegexTest(pattern: string, value: string): boolean {
  if (value.length > REGEX_TEST_MAX_CHARS) return false
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

function truncate(text: string | undefined): string {
  if (text === undefined) return "undefined"
  if (text.length <= 200) return text
  return text.slice(0, 200) + "\u2026"
}

// Structural equality for JSON values (const/enum come from workflow config
// JSON, so no cycles). JSON.stringify comparison is unreliable: key order.
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (!isSchemaObject(a) || !isSchemaObject(b)) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
}
