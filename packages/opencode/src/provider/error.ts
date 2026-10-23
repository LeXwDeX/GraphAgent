import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export const REASONING_STATE_MESSAGE =
  "The provider rejected saved reasoning state. Run /compact, or start a new session, to discard it and continue."

const reasoningFailureWords = /could not|cannot|can't|failed|invalid|unable|not be|mismatch|corrupt|expired/

function isReasoningFailureText(value: string) {
  const text = value.toLowerCase()
  if (/\binvalid_encrypted_content\b/.test(text)) return true
  if (/encrypted[\s_-]?content/.test(text) && reasoningFailureWords.test(text)) return true
  return text.includes("signature") && /thinking|reasoning/.test(text) && reasoningFailureWords.test(text)
}

/** Recognize only failures the model reports for replayed opaque reasoning, never generic auth signatures. */
export function isReasoningStateFailure(input: unknown) {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value == null || seen.has(value)) return false
    if (typeof value === "string") return isReasoningFailureText(value)
    if (typeof value !== "object") return false
    if (value instanceof Error && visit(value.message, depth + 1)) return true
    seen.add(value)
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1))
    if (!isRecord(value)) return false
    return ["message", "responseBody", "value", "cause", "error", "reason", "detail", "body", "response", "code"].some(
      (key) => visit(value[key], depth + 1),
    )
  }
  return visit(input, 0)
}

/** Preserve the original upstream body and status when a rejected-reasoning error is wrapped by the SDK. */
export function reasoningStateDiagnostics(input: unknown): {
  responseBody?: string
  statusCode?: number
  responseHeaders?: Record<string, string>
} {
  let responseBody: string | undefined
  let statusCode: number | undefined
  let responseHeaders: Record<string, string> | undefined
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value == null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    if (!isRecord(value)) return
    if (responseBody === undefined && typeof value.responseBody === "string") responseBody = value.responseBody
    if (responseBody === undefined && value.value !== undefined) {
      try {
        const body = typeof value.value === "string" ? value.value : JSON.stringify(value.value)
        if (body && isReasoningFailureText(body)) responseBody = body
      } catch {}
    }
    if (statusCode === undefined) {
      const status = [value.statusCode, value.status, value.status_code].find((item) => typeof item === "number")
      if (typeof status === "number") statusCode = status
    }
    if (responseHeaders === undefined) {
      for (const key of ["responseHeaders", "headers"]) {
        const headers = value[key]
        if (!isRecord(headers)) continue
        const found = Object.fromEntries(
          Object.entries(headers).flatMap(([name, header]) => (typeof header === "string" ? [[name, header]] : [])),
        )
        if (Object.keys(found).length > 0) {
          responseHeaders = found
          break
        }
      }
    }
    for (const key of ["cause", "value", "error", "response"]) visit(value[key], depth + 1)
  }
  visit(input, 0)
  return { responseBody, statusCode, responseHeaders }
}

export function findResponseStreamError(input: unknown): ResponseStreamError | undefined {
  let current = input
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    if (current instanceof ResponseStreamError) return current
    seen.add(current)
    if (typeof current !== "object" || !("cause" in current)) return
    current = current.cause
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (isReasoningStateFailure(input)) {
    return {
      type: "api_error",
      message: REASONING_STATE_MESSAGE,
      isRetryable: false,
      responseBody:
        reasoningStateDiagnostics(input).responseBody ??
        (typeof input === "string" ? input : body ? JSON.stringify(body) : "{}"),
    }
  }
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }

  return {
    type: "api_error",
    message: typeof body?.error?.message === "string" ? body.error.message : "Server error.",
    isRetryable: true,
    responseBody,
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  if (isReasoningStateFailure(input.error) || isReasoningStateFailure(m)) {
    return {
      type: "api_error",
      message: REASONING_STATE_MESSAGE,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody ?? reasoningStateDiagnostics(input.error).responseBody,
      metadata,
    }
  }
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
