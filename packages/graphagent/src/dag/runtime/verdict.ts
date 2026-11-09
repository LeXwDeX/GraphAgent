// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Option, Schema } from "effect"

const parseJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
// One Markdown code fence around the whole output. Two backticks are accepted
// too: the prompt sanitizer rewrites ``` to `` in mapped dependency outputs.
const CODE_FENCE = /^`{2,}[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?`{2,}$/

/**
 * The structured view of a durable node output shared by condition gates,
 * checkpoint verdicts, and review contracts. A schemaless child may complete
 * with a JSON string, optionally wrapped in one code fence; it parses to its
 * value. Any other output is returned unchanged.
 */
export function normalizeOutput(output: unknown): unknown {
  if (typeof output !== "string") return output
  const trimmed = output.trim()
  const fenced = CODE_FENCE.exec(trimmed)
  return Option.getOrElse(parseJsonOption(fenced ? fenced[1] : trimmed), () => output)
}

/** Upper-cased `verdict` field of a normalized object output, if present. */
export function verdictField(output: unknown): string | undefined {
  const value = normalizeOutput(output)
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("verdict" in value)) return undefined
  return typeof value.verdict === "string" ? value.verdict.trim().toUpperCase() : undefined
}

/** Verdicts that make a completed gate node a failed required node. Review
 * decisions are excluded by the caller: REJECT/BLOCKED there are reopenable
 * outcomes, not workflow failures. */
const FAILING_GATE_VERDICTS = new Set(["FAIL", "BLOCKING", "BLOCKED", "INCOMPLETE"])

/** The failing gate verdict of a normalized output, if present. Structured
 * `{ verdict }` objects always count. A plain scalar (`"FAIL"`) counts only
 * when the caller identifies an explicit verdict contract; ordinary task data
 * must not be reinterpreted as a gate verdict. */
export function failingGateVerdict(
  output: unknown,
  options: { readonly allowScalar?: boolean; readonly parseString?: boolean } = {},
): string | undefined {
  // A string declared as ordinary data must never be parsed as JSON: text such
  // as `{"verdict":"FAIL"}` is the node's answer, not a gate contract.
  if (typeof output === "string" && options.parseString === false) {
    if (!options.allowScalar) return undefined
    const scalar = output.trim().toUpperCase()
    return FAILING_GATE_VERDICTS.has(scalar) ? scalar : undefined
  }
  const value = normalizeOutput(output)
  const verdict = typeof value === "string" ? (options.allowScalar ? value.trim().toUpperCase() : undefined) : verdictField(value)
  return verdict && FAILING_GATE_VERDICTS.has(verdict) ? verdict : undefined
}

export * as DagVerdict from "./verdict"
