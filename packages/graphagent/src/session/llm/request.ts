import { PermissionV1 } from "@graphagent/core/v1/permission"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { Auth } from "@/auth"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { ProviderAdapters } from "@/provider/adapter/registry"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { APP_NAME } from "@graphagent/core/brand"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { DEFAULT_WRITING_STYLE } from "@graphagent/core/system-context/writing-style"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import { TITLE_HEADER } from "@/provider/openai-ws/ws-pool"
import type { ChatParams } from "@/provider/adapter/types"
import { mergeDeep } from "remeda"
import { isInternalOneShot } from "./internal-one-shot"

const USER_AGENT = `${APP_NAME}/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  /** Role-owned rules evaluated before configured rules by Permission.ask. */
  readonly nativePermission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  /** Prompt-cache group shared by sibling child runs; overrides the per-session cache key. */
  readonly cacheGroup?: string
  /** Caps the resolved output limit; applied after the provider adapter hook. */
  readonly maxOutputTokens?: number
  readonly provider: Provider.Info
  readonly cfg?: ConfigV1.Info
  readonly auth: Auth.Info | undefined
  readonly adapters?: ProviderAdapters.Interface
  readonly flags: RuntimeFlags.Info
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const adapters =
    input.adapters ??
    ({
      chatParams: (_hookInput: unknown, output: ChatParams) => Effect.succeed(output),
      chatHeaders: (_hookInput: unknown, output: { headers: Record<string, string> }) => Effect.succeed(output.headers),
    } satisfies Pick<ProviderAdapters.Interface, "chatParams" | "chatHeaders">)
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const tools = resolveTools(input)
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(Object.keys(tools))),
      DEFAULT_WRITING_STYLE,
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        cacheKey: input.cacheGroup,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages = isOpenaiOauth
    ? input.messages
    : [
        ...system.map((x): ModelMessage => ({
          role: "system",
          content: x,
        })),
        ...input.messages,
      ]

  const params = yield* adapters.chatParams(
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(
        input.model,
        input.flags.outputTokenMax,
        ProviderTransform.configuredOutputLimit(input.cfg, input.model),
      ),
      options,
    },
  )
  if (input.maxOutputTokens !== undefined) {
    params.maxOutputTokens =
      params.maxOutputTokens === undefined
        ? input.maxOutputTokens
        : Math.min(params.maxOutputTokens, input.maxOutputTokens)
  }

  const headers = yield* adapters.chatHeaders(
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )
  // Configured transports also need internal one-shot isolation when default plugins are disabled.
  if (
    isInternalOneShot(input.agent.name) &&
    input.model.api.npm === "@ai-sdk/openai" &&
    input.provider.options.experimentalWebSockets === true
  ) {
    headers[TITLE_HEADER] = "true"
  }

  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  return {
    system,
    // Hosted history must become text before the SDK converts prompts and
    // downloads file URLs; model middleware runs after that processing.
    messages: ProviderTransform.hostedToolHistory(messages, input.model),
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      "x-session-affinity": input.sessionID,
      "X-Session-Id": input.sessionID,
      "User-Agent": USER_AGENT,
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
    },
  }
})

export function resolveTools(
  input: Pick<PrepareInput, "tools" | "agent" | "permission" | "nativePermission" | "user">,
) {
  const disabled = Permission.disabledByPolicy(
    Object.keys(input.tools),
    input.nativePermission ?? [],
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
