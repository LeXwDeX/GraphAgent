// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { APICallError, streamText } from "ai"
import type { LanguageModel, ModelMessage, Tool } from "ai"
import { errorMessage } from "@/util/error"
import type { ProbeFindings } from "./findings"
import { ProbePlan } from "./plan"

/**
 * The two ways the probe talks to an endpoint. Chat requests go through the AI SDK model the engine itself would
 * use, so they carry exactly the request shape, headers and fetch wrapper a real turn does, plus the request-level
 * provider options the transport is given. The models request is a plain `fetch`: the probe layer is a Promise
 * interface, not an Effect service.
 *
 * Neither method throws. A failure is part of the result (a status, an error text, a timeout flag) because the probe
 * reports a failed item and goes on with the others.
 */
export type ChatResult = ProbeFindings.ChatAttempt
export type ModelsResult = ProbeFindings.ModelsAttempt

/** The AI SDK's request-level provider options: one object of options per provider name. */
export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>

export interface ChatRequest {
  readonly messages: ModelMessage[]
  readonly tools?: Record<string, Tool>
  readonly maxOutputTokens: number
}

export interface Transport {
  models(): Promise<ModelsResult>
  chat(request: ChatRequest): Promise<ChatResult>
}

export interface Options {
  /** The AI SDK model chat requests go through. */
  readonly language: LanguageModel
  /** The endpoint's base URL as the engine resolves it; without one the models request is skipped. */
  readonly baseURL?: string
  readonly apiKey?: string
  /** Headers of the models request, applied over the default bearer header. */
  readonly headers: Readonly<Record<string, string>>
  /**
   * What a normal turn sends beside the messages (the thinking switch of a reasoning model, say), set on every chat
   * request; see `ProbeOptions`. The probe's own limits win over it: an output cap among these options is dropped
   * (`OUTPUT_CAP_FIELDS`), and the output cap, retry count and deadline of the request are the probe's.
   */
  readonly providerOptions?: ProviderOptions
  readonly fetch?: typeof globalThis.fetch
  /** Deadline of each request. Defaults to `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

/**
 * The base URL of a model the way `resolveSDK` reads it: a non-empty `options.baseURL` wins over the model's API
 * URL, and `${NAME}` is filled in from the environment. A URL that is empty or still has a placeholder is unresolved,
 * and the trailing slash is dropped so `/models` can be appended.
 */
export function resolveBaseURL(input: {
  optionsBaseURL?: unknown
  apiURL: string
  env: Readonly<Record<string, string | undefined>>
}): string | undefined {
  const configured =
    typeof input.optionsBaseURL === "string" && input.optionsBaseURL !== "" ? input.optionsBaseURL : input.apiURL
  const filled = configured.replace(/\$\{([^}]+)\}/g, (item, name: string) => input.env[name] ?? item)
  if (filled.includes("${")) return undefined
  const url = filled.replace(/\/+$/, "")
  return url === "" ? undefined : url
}

function requestHeaders(apiKey: string | undefined, headers: Readonly<Record<string, string>>) {
  // Header names are case-insensitive: a configured authorization header replaces the default, never doubles it.
  const merged = new Map<string, [string, string]>()
  const put = (name: string, value: string) => merged.set(name.toLowerCase(), [name, value])
  if (apiKey) put("Authorization", `Bearer ${apiKey}`)
  for (const [name, value] of Object.entries(headers)) put(name, value)
  return Object.fromEntries(merged.values())
}

async function models(options: Options, timeoutMs: number): Promise<ModelsResult> {
  const { baseURL } = options
  if (baseURL === undefined) return { skipped: "base_url_unresolved" }
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseURL}/models`, {
      headers: requestHeaders(options.apiKey, options.headers),
      signal,
    })
    const text = await response.text()
    if (!response.ok) return { httpStatus: response.status, error: text }
    try {
      return { body: JSON.parse(text) }
    } catch (error) {
      return { httpStatus: response.status, error: `invalid JSON: ${errorMessage(error)}` }
    }
  } catch (error) {
    return signal.aborted ? { timedOut: true, error: errorMessage(error) } : { error: errorMessage(error) }
  }
}

interface Failure {
  readonly httpStatus?: number
  readonly error: string
}

function failureOf(error: unknown): Failure {
  if (APICallError.isInstance(error)) {
    return error.statusCode === undefined
      ? { error: error.message }
      : { httpStatus: error.statusCode, error: error.message }
  }
  return { error: errorMessage(error) }
}

/**
 * Body fields that cap the output. The OpenAI-compatible SDK copies every provider option it does not know into the
 * request body after `max_tokens`, so one of these among the options would replace the cap the probe sets.
 */
const OUTPUT_CAP_FIELDS: readonly string[] = ["max_tokens", "max_completion_tokens"]

function withoutOutputCap(providerOptions: ProviderOptions | undefined): ProviderOptions | undefined {
  if (providerOptions === undefined) return undefined
  return Object.fromEntries(
    Object.entries(providerOptions).map(([name, values]) => [
      name,
      Object.fromEntries(Object.entries(values).filter(([field]) => !OUTPUT_CAP_FIELDS.includes(field))),
    ]),
  )
}

async function chat(
  language: LanguageModel,
  timeoutMs: number,
  providerOptions: ProviderOptions | undefined,
  request: ChatRequest,
): Promise<ChatResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  const raw: unknown[] = []
  const toolCalls: ProbeFindings.ToolCallResult[] = []
  let failure: Failure | undefined
  try {
    const result = streamText({
      model: language,
      messages: request.messages,
      tools: request.tools,
      providerOptions,
      maxOutputTokens: request.maxOutputTokens,
      maxRetries: 0,
      includeRawChunks: true,
      // Failures come back through fullStream below; none of them may reach the console.
      onError: () => {},
      abortSignal: signal,
    })
    for await (const part of result.fullStream) {
      if (part.type === "raw") raw.push(part.rawValue)
      else if (part.type === "tool-call") {
        toolCalls.push({
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
          ...(part.invalid ? { invalid: true } : {}),
        })
      } else if (part.type === "error") failure ??= failureOf(part.error)
      else if (part.type === "abort") failure ??= { error: part.reason ?? "aborted" }
    }
  } catch (error) {
    failure ??= failureOf(error)
  }
  if (failure === undefined) return { raw, toolCalls }
  return {
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    error: failure.error,
    // The only abort the probe starts is its own deadline.
    ...(signal.aborted ? { timedOut: true } : {}),
    raw,
    toolCalls,
  }
}

export function make(options: Options): Transport {
  const timeoutMs = options.timeoutMs ?? ProbePlan.REQUEST_TIMEOUT_MS
  const providerOptions = withoutOutputCap(options.providerOptions)
  return {
    models: () => models(options, timeoutMs),
    chat: (request) => chat(options.language, timeoutMs, providerOptions, request),
  }
}

export * as ProbeTransport from "./transport"
