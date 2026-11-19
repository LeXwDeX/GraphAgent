// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as SessionCompactionModel from "./compaction-model"

import type { Provider } from "@/provider/provider"

/** `small` keeps the legacy request; `shared` reuses the main request prefix; `auto` prices both. */
export type Mode = "small" | "shared" | "auto"

export type CleanKind = "small" | "agent" | "conversation"
export type PlanKind = CleanKind | "shared"

export type CostModel = Pick<Provider.Model, "providerID" | "id" | "cost">

export type CleanCandidate<M extends CostModel> = { readonly model: M; readonly kind: CleanKind }
type SharedCandidate<M extends CostModel> = { readonly model: M; readonly prefixTokens: number }

export type PlanEntry<M extends CostModel = CostModel> = {
  readonly model: M
  readonly kind: PlanKind
  readonly shared: boolean
  /** Estimated request cost in model-price units; only used for ordering. */
  readonly estimatedCost: number
}

export type ChooseInput<M extends CostModel = CostModel> = {
  readonly mode: Mode
  /**
   * Clean candidates as `cleanCandidates` ordered them. `shared` and `auto` need a configured mode, so they arrive in
   * the legacy order: small, agent, conversation.
   */
  readonly clean: readonly CleanCandidate<M>[]
  /** Present only when every shared-prefix guard passed. */
  readonly shared?: SharedCandidate<M>
  readonly promptTokens: number
  readonly outputTokens?: number
  /** False when the compaction follows an overflow; a cold prefix earns no cache discount. */
  readonly warm: boolean
}

const DEFAULT_OUTPUT_TOKENS = 2_000

// Legacy order is the deterministic tie-break when prices are equal.
const RANK: Record<PlanKind, number> = { small: 0, shared: 1, agent: 2, conversation: 3 }

/**
 * Price schedule that `Session.getUsage` would charge for a request of this
 * size: the largest applicable context tier, then the over-200K schedule, then
 * the base price. Boundaries are strict (`>`), matching usage accounting.
 */
function schedule(model: CostModel, promptTokens: number): CostModel["cost"] {
  const tier = model.cost.tiers
    ?.filter((item) => item.tier.type === "context" && promptTokens > item.tier.size)
    .sort((left, right) => right.tier.size - left.tier.size)[0]
  if (tier) return tier
  if (promptTokens > 200_000 && model.cost.experimentalOver200K) return model.cost.experimentalOver200K
  return model.cost
}

/**
 * Cost of one compaction request. `cachedTokens` are prompt tokens served from
 * the provider cache; missing prices count as zero. Cache writes are ignored
 * because the main request already paid for the prefix.
 */
export function estimateCompactionCost(input: {
  readonly model: CostModel
  readonly promptTokens: number
  readonly outputTokens?: number
  readonly cachedTokens?: number
}): number {
  const prices = schedule(input.model, input.promptTokens)
  const cached = input.cachedTokens ?? 0
  const output = input.outputTokens ?? DEFAULT_OUTPUT_TOKENS
  return (
    (cached * (prices.cache?.read ?? 0) + (input.promptTokens - cached) * prices.input + output * prices.output) /
    1_000_000
  )
}

function sharedCachedTokens(input: {
  readonly model: CostModel
  readonly promptTokens: number
  readonly prefixTokens: number
  readonly warm: boolean
}): number {
  if (!input.warm) return 0
  const prices = schedule(input.model, input.promptTokens)
  // A free cache read is not a discount; charge the prefix at the input price.
  if ((prices.cache?.read ?? 0) === 0 && prices.input > 0) return 0
  return Math.min(input.prefixTokens, input.promptTokens)
}

function dedupe<M extends CostModel>(entries: readonly PlanEntry<M>[]): PlanEntry<M>[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.model.providerID}/${entry.model.id}/${entry.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeClean<M extends CostModel>(clean: readonly CleanCandidate<M>[]): CleanCandidate<M>[] {
  const seen = new Set<string>()
  return clean.filter((entry) => {
    const key = `${entry.model.providerID}/${entry.model.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The clean ladder's candidates in the order they are tried. With no `compaction.mode` configured the models chosen for
 * the work come first, the `agent.compaction` model and the conversation's own, and the provider's small model last:
 * a summary is only as precise as the model that writes it. A configured mode keeps the legacy order, small model
 * first. A model that fills several stages is tried once, under its earliest role.
 */
export function cleanCandidates<M extends CostModel>(input: {
  readonly configured: Mode | undefined
  readonly small: M | undefined
  readonly agent: M | undefined
  readonly conversation: M
}): CleanCandidate<M>[] {
  const stages: ReadonlyArray<readonly [CleanKind, M | undefined]> =
    input.configured === undefined
      ? [
          ["agent", input.agent],
          ["conversation", input.conversation],
          ["small", input.small],
        ]
      : [
          ["small", input.small],
          ["agent", input.agent],
          ["conversation", input.conversation],
        ]
  return dedupeClean(stages.flatMap(([kind, model]) => (model ? [{ model, kind }] : [])))
}

function compare<M extends CostModel>(left: PlanEntry<M>, right: PlanEntry<M>): number {
  if (left.estimatedCost !== right.estimatedCost) return left.estimatedCost - right.estimatedCost
  if (RANK[left.kind] !== RANK[right.kind]) return RANK[left.kind] - RANK[right.kind]
  if (left.model.providerID !== right.model.providerID) return left.model.providerID < right.model.providerID ? -1 : 1
  if (left.model.id !== right.model.id) return left.model.id < right.model.id ? -1 : 1
  return 0
}

/**
 * Order the compaction attempts. `small` keeps the legacy ladder without a
 * shared entry; `shared` puts the shared request first regardless of price;
 * `auto` prices every entry and falls back to rank and model identity on ties,
 * so the result never depends on time or randomness.
 */
export function chooseCompactionModel<M extends CostModel>(input: ChooseInput<M>): PlanEntry<M>[] {
  const outputTokens = input.outputTokens ?? DEFAULT_OUTPUT_TOKENS
  const clean = dedupeClean(input.clean).map((entry): PlanEntry<M> => ({
    model: entry.model,
    kind: entry.kind,
    shared: false,
    estimatedCost: estimateCompactionCost({
      model: entry.model,
      promptTokens: input.promptTokens,
      outputTokens,
    }),
  }))
  if (input.mode === "small") return dedupe(clean)

  const shared = input.shared
    ? {
        model: input.shared.model,
        kind: "shared" as const,
        shared: true,
        estimatedCost: estimateCompactionCost({
          model: input.shared.model,
          promptTokens: input.promptTokens,
          outputTokens,
          cachedTokens: sharedCachedTokens({
            model: input.shared.model,
            promptTokens: input.promptTokens,
            prefixTokens: input.shared.prefixTokens,
            warm: input.warm,
          }),
        }),
      }
    : undefined
  if (input.mode === "shared") return dedupe([...(shared ? [shared] : []), ...clean])
  return dedupe([...clean, ...(shared ? [shared] : [])]).sort(compare)
}
