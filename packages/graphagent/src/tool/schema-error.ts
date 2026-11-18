// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema, SchemaAST, SchemaIssue } from "effect"
import { ToolError } from "./tool-error"

export interface SchemaFailure {
  path: string
  kind: "missing" | "unexpected" | "invalid" | "type"
  /** What the schema accepts at `path`, read from the schema and never from the input. */
  expected?: string
}

const MAX_PATH = 80
const MAX_VISITS = 200
const DESCRIBE_LIMIT = 4
const DESCRIBE_MAX_CHARS = 480

const formatPath = (path: ReadonlyArray<PropertyKey>) => {
  const text = path
    .map((key) => {
      if (typeof key === "number") return `[${key}]`
      const name = typeof key === "symbol" ? String(key) : key
      return `[${JSON.stringify(name)}]`
    })
    .join("")
  return (text || "(root)").slice(0, MAX_PATH)
}

/**
 * Extract the model-supplied action from either envelope. Only a short string
 * is returned; this deliberately never exposes argument values.
 */
export function argumentAction(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined
  const params = Reflect.get(args, "params")
  const nested =
    typeof params === "object" && params !== null && !Array.isArray(params) ? Reflect.get(params, "action") : undefined
  const action = Reflect.get(args, "action") ?? nested
  return typeof action === "string" && action.length <= 32 ? action : undefined
}

const PRIMITIVE_NAMES: Partial<Record<SchemaAST.AST["_tag"], string>> = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Null: "null",
  Arrays: "array",
  Objects: "object",
}

/** Members of a union with nested unions flattened and `undefined` (an optional wrapper) dropped. */
function unionMembers(ast: SchemaAST.Union): SchemaAST.AST[] {
  return ast.types.flatMap((member) => {
    if (member._tag === "Union") return unionMembers(member)
    return member._tag === "Undefined" ? [] : [member]
  })
}

/**
 * What a schema node accepts, in a few words, or undefined when it cannot be
 * described briefly. Reads only the schema, so it never exposes input values.
 */
function expectedOf(ast: SchemaAST.AST): string | undefined {
  if (ast._tag === "Literal") return typeof ast.literal === "bigint" ? undefined : JSON.stringify(ast.literal)
  if (ast._tag !== "Union") return PRIMITIVE_NAMES[ast._tag]
  const members = unionMembers(ast)
  const literals = members.flatMap((member) =>
    member._tag === "Literal" && typeof member.literal !== "bigint" ? [member.literal] : [],
  )
  if (members.length > 0 && literals.length === members.length) return ToolError.oneOf(literals)
  const names = members.map(expectedOf)
  if (names.length === 0 || names.some((name) => name === undefined)) return undefined
  return Array.from(new Set(names)).join(" or ")
}

/** The schema type of the struct field a pointer names, when the parent is a struct and the key is one of its fields. */
function fieldType(parent: SchemaAST.AST | undefined, keys: ReadonlyArray<PropertyKey>): SchemaAST.AST | undefined {
  if (parent?._tag !== "Objects" || keys.length !== 1) return undefined
  return parent.propertySignatures.find((signature) => signature.name === keys[0])?.type
}

/**
 * Summarize a failed schema decode without including the input. The summary is
 * a short list of failing paths and failure kinds, never values or a union
 * dump. `expected` comes from the schema (a literal set, a type name or a
 * check's own description), so it is as safe to show as the path.
 */
export function schemaFailures(error: unknown, limit = 2): SchemaFailure[] {
  if (!Schema.isSchemaError(error)) return []
  const found: SchemaFailure[] = []
  let visits = 0

  const push = (path: ReadonlyArray<PropertyKey>, kind: SchemaFailure["kind"], expected?: string) => {
    if (found.length >= limit) return
    const item: SchemaFailure =
      expected === undefined ? { path: formatPath(path), kind } : { path: formatPath(path), kind, expected }
    if (!found.some((existing) => existing.path === item.path && existing.kind === item.kind)) found.push(item)
  }

  const visit = (
    issue: SchemaIssue.Issue,
    path: ReadonlyArray<PropertyKey>,
    parent?: SchemaAST.AST,
    field?: SchemaAST.AST,
    hint?: string,
  ) => {
    if (found.length >= limit || visits++ >= MAX_VISITS) return
    switch (issue._tag) {
      case "Pointer":
        return visit(
          issue.issue,
          [
            ...path,
            ...issue.path.map((key, index) =>
              typeof key === "number" ||
              (index === 0 &&
                parent?._tag === "Objects" &&
                parent.propertySignatures.some((signature) => signature.name === key))
                ? key
                : "<key>",
            ),
          ],
          undefined,
          fieldType(parent, issue.path),
        )
      case "Encoding":
        return visit(issue.issue, path, issue.ast)
      case "Filter":
        return visit(issue.issue, path, parent, field, issue.filter.annotations?.expected)
      case "Composite":
      case "AnyOf":
        if (issue._tag === "AnyOf" && issue.issues.length === 0) return push(path, "invalid", expectedOf(issue.ast))
        for (const child of issue.issues) {
          if (found.length >= limit) break
          visit(child, path, issue.ast)
        }
        return
      case "MissingKey":
        return push(path, "missing", field && expectedOf(field))
      case "UnexpectedKey":
        return push([...path.slice(0, -1), "<unexpected>"], "unexpected")
      case "InvalidType":
        return push(path, "type", expectedOf(issue.ast))
      case "InvalidValue":
      case "Forbidden":
        return push(path, "invalid", hint)
    }
  }

  visit(error.issue, [])
  return found
}

const KIND = {
  missing: "missing required field",
  unexpected: "unexpected field",
  invalid: "invalid value",
  type: "wrong type",
} as const

const actionNames: Record<string, string> = {
  send: '"send"',
  receive: '"receive"',
  observe: '"observe"',
  extend_timeout: '"extend_timeout"',
}

/** A bounded one-line failure summary; empty when the error is not a schema error. */
export function formatSchemaFailures(error: unknown, limit = 2, action?: string): string {
  const text = schemaFailures(error, limit)
    .map((failure) => `${failure.path} ${KIND[failure.kind]}`)
    .join("; ")
    .slice(0, 240)
  // A union with no branch diagnostics fails at the discriminator. Naming the
  // attempted action is more actionable than the bare union path.
  if (!action || text !== '["params"] invalid value') return text
  const name = Object.hasOwn(actionNames, action) ? ` ${actionNames[action]}` : ""
  return `["params"]["action"]${name} is not valid`
}

/**
 * The failure summary the model reads when a tool without its own formatter
 * rejects arguments: up to four `<path> <kind>, expected <what is accepted>`
 * entries, bounded, never the input. Empty when the error is not a schema error.
 */
export function describeSchemaFailures(error: unknown): string {
  const text = schemaFailures(error, DESCRIBE_LIMIT)
    .map(
      (failure) => `${failure.path} ${KIND[failure.kind]}${failure.expected ? `, expected ${failure.expected}` : ""}`,
    )
    .join("; ")
  return Array.from(text).slice(0, DESCRIBE_MAX_CHARS).join("")
}

export const bound = (text: string, max = 600) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export * as SchemaError from "./schema-error"
