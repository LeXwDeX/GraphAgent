// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Review quality of one workflow (#1027 D6 `WorkflowSummary.quality`, #1031 §8).
 *
 * One pure computation feeds every surface that reports review quality: the
 * `/dag` summary push and HTTP read, the session DAG mode status, and the
 * `review_quality` block of `inspect` status, so the numbers cannot drift
 * apart. Only block-compiled review decisions (`review_arbitration`) carry the
 * structured `dispositions`/`resolved` the counters come from; a hand-authored
 * review node has none, so it contributes nothing here.
 *
 * Counters reuse the accounting of the review loop: a completed decision is a
 * round, `raised` is the lane actions it arbitrated, and fixed/refuted/open
 * come from its `resolved` list.
 */
export * as DagQuality from "./quality"

import type { WorkflowQuality } from "@graphagent/schema/dag-summary"
import type { NodeConfig, WorkflowConfig } from "./dag"
import {
  reviewBoundAccept,
  reviewLaneFindings,
  reviewRoundMetrics,
  reviewRoundSummary,
  strictReviewGate,
} from "./review-lifecycle"
import { normalizeOutput } from "./runtime/verdict"
import { isRecord } from "@/util/record"

/** The row fields quality reads. Only the current graph revision is passed. */
export interface QualityNode {
  readonly id: string
  readonly status: string
  /** The dependencies the row was persisted with; the config's are the fallback. */
  readonly dependsOn?: readonly string[]
  readonly output?: unknown
  readonly staleTarget?: boolean | null
}

/** The shared review counters plus the per-round series `inspect` also shows. */
export interface ReviewMetrics {
  readonly quality: WorkflowQuality
  /** New upheld findings of each completed round, oldest first. */
  readonly newFindingsPerRound: readonly number[]
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = normalizeOutput(value)
  return isRecord(parsed) ? parsed : undefined
}

/**
 * The nodes whose stored output the counters read: each arbitration decision,
 * its lanes, and the implementation a diff review is bound to. A caller that
 * loads outputs selectively names these.
 */
export function outputNodeIDs(config: WorkflowConfig): string[] {
  const ids = new Set<string>()
  for (const node of config.nodes) {
    if (node.review_lane !== undefined) ids.add(node.id)
    if (node.review_arbitration !== true) continue
    ids.add(node.id)
    if (node.review?.implementation_node_id !== undefined) ids.add(node.review.implementation_node_id)
  }
  return [...ids]
}

/**
 * The review counters for a workflow, or undefined when it has no block review
 * decision. The strict-gate rule that decides whether the summary reports them
 * is `workflowQuality`; `inspect` reports them for any workflow with a review.
 */
export function reviewMetrics(input: {
  readonly config: WorkflowConfig | undefined
  readonly nodes: readonly QualityNode[]
}): ReviewMetrics | undefined {
  const config = input.config
  if (!config) return undefined
  const decisions = config.nodes.filter((node) => node.review_arbitration === true)
  if (decisions.length === 0) return undefined

  const rows = new Map(input.nodes.map((node) => [node.id, node]))
  const definitions = new Map(config.nodes.map((node) => [node.id, node]))
  // Only an arbitrated decision is a round: before it completes, a lane's
  // claims are not findings yet and a pending decision is not a quiet round.
  const completed = decisions
    .map((definition, order) => {
      const row = rows.get(definition.id)
      return { definition, order, row, dependencies: row?.dependsOn ?? definition.depends_on }
    })
    .filter((entry) => entry.row?.status === "completed")
    .toSorted((a, b) => (a.definition.review_round ?? 1) - (b.definition.review_round ?? 1) || a.order - b.order)
  const rounds = completed.map(({ row, dependencies }) =>
    reviewRoundMetrics(
      row?.output,
      dependencies.flatMap((id) => {
        const dependency = rows.get(id)
        return dependency?.status === "completed" ? [{ nodeID: id, output: dependency.output }] : []
      }),
    ),
  )
  const summary = reviewRoundSummary(rounds)
  const skeptics = new Set(
    config.nodes.filter((node) => node.review_lane?.startsWith("skeptic-")).map((node) => node.id),
  )

  return {
    newFindingsPerRound: summary.newFindingsPerRound,
    quality: {
      reviewBound: reviewBoundAccept(config, rows),
      reviews: completed.length,
      raised: summary.raised,
      fixed: summary.fixed,
      refuted: summary.refuted + summary.resolvedRefuted,
      // A finding still open for several rounds is re-listed by every
      // `resolved`, so the cumulative total would count it once per round:
      // what remains open is what the latest arbitration left open.
      stillOpen: rounds.at(-1)?.stillOpen ?? 0,
      skepticRefutations: completed.reduce((total, { row }) => total + reviewLaneFindings(row?.output, skeptics), 0),
      rounds: summary.rounds,
      quietRounds: summary.quietRounds,
      completeness: completenessOf(
        config,
        rows,
        definitions,
        completed.map((entry) => entry.dependencies),
      ),
    },
  }
}

/**
 * The summary's `quality`: null unless the workflow runs under the strict
 * review gate and has a review decision (#1027 D6).
 */
export function workflowQuality(input: {
  readonly config: WorkflowConfig | undefined
  readonly nodes: readonly QualityNode[]
}): WorkflowQuality | null {
  if (!input.config || !strictReviewGate(input.config)) return null
  return reviewMetrics(input)?.quality ?? null
}

/**
 * One quality across several workflows (the session-level read): counts add up,
 * a bound review anywhere counts as bound, and the quiet streak is the longest
 * one. Null when no workflow reports quality.
 */
export function combine(items: readonly WorkflowQuality[]): WorkflowQuality | null {
  if (items.length === 0) return null
  const total = (pick: (item: WorkflowQuality) => number) => items.reduce((sum, item) => sum + pick(item), 0)
  const completeness = items.flatMap((item) => (item.completeness ? [item.completeness] : []))
  return {
    reviewBound: items.some((item) => item.reviewBound),
    reviews: total((item) => item.reviews),
    raised: total((item) => item.raised),
    fixed: total((item) => item.fixed),
    refuted: total((item) => item.refuted),
    stillOpen: total((item) => item.stillOpen),
    skepticRefutations: total((item) => item.skepticRefutations),
    rounds: total((item) => item.rounds),
    quietRounds: Math.max(...items.map((item) => item.quietRounds)),
    completeness:
      completeness.length === 0
        ? null
        : {
            covered: completeness.reduce((sum, item) => sum + item.covered, 0),
            total: completeness.reduce((sum, item) => sum + item.total, 0),
            unlisted: completeness.reduce((sum, item) => sum + item.unlisted, 0),
          },
  }
}

/**
 * M3 completeness from the latest arbitrated round whose completeness lane
 * completed. The denominator is the declared acceptance list, so an item the
 * lane never judged still counts against it; without a declared list the lane's
 * own judged items are all there is.
 */
function completenessOf(
  config: WorkflowConfig,
  rows: ReadonlyMap<string, QualityNode>,
  definitions: ReadonlyMap<string, NodeConfig>,
  dependencies: readonly (readonly string[])[],
): WorkflowQuality["completeness"] {
  for (const lanes of dependencies.toReversed()) {
    for (const id of lanes) {
      if (definitions.get(id)?.review_lane !== "completeness") continue
      const lane = rows.get(id)
      if (lane?.status !== "completed") continue
      const output = record(lane.output)
      if (!output) continue
      const judged = new Map<string, string>()
      for (const entry of Array.isArray(output.acceptance) ? output.acceptance : []) {
        if (isRecord(entry) && typeof entry.id === "string" && typeof entry.status === "string")
          judged.set(entry.id, entry.status)
      }
      const declared = config.acceptance ? [...new Set(config.acceptance.map((item) => item.id))] : undefined
      return {
        covered: declared
          ? declared.filter((itemID) => judged.get(itemID) === "covered").length
          : [...judged.values()].filter((status) => status === "covered").length,
        total: declared ? declared.length : judged.size,
        unlisted: (Array.isArray(output.unlisted) ? output.unlisted : []).filter((item) => typeof item === "string")
          .length,
      }
    }
  }
  return null
}
