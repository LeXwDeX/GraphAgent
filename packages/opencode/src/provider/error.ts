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

export type ResponseStreamFailureKind =
  "close" | "socket-error" | "idle-timeout" | "connection-limit" | "protocol-error"

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"
  public readonly kind?: ResponseStreamFailureKind
  public readonly closeCode?: number
  public readonly closeReason?: string

  constructor(
    message: string,
    options?: ErrorOptions & { kind?: ResponseStreamFailureKind; closeCode?: number; closeReason?: string },
  ) {
    super(message, options)
    this.kind = options?.kind
    this.closeCode = options?.closeCode
    this.closeReason = options?.closeReason
  }
}

const RETRYABLE_STREAM_CLOSE_CODES = new Set([1001, 1006, 1011, 1012, 1013, 1014])

/** Only transient transport failures are retryable; deterministic or policy closes are not. */
export function isRetryableResponseStreamError(error: ResponseStreamError) {
  if (error.kind === "protocol-error") return false
  if (error.kind === "close") {
    return error.closeCode !== undefined && RETRYABLE_STREAM_CLOSE_CODES.has(error.closeCode)
  }
  return true
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

const WRAPPED_SUCCESS_RESPONSE = "Failed to process successful response"

function isWrappedSuccessResponse(error: APICallError) {
  return (
    error.message === WRAPPED_SUCCESS_RESPONSE &&
    error.statusCode !== undefined &&
    error.statusCode >= 200 &&
    error.statusCode < 300
  )
}

/** Unwrap the provider-utils status-200 wrapper so upstream status and body stay observable. */
function unwrapSuccessResponseError(input: APICallError): APICallError | ResponseStreamError | undefined {
  if (!isWrappedSuccessResponse(input)) return undefined
  let current: unknown = input.cause
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof ResponseStreamError) return current
    if (APICallError.isInstance(current) && !isWrappedSuccessResponse(current)) return current
    if (typeof current !== "object" || !("cause" in current)) return undefined
    current = current.cause
  }
  return undefined
}

function causeMessage(input: unknown): string | undefined {
  let current = input
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof Error && current.message) return current.message
    if (typeof current === "string" && current) return current
    if (typeof current !== "object" || !("cause" in current)) return undefined
    current = current.cause
  }
  return undefined
}

function errorDetail(input: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !isRecord(input)) return undefined
  if (isRecord(input.error)) return input.error
  if (isRecord(input.response) && isRecord(input.response.error)) return input.response.error
  if (isRecord(input.response)) {
    const found = errorDetail(input.response, depth + 1)
    if (found) return found
  }
  return undefined
}

function apiCallErrorMetadata(error: APICallError) {
  const metadata: Record<string, string> = {}
  if (error.url) metadata.url = error.url
  const detail = errorDetail(error.data)
  if (detail) {
    if (typeof detail.code === "string") metadata.code = detail.code
    if (typeof detail.type === "string") metadata.type = detail.type
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
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
  const unwrapped = unwrapSuccessResponseError(input.error)
  if (unwrapped instanceof ResponseStreamError) {
    return {
      type: "api_error",
      message: unwrapped.message,
      isRetryable: isRetryableResponseStreamError(unwrapped),
      metadata: {
        code: unwrapped.name,
        ...(unwrapped.kind ? { kind: unwrapped.kind } : {}),
        ...(unwrapped.closeCode !== undefined ? { closeCode: String(unwrapped.closeCode) } : {}),
        ...(unwrapped.closeReason ? { closeReason: unwrapped.closeReason } : {}),
      },
    }
  }
  const genericWrapper = unwrapped === undefined && isWrappedSuccessResponse(input.error)
  const error = unwrapped ?? input.error
  const m = genericWrapper
    ? (causeMessage(input.error.cause) ?? message(input.providerID, error))
    : message(input.providerID, error)
  const body = json(error.responseBody)
  if (isContextOverflow(m) || error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: error.responseBody,
    }
  }

  const metadata = apiCallErrorMetadata(error)
  if (isReasoningStateFailure(error) || isReasoningStateFailure(m)) {
    return {
      type: "api_error",
      message: REASONING_STATE_MESSAGE,
      statusCode: error.statusCode,
      isRetryable: false,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody ?? reasoningStateDiagnostics(error).responseBody,
      metadata,
    }
  }
  return {
    type: "api_error",
    message: m,
    statusCode: genericWrapper ? undefined : error.statusCode,
    isRetryable: genericWrapper
      ? false
      : input.providerID.startsWith("openai")
        ? isOpenAiErrorRetryable(error)
        : error.isRetryable,
    responseHeaders: genericWrapper ? undefined : error.responseHeaders,
    responseBody: error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
