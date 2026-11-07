export * as HookModelMetrics from "./model-metrics"

import { Effect, Option } from "effect"
import { mergeDeep } from "remeda"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import type { Message as HistoryMessage } from "./transcript"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

type Cost = NonNullable<ModelsDev.Model["cost"]>
export interface Input {
  readonly sessionID: string
  readonly target?: Provider.Model
  readonly previous?: Provider.Model
  readonly history: readonly HistoryMessage[]
  readonly providerOptions?: Record<string, unknown>
  readonly agentOptions?: Record<string, unknown>
  readonly variant?: string
  readonly previousProviderOptions?: Record<string, unknown>
  readonly previousAgentOptions?: Record<string, unknown>
  readonly previousVariant?: string
  readonly configuredCost?: Cost
  readonly catalogCost?: Cost
  readonly now?: number
}
export interface Metrics {
  readonly contextTokens: number
  readonly promptCacheWarm: boolean
  readonly cacheTtl: "5m" | "1h"
  readonly estimatedCacheWriteUsd: number
  readonly pricing: "configured" | "catalog" | "default"
}

const safe = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const anthropic = (model: Provider.Model | undefined) =>
  model?.api.npm === "@ai-sdk/anthropic" || model?.api.npm === "@ai-sdk/google-vertex/anthropic"

/** Mirrors LLMRequestPrep's non-small request option order exactly. */
export function ttl(input: {
  sessionID: string
  model?: Provider.Model
  providerOptions?: Record<string, unknown>
  agentOptions?: Record<string, unknown>
  variant?: string
}): "5m" | "1h" {
  if (!input.model || !anthropic(input.model)) return "5m"
  const options = mergeDeep(
    mergeDeep(
      mergeDeep(
        ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: input.providerOptions,
        }),
        input.model.options,
      ),
      input.agentOptions ?? {},
    ),
    input.variant ? (input.model.variants?.[input.variant] ?? {}) : {},
  )
  const control: unknown = options.cacheControl
  return control && typeof control === "object" && "ttl" in control && control.ttl === "1h" ? "1h" : "5m"
}

function schedule(cost: Cost, context: number) {
  return (
    cost.tiers
      ?.filter((tier) => tier.tier.type === "context" && context > tier.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (context > 200_000 ? cost.context_over_200k : undefined) ??
    cost
  )
}
function rate(cost: Cost | undefined, context: number, claude: boolean): number | undefined {
  if (!cost) return undefined
  const selected = schedule(cost, context)
  if (known(selected.cache_write)) return selected.cache_write
  if (claude && known(selected.input)) return selected.input * 1.25
  return undefined
}

// TTL and write multipliers: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
/** Product fallback estimate: $1 per million base-input tokens, not a provider quote. */
export const DEFAULT_INPUT_USD_PER_MILLION = 1
export const snapshot = Effect.fn("HookModelMetrics.snapshot")(function* (input: Input) {
  const last = input.history.findLast((message) => message.info.role === "assistant")?.info
  const assistant = last?.role === "assistant" ? last : undefined
  const usage = assistant?.tokens
  // Session.getUsage stores output with reasoning subtracted, so both are included here.
  const contextTokens = usage
    ? safe(usage.input) + safe(usage.output) + safe(usage.reasoning) + safe(usage.cache.read) + safe(usage.cache.write)
    : 0
  const cacheTtl = ttl({
    sessionID: input.sessionID,
    model: input.target,
    providerOptions: input.providerOptions,
    agentOptions: input.agentOptions,
    variant: input.variant,
  })
  const previousTtl = ttl({
    sessionID: input.sessionID,
    model: input.previous,
    providerOptions: input.previousProviderOptions,
    agentOptions: input.previousAgentOptions,
    variant: input.previousVariant,
  })
  const age = (input.now ?? Date.now()) - (assistant?.time.created ?? 0)
  const promptCacheWarm = Boolean(
    assistant &&
    input.previous &&
    assistant.providerID === input.previous.providerID &&
    assistant.modelID === input.previous.id &&
    usage &&
    safe(usage.cache.read) + safe(usage.cache.write) > 0 &&
    age >= 0 &&
    age < (previousTtl === "1h" ? 3_600_000 : 300_000),
  )
  const configuredSchedule = input.configuredCost ? schedule(input.configuredCost, contextTokens) : undefined
  const inheritedBase =
    input.configuredCost &&
    configuredSchedule === input.configuredCost &&
    !known(input.configuredCost.cache_write) &&
    known(input.catalogCost?.cache_write)
      ? input.catalogCost.cache_write
      : undefined
  const configured =
    inheritedBase === undefined ? rate(input.configuredCost, contextTokens, anthropic(input.target)) : undefined
  const catalog =
    inheritedBase ??
    (input.configuredCost === undefined ? rate(input.catalogCost, contextTokens, anthropic(input.target)) : undefined)
  const pricing = configured !== undefined ? "configured" : catalog !== undefined ? "catalog" : "default"
  const baseRate = configured ?? catalog ?? DEFAULT_INPUT_USD_PER_MILLION * 1.25
  const writeRate = baseRate * (cacheTtl === "1h" ? 1.6 : 1)
  return {
    contextTokens,
    promptCacheWarm,
    cacheTtl,
    estimatedCacheWriteUsd: (contextTokens * writeRate) / 1_000_000,
    pricing,
  } satisfies Metrics
})

/** Legacy sessions without recorded provenance omit session_title rather than guessing from its text. */
export function sessionFields(input: {
  source: "startup" | "resume" | "fork" | "compact" | "clear"
  title: string
  titleSource?: unknown
  history: readonly HistoryMessage[]
  metrics: Metrics
  now?: number
}) {
  const responseIndex = input.history.findLastIndex(
    (message) =>
      message.info.role === "assistant" && !message.info.summary && typeof message.info.time.completed === "number",
  )
  const response = input.history[responseIndex]?.info
  const completed = response?.role === "assistant" ? response.time.completed : undefined
  const elapsed = completed === undefined ? undefined : Math.max(0, ((input.now ?? Date.now()) - completed) / 1000)
  const compacted = input.history
    .slice(responseIndex + 1)
    .some(
      (message) =>
        message.parts.some(
          (part) => part !== null && typeof part === "object" && "type" in part && part.type === "compaction",
        ) ||
        (message.info.role === "assistant" && message.info.summary),
    )
  return {
    ...(input.titleSource === "custom" ? { sessionTitle: input.title } : {}),
    ...((input.source === "resume" || input.source === "fork") && elapsed !== undefined
      ? {
          secondsSinceLastResponse: elapsed,
          contextTokens: input.metrics.contextTokens,
          promptCacheLikelyExpired: compacted || elapsed > (input.metrics.cacheTtl === "1h" ? 3600 : 300),
          estimatedCacheWriteUsd: input.metrics.estimatedCacheWriteUsd,
        }
      : {}),
  }
}

/** Call-boundary resolution avoids Session → Provider → Plugin → Session initialization cycles. */
export const forSession = Effect.fn("HookModelMetrics.forSession")(function* (input: {
  sessionID: string
  source: "startup" | "resume" | "fork" | "compact" | "clear"
  title: string
  titleSource?: unknown
  model?: { providerID: string; id: string; variant?: string }
  agent?: string
  history: readonly HistoryMessage[]
}) {
  const [{ Provider }, { Agent }, { Config }, { ModelsDev }] = yield* Effect.promise(() =>
    Promise.all([
      import("@/provider/provider"),
      import("@/agent/agent"),
      import("@/config/config"),
      import("@opencode-ai/core/models-dev"),
    ]),
  )
  const providers = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
  const agents = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const configuration = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  const catalogService = Option.getOrUndefined(yield* Effect.serviceOption(ModelsDev.Service))
  const user = input.history.findLast((message) => message.info.role === "user")?.info
  const lastUser = user?.role === "user" ? user : undefined
  const lastResponse = input.history.findLast((message) => message.info.role === "assistant")?.info
  const selected = input.model
    ? { providerID: input.model.providerID, modelID: input.model.id, variant: input.model.variant }
    : (lastUser?.model ??
      (lastResponse?.providerID && lastResponse.modelID
        ? { providerID: lastResponse.providerID, modelID: lastResponse.modelID }
        : undefined))
  const target =
    providers && selected
      ? Option.getOrUndefined(
          yield* providers
            .getModel(ProviderV2.ID.make(selected.providerID), ModelV2.ID.make(selected.modelID))
            .pipe(Effect.option),
        )
      : undefined
  const agentName = input.agent ?? lastUser?.agent ?? lastResponse?.agent
  const agent = agents ? (agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()) : undefined
  const provider = providers && target ? yield* providers.getProvider(target.providerID) : undefined
  const cfg = configuration ? yield* configuration.get() : undefined
  const catalog = catalogService && target ? yield* catalogService.get() : undefined
  const catalogCost = target
    ? (catalog?.[target.providerID]?.models[target.id]?.cost ??
      catalog?.[target.providerID]?.models[target.api.id]?.cost)
    : undefined
  const metrics = yield* snapshot({
    sessionID: input.sessionID,
    target,
    previous: target,
    history: input.history,
    providerOptions: provider?.options,
    previousProviderOptions: provider?.options,
    agentOptions: agent?.options,
    previousAgentOptions: agent?.options,
    variant: selected?.variant,
    previousVariant: selected?.variant,
    configuredCost: target ? cfg?.provider?.[target.providerID]?.models?.[target.id]?.cost : undefined,
    catalogCost,
  })
  return {
    ...sessionFields({ ...input, metrics }),
    ...(target ? { model: target.api.id } : selected ? { model: selected.modelID } : {}),
    ...(agent ? { agentType: agent.name } : agentName ? { agentType: agentName } : {}),
  }
})
