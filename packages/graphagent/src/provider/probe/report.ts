// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ProviderRedact } from "../redact"
import type { ProbeFindings } from "./findings"
import { ProbePlan } from "./plan"

/**
 * The two things the probe prints: the report (one line per finding, for the person running it) and the snippet
 * (the configuration that follows from the findings, for pasting). Everything the command prints goes through
 * `redact` first.
 */

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Replace every credential text with the redaction marker, the longest first so a secret that contains another is
 * not left half visible. The matching is literal, in one pass, and text that is already marked is not touched
 * again, so redacting twice gives the same text as redacting once.
 */
export function redact(text: string, secrets: readonly string[]): string {
  const list = [...new Set(secrets.filter((secret) => secret !== ""))].sort((a, b) => b.length - a.length)
  if (list.length === 0) return text
  const pattern = new RegExp(list.map(escapePattern).join("|"), "g")
  return text
    .split(ProviderRedact.REDACTED)
    .map((part) => part.replace(pattern, ProviderRedact.REDACTED))
    .join(ProviderRedact.REDACTED)
}

/**
 * Evidence as one clean line. The order matters: redact first, on the original text, and only then cut, since a
 * cut through the middle of a credential would leave a prefix that no longer matches it.
 */
function oneLine(text: string, secrets: readonly string[]): string {
  const clean = redact(text, secrets)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
  const max = ProbePlan.EVIDENCE_MAX
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function contextResult(context: ProbeFindings.ContextFinding): string {
  return context.status === "found" && context.tokens !== undefined ? `found (${context.tokens})` : context.status
}

function finishReasonsResult(reasons: readonly string[], secrets: readonly string[]): string {
  if (reasons.length === 0) return "none"
  return reasons
    .map((reason) => {
      const shown = oneLine(reason, secrets)
      return ProbePlan.KNOWN_FINISH_REASONS.includes(reason) ? shown : `${shown} (unknown)`
    })
    .join(", ")
}

/**
 * One line per finding, in the order context, usage, tool_call, reasoning_field, replay, finish_reasons, with three
 * columns aligned by spaces: the name, the result and the evidence behind it. A failed item shows its reason code
 * and the error text, a skipped one its reason code. The reasoning line also shows the model's configured
 * `interleaved`, so the measured field can be checked against the one the engine would replay it under.
 */
export function render(findings: ProbeFindings.Findings, ctx: ProbePlan.Context): string[] {
  const evidence = (field: string) => oneLine(findings.evidence[field] ?? "", ctx.secrets)
  const interleaved = `interleaved: ${JSON.stringify(ctx.interleaved)}`
  const rows: Array<[string, string, string]> = [
    ["context", contextResult(findings.context), evidence("context")],
    ["usage", findings.usage, evidence("usage")],
    ["tool_call", findings.toolCall, evidence("toolCall")],
    [
      "reasoning_field",
      findings.reasoningField,
      [evidence("reasoningField"), interleaved].filter((part) => part !== "").join("; "),
    ],
    ["replay", findings.replay, evidence("replay")],
    ["finish_reasons", finishReasonsResult(findings.finishReasons, ctx.secrets), evidence("finishReasons")],
  ]
  const nameWidth = Math.max(...rows.map(([name]) => name.length))
  const resultWidth = Math.max(...rows.map(([, result]) => result.length))
  return rows.map(([name, result, note]) =>
    `${name.padEnd(nameWidth)}  ${result.padEnd(resultWidth)}  ${note}`.trimEnd(),
  )
}

export interface SnippetModel {
  limit?: { context: number }
  reasoning?: true
  interleaved?: { field: ProbePlan.ReasoningField }
  profile?: { reasoning_mode: { replay: "field" | "none" } }
}

/** A configuration fragment, ready to merge into `graphagent.json`. */
export interface Snippet {
  provider: Record<string, { models: Record<string, SnippetModel> }>
}

/**
 * The configuration the findings back, under `provider.<providerID>.models.<modelID>`, and nothing else: the
 * measured window (`limit.context`, never `limit.output`), `reasoning` when a reasoning field was seen, and the
 * reasoning replay requirement when the endpoint answered it. `required` writes the profile's `replay: "field"` and
 * `interleaved: { field }` with the measured field, because the engine replays reasoning under the model's
 * `interleaved` field and does not read the profile's replay setting; `interleaved` is left out when no field was
 * measured. `rejected` writes `replay: "none"` and no `interleaved`: the snippet reports what the endpoint answered
 * and leaves the model's own `interleaved` alone, so an `interleaved: false` (which the configuration accepts) is for
 * the user to add where that default would still send the field. `accepted` says nothing about what the engine
 * should do, so it writes nothing. A finding without a conclusion has no key, so a probe that learned nothing yields
 * an empty model entry.
 */
export function snippet(findings: ProbeFindings.Findings, ctx: ProbePlan.Context): Snippet {
  const { context, reasoningField, replay } = findings
  const field = ProbePlan.REASONING_FIELDS.find((name) => name === reasoningField)
  const model: SnippetModel = {
    ...(context.status === "found" && context.tokens !== undefined ? { limit: { context: context.tokens } } : {}),
    ...(field !== undefined ? { reasoning: true } : {}),
    ...(replay === "required" && field !== undefined ? { interleaved: { field } } : {}),
    ...(replay === "required" ? { profile: { reasoning_mode: { replay: "field" } } } : {}),
    ...(replay === "rejected" ? { profile: { reasoning_mode: { replay: "none" } } } : {}),
  }
  return { provider: { [ctx.providerID]: { models: { [ctx.modelID]: model } } } }
}

export * as ProbeReport from "./report"
