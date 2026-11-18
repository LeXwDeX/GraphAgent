// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagCompletionGate from "./completion-gate"

import { isRecord } from "@/util/record"
import { failingGateVerdict, verdictField } from "./runtime/verdict"
import type { WorkflowConfig } from "./dag"

export class ReviewGateError extends Error {
  readonly dagID: string
  readonly reviewIDs: string[]

  constructor(dagID: string, reviewIDs: string[]) {
    super(`Cannot complete workflow ${dagID}: unresolved review outcome(s): ${reviewIDs.join(", ")}`)
    this.name = "ReviewGateError"
    this.dagID = dagID
    this.reviewIDs = reviewIDs
  }
}

/** Required work that ended without a usable result: a deliberate bad verdict
 * or an unaccepted skip. Kept separate from the review gate so explicit
 * completion reports both causes precisely. */
export class CompletionGateError extends Error {
  readonly dagID: string
  readonly gaps: string[]

  constructor(dagID: string, gaps: string[]) {
    super(`Cannot complete workflow ${dagID}: required node(s) did not complete: ${gaps.join(", ")}`)
    this.name = "CompletionGateError"
    this.dagID = dagID
    this.gaps = gaps
  }
}

interface CompletionNode {
  readonly id: string
  readonly status: string
  readonly required: boolean
  readonly output: unknown
  readonly errorReason: string | null
  /** #944: a completed node whose target changed under it cannot gate completion. */
  readonly staleTarget?: boolean | null
}

function declaresVerdictContract(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false
  const properties = schema.properties
  const required = schema.required
  return (
    (typeof properties === "object" && properties !== null && "verdict" in properties)
    || (Array.isArray(required) && required.includes("verdict"))
  )
}

/** A schema whose accepted values include a string must keep string output as data. */
function schemaAllowsString(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false
  const type = schema.type
  if (type === "string") return true
  if (Array.isArray(type) && type.includes("string")) return true
  for (const key of ["anyOf", "oneOf"]) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.some((variant) => isRecord(variant) && schemaAllowsString(variant)))
      return true
  }
  return false
}

/**
 * Required current-revision nodes that did not produce an accepted result.
 * Natural completion (`mode: "natural"`) keeps the historical accepted-skip
 * behavior for definitions without `skip_ok`. Explicit completion uses
 * `mode: "strict"`: every required node must be completed with a passing
 * verdict or explicitly opted into the skip, so forced completion cannot
 * bypass the invariant. A completed non-review gate whose verdict says
 * FAIL/BLOCKING/BLOCKED/INCOMPLETE always counts as unfinished. Only a diff
 * review is exempt: its REJECT outcome stays reopenable, while design
 * review verdicts are real gate failures.
 */
export function requiredCompletionGaps(
  config: WorkflowConfig | undefined,
  nodes: readonly CompletionNode[],
  mode: "natural" | "strict" = "natural",
): string[] {
  const definitions = new Map(config?.nodes.map((node) => [node.id, node]))
  return nodes.flatMap((node) => {
    const definition = definitions.get(node.id)
    // #944: a target-sensitive node judges the working tree. A stale result
    // never counts as an accepted result — including a non-required review
    // lane, whose verdict can still open the review decision.
    if (definition?.target_sensitive === true && node.status === "completed" && node.staleTarget === true)
      return [`${node.id} (stale target)`]
    if (!node.required) return []
    if (node.status !== "completed") {
      if (node.status !== "skipped" && node.status !== "aborted")
        return [`${node.id} (${node.status || "unfinished"})`]
      if (definition?.skip_ok === true) return []
      if (definition?.skip_ok === undefined && mode === "natural") return []
      return [`${node.id} (${node.status}: ${node.errorReason ?? "unfinished"})`]
    }
    // #944: a result judged against a tree that changed mid-run is not an
    // accepted result, even when its verdict says PASS/ACCEPT.
    if (node.staleTarget === true) return [`${node.id} (stale target)`]
    if (definition?.review?.phase === "diff") {
      const outcome = verdictField(node.output)
      // Only the ACCEPT/REJECT diff-review outcomes that gate reopen behavior are
      // exempt. A malformed FAIL/BLOCKED diff review is still a failed gate.
      if (outcome === "ACCEPT" || outcome === "REJECT") return []
    }
    const verdict = failingGateVerdict(node.output, {
      allowScalar: declaresVerdictContract(definition?.output_schema),
      parseString: !schemaAllowsString(definition?.output_schema),
    })
    return verdict ? [`${node.id} (verdict ${verdict})`] : []
  })
}
