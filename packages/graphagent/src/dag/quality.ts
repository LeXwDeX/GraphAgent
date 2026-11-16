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
 *
 * A workflow can hold several independent reviews (a design review and a diff
 * review, or one per implementation), and a later round of one review is a new
 * decision that continues an earlier one through `prior_round`. Those linked
 * decisions form one review chain; every other decision is a chain of its own.
 * What is still open, how long a review has been quiet, and what completeness
 * judged are properties of a chain's latest completed round, so they are read
 * per chain and then combined: open findings add up, the quiet streak is the
 * quietest chain's, and completeness is merged per acceptance item.
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
  /** The workflow's own id: only a `prior_round` that names it links two decisions here. */
  readonly workflowID: string
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

  // The completed rounds of each review chain, in round order (`completed` is
  // already sorted, so each chain's indexes are too).
  const chainOf = chainKeys(decisions, input.workflowID)
  const chains = new Map<string, number[]>()
  completed.forEach((entry, index) => {
    const key = chainOf.get(entry.definition.id) ?? entry.definition.id
    chains.set(key, [...(chains.get(key) ?? []), index])
  })
  const perChain = [...chains.values()]

  return {
    newFindingsPerRound: summary.newFindingsPerRound,
    quality: {
      reviewBound: reviewBoundAccept(config, rows),
      reviews: completed.length,
      raised: summary.raised,
      fixed: summary.fixed,
      refuted: summary.refuted + summary.resolvedRefuted,
      // A finding still open for several rounds is re-listed by every `resolved`
      // of its chain, so a cumulative total would count it once per round: what
      // a chain leaves open is what its latest arbitration left open. Each chain
      // stands alone, so the workflow's open findings are the sum over chains.
      stillOpen: perChain.reduce((total, indexes) => total + rounds[indexes[indexes.length - 1]].stillOpen, 0),
      skepticRefutations: completed.reduce((total, { row }) => total + reviewLaneFindings(row?.output, skeptics), 0),
      rounds: summary.rounds,
      // The streak is a chain's own trailing run of rounds without a new upheld
      // finding. Several chains are quiet only as long as the quietest one.
      quietRounds:
        perChain.length === 0
          ? 0
          : Math.min(...perChain.map((indexes) => reviewRoundSummary(indexes.map((i) => rounds[i])).quietRounds)),
      completeness: mergeCompleteness(
        config,
        perChain.flatMap((indexes) => {
          const lane = completenessLane(
            rows,
            definitions,
            indexes.map((i) => completed[i].dependencies),
          )
          return lane ? [lane] : []
        }),
      ),
    },
  }
}

/**
 * The review chain each decision belongs to, keyed by the chain's first
 * decision. A decision that continues another decision of this workflow through
 * `prior_round` joins that decision's chain; a `prior_round` naming another
 * workflow (a successor workflow continuing an earlier review) starts a chain
 * here, since the earlier rounds are not part of this workflow. Cycles stop at
 * the first decision seen twice.
 */
function chainKeys(decisions: readonly NodeConfig[], workflowID: string): ReadonlyMap<string, string> {
  const byID = new Map(decisions.map((decision) => [decision.id, decision]))
  const head = (decision: NodeConfig) => {
    const seen = new Set<string>()
    let current = decision
    while (!seen.has(current.id)) {
      seen.add(current.id)
      const prior = current.prior_round
      const parent = prior?.workflow_id === workflowID ? byID.get(prior.review_id) : undefined
      if (!parent) break
      current = parent
    }
    return current.id
  }
  return new Map(decisions.map((decision) => [decision.id, head(decision)]))
}

/**
 * The summary's `quality`: null unless the workflow runs under the strict
 * review gate and has a review decision (#1027 D6).
 */
export function workflowQuality(input: {
  readonly config: WorkflowConfig | undefined
  readonly workflowID: string
  readonly nodes: readonly QualityNode[]
}): WorkflowQuality | null {
  if (!input.config || !strictReviewGate(input.config)) return null
  return reviewMetrics(input)?.quality ?? null
}

/**
 * One quality across several workflows (the session-level read): counts add up,
 * a bound review anywhere counts as bound, and the quiet streak is the quietest
 * workflow's among those that have arbitrated a round (the same "quiet only as
 * long as the quietest" rule as chains within a workflow). Null when no workflow
 * reports quality.
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
    quietRounds: quietestStreak(items),
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

function quietestStreak(items: readonly WorkflowQuality[]): number {
  const streaks = items.filter((item) => item.reviews > 0).map((item) => item.quietRounds)
  return streaks.length === 0 ? 0 : Math.min(...streaks)
}

/** One completeness lane's judgement: the status of each acceptance item it judged, and what it listed. */
interface CompletenessLane {
  readonly judged: ReadonlyMap<string, string>
  readonly unlisted: readonly string[]
}

/**
 * The completeness lane of a chain's latest arbitrated round that has one that
 * completed. `rounds` holds the dependencies of the chain's completed decisions,
 * oldest first.
 */
function completenessLane(
  rows: ReadonlyMap<string, QualityNode>,
  definitions: ReadonlyMap<string, NodeConfig>,
  rounds: readonly (readonly string[])[],
): CompletenessLane | undefined {
  for (const lanes of rounds.toReversed()) {
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
      return {
        judged,
        unlisted: (Array.isArray(output.unlisted) ? output.unlisted : []).filter((item) => typeof item === "string"),
      }
    }
  }
  return undefined
}

/**
 * M3 completeness over the latest completeness lane of each review chain. The
 * denominator is the declared acceptance list, so an item no lane judged still
 * counts against it; without a declared list it is the items the lanes judged.
 * Every chain judges the same workflow-level items, so they are merged by item
 * rather than added up, which would count an item once per chain: an item is
 * covered only when every lane that judged it called it covered, and an
 * expectation that several lanes listed is one unlisted expectation. A single
 * chain reads as its lane alone. Null when no chain has a completed lane.
 */
function mergeCompleteness(
  config: WorkflowConfig,
  lanes: readonly CompletenessLane[],
): WorkflowQuality["completeness"] {
  if (lanes.length === 0) return null
  const ids = config.acceptance
    ? [...new Set(config.acceptance.map((item) => item.id))]
    : [...new Set(lanes.flatMap((lane) => [...lane.judged.keys()]))]
  const covered = ids.filter((id) => {
    const verdicts = lanes.flatMap((lane) => {
      const status = lane.judged.get(id)
      return status === undefined ? [] : [status]
    })
    return verdicts.length > 0 && verdicts.every((status) => status === "covered")
  })
  return {
    covered: covered.length,
    total: ids.length,
    unlisted: new Set(lanes.flatMap((lane) => lane.unlisted)).size,
  }
}
