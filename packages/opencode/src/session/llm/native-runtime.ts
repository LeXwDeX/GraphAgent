import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import {
  LLMRequest,
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type JsonSchema,
  type LLMEvent,
} from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { LLMNative } from "./native-request"
import {
  ContextFolding,
  type HistorySnapshot as ContextFoldingHistorySnapshot,
  type RequestPurpose,
} from "../context-folding"
import type { SystemTransmission } from "@opencode-ai/core/session/context-folding"
import type { ContextFoldingProjectionPlan } from "@opencode-ai/core/session/context-folding"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | {
      readonly type: "supported"
      readonly stream: Stream.Stream<LLMEvent, unknown>
      readonly contextFoldingPlan: ContextFoldingProjectionPlan | undefined
    }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  readonly contextFolding?: {
    readonly enabled: boolean
    readonly purpose: RequestPurpose
    readonly history?: ContextFoldingHistorySnapshot
    readonly system: SystemTransmission
  }
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  // The gate keys off the SDK transport package, not the providerID: any
  // OpenAI-compatible relay (local proxies, DeepSeek, GLM gateways) speaks the
  // same wire protocol the native client implements.
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === "openai" && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

export function stream(input: StreamInput): Effect.Effect<StreamResult> {
  return Effect.gen(function* () {
    const fetch = providerFetch(input)
    const current = statusWithFetch(input, fetch)
    if (current.type === "unsupported") return current

    // Integration point with @opencode-ai/llm: native-request lowers session data
    // into an LLMRequest, then LLMClient handles route selection and transport.
    //
    // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
    // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
    // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
    // include, textVerbosity, promptCacheKey). Both sides intentionally use
    // OpenAI's official wire field names, so this is identity, not translation
    // — if a field ever needs to differ between the two surfaces, the
    // translation belongs here, not split across both packages.
    const tools = nativeTools(input.tools, input)
    const sourceMessages = ContextFolding.copyModelMessages(input.messages)
    const transformInput = ContextFolding.copyModelMessages(input.messages) ?? input.messages
    const transformedMessages = ProviderTransform.message(transformInput, input.model, input.providerOptions ?? {})
    const canonical = LLMRequest.update(
      LLMNative.request({
        model: input.model,
        apiKey: current.apiKey,
        baseURL: current.baseURL,
        messages: transformedMessages,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        topP: input.topP,
        topK: input.topK,
        maxOutputTokens: input.maxOutputTokens,
        providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
        headers: { ...providerHeaders(input.provider.options.headers), ...input.headers },
      }),
      { tools: toDefinitions(tools) },
    )
    const folding = input.contextFolding
    const snapshot =
      folding?.enabled && folding.history && folding.purpose === "conversation" && sourceMessages
        ? ContextFolding.bindModelMessages(folding.history, sourceMessages)
        : undefined
    const projection =
      folding?.enabled && snapshot && folding.purpose === "conversation"
        ? ContextFolding.projectNative({
            model: input.model,
            purpose: folding.purpose,
            snapshot,
            request: canonical,
            transformedMessages,
            sourceMessages: sourceMessages ?? [],
            messageTransformOptions: input.providerOptions ?? {},
            tools: input.tools,
            toolChoice: input.toolChoice,
            maxOutputTokens: input.maxOutputTokens,
            params: {
              temperature: input.temperature,
              topP: input.topP,
              topK: input.topK,
              maxOutputTokens: input.maxOutputTokens,
              providerOptions: input.providerOptions,
            },
            system: folding.system,
          })
        : undefined
    const request =
      projection?.applied === true
        ? LLMRequest.update(canonical, { messages: projection.request.messages as typeof canonical.messages })
        : canonical
    const stream = Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          const settlements = yield* FiberSet.make<void>()
          const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
          const completion: LLMEvent[] = []
          const provider = input.llmClient.stream(request).pipe(
            Stream.flatMap((event) => {
              // The processor may close the stream for compaction at step-finish.
              // Deliver every local settlement before exposing that boundary.
              if (event.type === "step-finish" || event.type === "finish") {
                completion.push(event)
                return Stream.empty
              }
              return event.type !== "tool-call" || event.providerExecuted
                ? Stream.make(event)
                : Stream.make(event).pipe(
                    Stream.concat(
                      Stream.fromEffectDrain(
                        ToolRuntime.dispatch(tools, event).pipe(
                          Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
                          Effect.catchCause((cause) => Queue.failCause(results, cause)),
                          Effect.asVoid,
                          FiberSet.run(settlements, { startImmediately: true }),
                        ),
                      ),
                    ),
                  )
            }),
            Stream.concat(
              Stream.fromEffectDrain(
                FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid),
              ),
            ),
          )
          return provider.pipe(
            Stream.concat(Stream.fromQueue(results)),
            Stream.concat(Stream.suspend(() => Stream.fromIterable(completion))),
          )
        }),
      ),
    ).pipe(Stream.provideService(RequestExecutor.RetryTimeouts, input.contextFolding?.purpose !== "compaction"))

    return {
      ...current,
      contextFoldingPlan: projection?.plan,
      stream: fetch ? stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : stream,
    }
  })
}

export type OrganizerClient =
  | {
      readonly type: "supported"
      readonly llm: LLMClientShape
      readonly model: LLMRequest["model"]
    }
  | { readonly type: "unsupported"; readonly reason: string }

/**
 * Engine client for a tool-less auxiliary request (the reasoning organizer) on the same native transport gate as
 * conversation streams, independent of the experimental native-conversation flag.
 */
export function organizerClient(
  input: Pick<StreamInput, "model" | "provider" | "auth" | "llmClient">,
): OrganizerClient {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current
  const model = LLMNative.model(
    { model: input.model, apiKey: current.apiKey, baseURL: current.baseURL, messages: [] },
    providerHeaders(input.provider.options.headers),
  )
  const llm: LLMClientShape = fetch
    ? {
        ...input.llmClient,
        generate: (request) =>
          input.llmClient.generate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      }
    : input.llmClient
  return { type: "supported", llm, model }
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== "openai" || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @opencode-ai/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
