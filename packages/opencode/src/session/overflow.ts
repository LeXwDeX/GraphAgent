import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"

const COMPACTION_BUFFER = 20_000

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

/** Automatic compaction uses the model's usable context window and nothing else. */
export function triggerLimit(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  return usable(input)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  estimatedInputTokens?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count = measured(input.tokens)
  return Math.max(count, input.estimatedInputTokens ?? 0) >= triggerLimit(input)
}

// AI SDK tools expose their JSON schema as `inputSchema` (usually an object with a `jsonSchema`
// property). Older shapes used `parameters`. Serialize whichever is present so the estimate counts
// the schema the provider receives, not just the description.
function toolSchema(tool: unknown) {
  if (typeof tool !== "object" || tool === null) return undefined
  const value = tool as { inputSchema?: unknown; parameters?: unknown }
  if (value.parameters !== undefined) return value.parameters
  const schema = value.inputSchema
  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { jsonSchema: unknown }).jsonSchema
  }
  return schema
}

function serializedTools(tools: Record<string, unknown> | undefined) {
  return tools
    ? Object.entries(tools).map(([name, tool]) => ({
        name,
        description:
          typeof tool === "object" && tool !== null ? (tool as { description?: unknown }).description : undefined,
        parameters: toolSchema(tool),
      }))
    : undefined
}

/**
 * Conservative estimate of the parts a conversation request carries besides its messages: system text
 * and tool schemas. The main loop checks the context limit before it prepares a request, so it reuses
 * the overhead measured on the previous request instead of omitting these parts.
 */
export function estimateOverhead(input: { system: readonly string[]; tools?: Record<string, unknown> }) {
  return Token.estimateReserve(JSON.stringify({ system: input.system, tools: serializedTools(input.tools) }))
}

/**
 * Conservative estimate of one prepared provider request. A context gate must include every part the
 * provider receives (system, tool schemas, messages) and must not undercount CJK text: undercounting
 * lets an oversized request reach the provider, which then rejects it.
 */
export function estimateRequest(input: {
  system: readonly string[]
  messages: unknown
  tools?: Record<string, unknown>
}) {
  return Token.estimateReserve(
    JSON.stringify({ system: input.system, tools: serializedTools(input.tools), messages: input.messages }),
  )
}
