import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"

const COMPACTION_BUFFER = 20_000
const DEFAULT_AUTO_COMPACTION_CEILING = 250_000

export function measured(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function triggerLimit(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  threshold?: "auto" | "model"
}) {
  const modelLimit = usable(input)
  const configuredLimit = input.cfg.compaction?.max_context_tokens ?? DEFAULT_AUTO_COMPACTION_CEILING
  return input.threshold === "model" ? modelLimit : Math.min(modelLimit, configuredLimit)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  estimatedInputTokens?: number
  threshold?: "auto" | "model"
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count = measured(input.tokens)
  return Math.max(count, input.estimatedInputTokens ?? 0) >= triggerLimit(input)
}

/**
 * Conservative estimate of one prepared provider request. A context gate must include every part the
 * provider receives (system, tool schemas, messages) and must not undercount CJK text: undercounting
 * lets an oversized request reach the provider, which then rejects it.
 */
export function estimateRequest(input: {
  system: readonly string[]
  messages: unknown
  tools?: Record<string, { description?: string; parameters?: unknown }>
}) {
  const tools = input.tools
    ? Object.entries(input.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    : undefined
  return Token.estimateReserve(JSON.stringify({ system: input.system, tools, messages: input.messages }))
}
