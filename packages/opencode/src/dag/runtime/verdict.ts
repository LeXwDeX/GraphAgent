// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Option, Schema } from "effect"

const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
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

export * as DagVerdict from "./verdict"
