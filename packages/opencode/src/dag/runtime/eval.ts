// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG conditional-node evaluation + input_mapping resolution (task 2.16).
 *
 * Pure helpers invoked at spawn time (before creating the child session):
 * - evaluateCondition: decides if a node should run or be skipped
 * - resolveInputMapping: collects upstream outputs into a variables map
 *
 * Both are synchronous — they receive the upstream outputs already loaded
 * by the scheduling layer.
 */

const CONDITION_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/

// Operand grammar. The left side is one dotted field path; the right side is a
// single quoted string literal or one bare token (number, true/false/null, or
// an unquoted word). `===`, `!==`, `&&`, `||` and chained comparisons still
// match CONDITION_RE but leave operator residue in an operand — `x !== "A"`
// lexes as `x != '= "A"'`, which is ALWAYS true — so they are rejected rather
// than evaluated.
const CONDITION_PATH_RE = /^[^\s"'=!<>&|]+$/
const CONDITION_VALUE_RE = /^(?:"[^"]*"|'[^']*'|[^\s"'=!<>&|]+)$/

const CONDITION_OPERATORS = ["==", "!=", ">=", "<=", ">", "<"] as const
type ConditionOperator = (typeof CONDITION_OPERATORS)[number]
const isConditionOperator = (value: string): value is ConditionOperator =>
  CONDITION_OPERATORS.some((op) => op === value)

function parseCondition(
  condition: string,
): { ok: true; lhs: string; op: ConditionOperator; rhs: string } | { ok: false; error: string } {
  const match = condition.match(CONDITION_RE)
  if (!match) return { ok: false, error: `condition unparseable: ${condition}` }
  const lhs = match[1].trim()
  const op = match[2]
  const rhs = match[3].trim()
  if (!isConditionOperator(op) || !CONDITION_PATH_RE.test(lhs) || !CONDITION_VALUE_RE.test(rhs)) {
    return {
      ok: false,
      error:
        `condition "${condition}" uses unsupported syntax: expected one comparison` +
        " `<node-id>.output.<field> <op> <value>` with op ==, !=, >, <, >= or <= and value a number," +
        " true/false/null, a bare word, or a quoted string (===, !==, && and || are not supported)",
    }
  }
  return { ok: true, lhs, op, rhs }
}

/** Why a non-empty condition cannot be evaluated, or undefined when it is
 * empty or well-formed. Acceptance-time validation rejects these so an
 * unsupported expression never reaches spawn-time routing. */
export function conditionSyntaxError(condition: string | undefined): string | undefined {
  if (!condition || condition.trim() === "") return undefined
  const parsed = parseCondition(condition)
  return parsed.ok ? undefined : parsed.error
}

/**
 * Evaluate a node's `condition` expression.
 *
 * The condition is a simple expression evaluated against upstream node outputs.
 * Supported syntax: `nodeID.output.field == value` or `nodeID.output.field > N`.
 *
 * Returns `{ ok: true, value }` — `value` is true (run the node) or false (skip).
 * Returns `{ ok: false, error }` when the expression cannot be parsed or uses
 * unsupported syntax (`===`, `!==`, `&&`, `||`), or when a numeric comparison's operand is not a number (missing field path, plain
 * text output) — the caller MUST fail the node rather than running or silently
 * skipping it on an unevaluable condition.
 *
 * @example
 * ```ts
 * evaluateCondition(
 *   "explore-src.output.findings_count > 0",
 *   { "explore-src": { output: { findings_count: 3 } } }
 * ) // → { ok: true, value: true }
 * ```
 */
export function evaluateCondition(
  condition: string | undefined,
  outputs: Record<string, unknown>,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (!condition || condition.trim() === "") return { ok: true, value: true }

  const parsed = parseCondition(condition)
  if (!parsed.ok) return parsed

  const op = parsed.op
  const lhs = resolvePath(parsed.lhs, outputs)
  const rhs = parseValue(parsed.rhs)

  // Numeric comparisons on non-numeric or non-finite operands (missing field
  // path, plain-text output, NaN, "Infinity" parsed by parseValue) must fail
  // the node loudly — the alternative is a silent condition_false skip that
  // cascades through required downstream nodes, the same failure mode
  // conditionReference guards against at create time.
  if (op === ">" || op === "<" || op === ">=" || op === "<=") {
    if (typeof lhs !== "number" || !Number.isFinite(lhs))
      return {
        ok: false,
        error: `condition "${condition}": left operand resolved to ${describeOperand(lhs)}, expected a finite number`,
      }
    if (typeof rhs !== "number" || !Number.isFinite(rhs))
      return {
        ok: false,
        error: `condition "${condition}": right operand ${describeOperand(rhs)} is not a finite number`,
      }
    if (op === ">") return { ok: true, value: lhs > rhs }
    if (op === "<") return { ok: true, value: lhs < rhs }
    if (op === ">=") return { ok: true, value: lhs >= rhs }
    return { ok: true, value: lhs <= rhs }
  }

  // parseCondition only produces the six operators; after the numeric block
  // only equality remains.
  if (op === "==") return { ok: true, value: lhs === rhs }
  return { ok: true, value: lhs !== rhs }
}

function describeOperand(value: unknown): string {
  if (value === undefined) return "undefined (field path not found)"
  if (value === null) return "null"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return `string "${value.length > 50 ? value.slice(0, 50) + "\u2026" : value}"`
  return typeof value
}

/**
 * NodeID referenced by a parseable condition's left-hand side, or null when
 * the condition is empty or unparseable. Used at create/replan time to reject
 * conditions referencing nodes outside `depends_on` — those would silently
 * resolve to undefined and evaluate false at spawn time (the worst failure
 * mode). Lexically lenient on purpose: malformed operands are reported by
 * conditionSyntaxError, and the runtime fails such a node loudly.
 */
export function conditionReference(condition: string | undefined): string | null {
  if (!condition || condition.trim() === "") return null
  const match = condition.match(CONDITION_RE)
  if (!match) return null
  return match[1].trim().split(".")[0] || null
}

export type InputMappingReference = {
  nodeID: string
  path: string[]
}

/** Parse the documented input_mapping source forms without inventing any
 * scheduling semantics: `node-id`, `node-id.output`, or a dotted path below
 * `node-id.output`. */
export function parseInputMappingReference(
  source: string,
): ({ ok: true } & InputMappingReference) | { ok: false; error: string } {
  if (source.length === 0) return { ok: false, error: "source is empty" }
  const parts = source.split(".")
  const nodeID = parts.shift()!
  if (!nodeID) return { ok: false, error: "source node id is empty" }
  if (parts.length === 0) return { ok: true, nodeID, path: [] }
  if (parts.shift() !== "output") return { ok: false, error: 'the first path segment must be "output"' }
  if (parts.some((part) => part.length === 0)) return { ok: false, error: "output path contains an empty segment" }
  return { ok: true, nodeID, path: parts }
}

/** `placeholder`: the source settled without output (an optional node that
 * failed, or a skipped/aborted node). Scheduling already lets such sources
 * unlock their dependents, so the variable receives this explicit text for
 * the whole source reference instead of failing the consumer. */
export type InputMappingOutput =
  | { found: true; output: unknown }
  | { found: false; placeholder?: string }

/** Strict execution-boundary resolution. Structural validation guarantees
 * ordering for new graphs; this result also protects resumed historical
 * configs and catches a declared field that is absent from durable output. */
export function resolveInputMappingChecked(
  mapping: Record<string, string> | undefined,
  getOutput: (nodeID: string) => InputMappingOutput,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!mapping) return { ok: true, value: {} }
  const value: Record<string, unknown> = {}
  for (const [variable, source] of Object.entries(mapping)) {
    const parsed = parseInputMappingReference(source)
    if (!parsed.ok) {
      return {
        ok: false,
        error: `input_mapping variable "${variable}" has invalid source "${source}": ${parsed.error}`,
      }
    }
    const resolved = getOutput(parsed.nodeID)
    if (!resolved.found && resolved.placeholder !== undefined) {
      value[variable] = resolved.placeholder
      continue
    }
    if (!resolved.found) {
      return {
        ok: false,
        error: `input_mapping variable "${variable}" source "${source}" has no durable output for node "${parsed.nodeID}"`,
      }
    }
    const output = resolveMappedOutput(resolved.output, parsed.path)
    if (output === undefined) {
      return {
        ok: false,
        error: `input_mapping variable "${variable}" source "${source}" resolved to undefined`,
      }
    }
    value[variable] = output
  }
  return { ok: true, value }
}

/**
 * Resolve an input_mapping into a variables map for prompt interpolation.
 *
 * input_mapping shape: `{ "varName": "nodeID.output" }`
 * Output shape: `{ "varName": <resolved value> }`
 *
 * @example
 * ```ts
 * resolveInputMapping(
 *   { core_diff: "refactor-core.output" },
 *   (nodeID) => nodes.find(n => n.id === nodeID)
 * ) // → { core_diff: <refactor-core's output> }
 * ```
 */
export function resolveInputMapping(
  mapping: Record<string, string> | undefined,
  getOutput: (nodeID: string) => unknown,
): Record<string, unknown> {
  if (!mapping) return {}
  const result: Record<string, unknown> = {}
  for (const [varName, ref] of Object.entries(mapping)) {
    const parsed = parseInputMappingReference(ref)
    if (!parsed.ok) {
      result[varName] = undefined
      continue
    }
    const base = getOutput(parsed.nodeID)
    result[varName] = resolveMappedOutput(base, parsed.path)
  }
  return result
}

// --------------------------------------------------------------------------

function resolveMappedOutput(output: unknown, path: readonly string[]): unknown {
  let current = output
  for (const part of path) {
    if (current == null) return undefined
    current = readProperty(current, part)
  }
  return current
}

function readProperty(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key)
}

function resolvePath(path: string, source: Record<string, unknown>): unknown {
  const parts = path.split(".")
  let current: unknown = source

  // If first part is a nodeID in source, start there
  if (parts[0] && parts[0] in source) {
    current = source[parts[0]]
    parts.shift()
  }

  for (const part of parts) {
    if (current == null) return undefined
    current = readProperty(current, part)
  }
  return current
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  const num = Number(trimmed)
  if (!isNaN(num)) return num
  // Strip quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
