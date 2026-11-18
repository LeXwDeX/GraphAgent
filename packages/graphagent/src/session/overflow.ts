import type { Config } from "@/config/config"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { compactionWindow } from "@graphagent/core/model-profile"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ProviderProfile } from "@/provider/profile"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"

const COMPACTION_BUFFER = 20_000

export function measured(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

/**
 * The context window automatic compaction is judged against: the model's profile window, narrowed to its
 * `effective_context` when that is smaller, or the default window when the model declares none. `limit.context` is 0
 * for an unknown window, which must not switch compaction off: the provider would reject the oversized request instead.
 */
export function windowOf(model: Provider.Model): number {
  return compactionWindow(ProviderProfile.profileOf(model)).tokens
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = windowOf(input.model)

  const output = ProviderTransform.maxOutputTokens(
    input.model,
    input.outputTokenMax,
    ProviderTransform.configuredOutputLimit(input.cfg, input.model),
  )
  if (input.model.limit.input) {
    const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, output)
    // A declared effective window ends the context before an input cap above it would.
    const narrowed = (ProviderProfile.profileOf(input.model).effectiveContext ?? 0) > 0
    const cap = narrowed ? Math.min(input.model.limit.input, context) : input.model.limit.input
    return Math.max(0, cap - reserved)
  }
  // `compaction.reserved` replaces the output reserve. A reserve that fits keeps the normal context-minus-reserve
  // budget. A reserve at least as large as the context window cannot be taken without leaving no usable input, so
  // keep up to COMPACTION_BUFFER for automatic compaction instead.
  const reserve = input.cfg.compaction?.reserved ?? output
  if (reserve >= context) return Math.min(context, COMPACTION_BUFFER)
  return Math.max(0, context - reserve)
}

/**
 * Where automatic compaction starts: the usable budget, or the `compaction.trigger_ratio` share of the compaction
 * window when that is lower. The ratio only brings compaction forward; it never moves it past the usable budget.
 */
export function triggerLimit(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const limit = usable(input)
  const ratio = input.cfg.compaction?.trigger_ratio
  if (ratio === undefined) return limit
  return Math.min(limit, Math.floor(windowOf(input.model) * ratio))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  estimatedInputTokens?: number
}) {
  if (input.cfg.compaction?.auto === false) return false

  const count = measured(input.tokens)
  return Math.max(count, input.estimatedInputTokens ?? 0) >= triggerLimit(input)
}

/**
 * Provider usage covers the request that produced the assistant message at `messageIndex`, but not the tool results that
 * completed afterward. Each of those results is counted in full, at the reserve rate: tool output is often CJK text, and
 * the pre-step gate must not undercount what the next request will carry.
 */
export function estimatePendingToolOutputTokens(messages: SessionV1.WithParts[], messageIndex: number) {
  const current = messages[messageIndex]
  if (!current || current.info.role !== "assistant") return 0

  let pending = 0
  for (const part of current.parts) {
    if (part.type !== "tool") continue
    const content =
      part.state.status === "completed" && part.state.time.compacted === undefined
        ? part.state.output
        : part.state.status === "error"
          ? part.state.error
          : undefined
    if (content) pending += Token.estimateReserve(content)
  }
  return pending
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

/**
 * The model-facing tool fragment shared by the overhead estimate and the
 * per-session fragment cache. Both must serialize the same shape.
 */
export function serializedTools(tools: Record<string, unknown> | undefined) {
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
 * Non-enumerable key under which `SessionTools.resolve` attaches the already
 * serialized tool fragment to the tools record. `estimateOverhead` accepts the
 * same string to skip re-serializing every tool schema a second time.
 */
export const TOOLS_JSON = Symbol.for("graphagent.tools-json")

/**
 * Conservative estimate of the parts a conversation request carries besides its messages: system text
 * and tool schemas. The main loop checks the context limit before it prepares a request, so it reuses
 * the overhead measured on the previous request instead of omitting these parts.
 *
 * `toolsJson` is the exact string `JSON.stringify(serializedTools(tools))`; passing it keeps the
 * estimate byte-identical while avoiding another schema pass.
 */
export function estimateOverhead(input: {
  system: readonly string[]
  tools?: Record<string, unknown>
  toolsJson?: string
}) {
  const system = JSON.stringify(input.system)
  const tools =
    input.toolsJson ?? (input.tools === undefined ? undefined : JSON.stringify(serializedTools(input.tools)))
  return Token.estimateReserve(tools === undefined ? `{"system":${system}}` : `{"system":${system},"tools":${tools}}`)
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
