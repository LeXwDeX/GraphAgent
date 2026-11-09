// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema, SchemaAST, SchemaIssue } from "effect"

export interface SchemaFailure {
  path: string
  kind: "missing" | "unexpected" | "invalid" | "type"
}

const MAX_PATH = 80
const MAX_VISITS = 200

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

/**
 * Summarize a failed schema decode without including the input. The summary is
 * a short list of failing paths and failure kinds, never values or a union
 * dump.
 */
export function schemaFailures(error: unknown, limit = 2): SchemaFailure[] {
  if (!Schema.isSchemaError(error)) return []
  const found: SchemaFailure[] = []
  let visits = 0

  const push = (path: ReadonlyArray<PropertyKey>, kind: SchemaFailure["kind"]) => {
    if (found.length >= limit) return
    const item = { path: formatPath(path), kind }
    if (!found.some((existing) => existing.path === item.path && existing.kind === item.kind)) found.push(item)
  }

  const visit = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>, parent?: SchemaAST.AST) => {
    if (found.length >= limit || visits++ >= MAX_VISITS) return
    switch (issue._tag) {
      case "Pointer":
        return visit(issue.issue, [
          ...path,
          ...issue.path.map((key, index) =>
            typeof key === "number" ||
            (index === 0 && parent?._tag === "Objects" && parent.propertySignatures.some((field) => field.name === key))
              ? key
              : "<key>",
          ),
        ])
      case "Encoding":
        return visit(issue.issue, path, issue.ast)
      case "Filter":
        return visit(issue.issue, path, parent)
      case "Composite":
      case "AnyOf":
        if (issue._tag === "AnyOf" && issue.issues.length === 0) return push(path, "invalid")
        for (const child of issue.issues) {
          if (found.length >= limit) break
          visit(child, path, issue.ast)
        }
        return
      case "MissingKey":
        return push(path, "missing")
      case "UnexpectedKey":
        return push([...path.slice(0, -1), "<unexpected>"], "unexpected")
      case "InvalidType":
        return push(path, "type")
      case "InvalidValue":
      case "Forbidden":
        return push(path, "invalid")
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

export const bound = (text: string, max = 600) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export * as SchemaError from "./schema-error"
