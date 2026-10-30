import { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule, Schema } from "effect"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
import { REASONING_STATE_MESSAGE } from "@/provider/error"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

/**
 * A model response that ended before an unfinished tool call became
 * executable (unknown/missing finish reason). Classified by the retry policy
 * only when no tool in the failed request has executed or may have executed;
 * the processor owns that admission gate.
 */
export const IncompleteResponseError = NamedError.create("IncompleteResponseError", {
  message: Schema.String,
})

export const INCOMPLETE_RESPONSE_MESSAGE = "The model response ended before the tool call was complete"

/**
 * A normal-conversation attempt that produced no substantive output at all:
 * no text, no reasoning, no tool activity — only bookkeeping signals with an
 * unknown, missing, or plain stop finish. The processor raises it inside the
 * retry boundary; the policy retries it like any other protocol failure.
 */
export const EmptyResponseError = NamedError.create("EmptyResponseError", {
  message: Schema.String,
})

export const EMPTY_RESPONSE_MESSAGE = "The model returned an empty response with no content or tool activity"

/** An abnormally ended reasoning-only attempt without an answer or tool activity. */
export const IncompleteReasoningResponseError = NamedError.create("IncompleteReasoningResponseError", {
  message: Schema.String,
})

export const INCOMPLETE_REASONING_RESPONSE_MESSAGE = "The model response ended after reasoning without an answer"

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export type RetryBranch =
  | "rate_limit"
  | "auth"
  | "compaction"
  | "http"
  | "network"
  | "protocol"
  | "fallback"
  | "terminal"

/**
 * One row of the retry dispatch table. `maxRetries` counts retries after the
 * first attempt, so 0 means the failure is never resent.
 */
export type RetryDecision = {
  branch: RetryBranch
  status?: number
  message: string
  action?: Retryable["action"]
  maxRetries: number
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5

// Catch-all reconnect for failures no rule recognises: 3s, 6s, 6s.
export const FALLBACK_INITIAL_DELAY = 3000
export const FALLBACK_MAX_DELAY = 6000
export const FALLBACK_MAX_RETRIES = 3

const RETRYABLE_MESSAGE_PATTERNS = [
  // Bounded so token counts or IDs in a 4xx body ("150000 tokens") never read as a status.
  /\b(?:429|500|502|503|504|524)\b/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  // Gateway circuit breakers reject while every upstream target is tripped, often with a 4xx status.
  /\ball targets recovering\b|\bhalf[-_\s]open\b|\bcircuit(?:[-_\s]breaker)?(?:\s+is)?[-_\s]open\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      // Headers without a usable retry hint still fall back to the base
      // backoff, so the no-header ceiling applies here too.
      return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

export function fallbackDelay(attempt: number) {
  return Math.min(FALLBACK_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), FALLBACK_MAX_DELAY)
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

function messageOf(error: Err) {
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && message ? message : error.name
}

function terminal(branch: "terminal" | "auth" | "compaction", message: string, status?: number): RetryDecision {
  return { branch, message, status, maxRetries: 0 }
}

function retry(
  branch: "rate_limit" | "http" | "network" | "protocol",
  message: string,
  options?: { status?: number; action?: Retryable["action"]; maxRetries?: number },
): RetryDecision {
  return {
    branch,
    message,
    status: options?.status,
    action: options?.action,
    maxRetries: options?.maxRetries ?? RETRY_MAX_RETRIES,
  }
}

function overloaded(message: string) {
  return message.includes("Overloaded") ? "Provider is overloaded" : message
}

function usageLimit(error: SessionV1.APIError, provider: string): Retryable | undefined {
  if (error.data.responseBody?.includes("FreeUsageLimitError")) {
    return {
      message: GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider,
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
        label: "subscribe",
        link: GO_UPSELL_URL,
      },
    }
  }
  if (error.data.responseBody?.includes("GoUsageLimitError")) {
    const body = parseJSON(error.data.responseBody)
    const workspace = str(body?.metadata?.workspace)
    const limitName = str(body?.metadata?.limitName)
    const retryAfter = num(error.data.responseHeaders?.["retry-after"])
    const resetIn = iife(() => {
      if (retryAfter === undefined) return ""
      const seconds = Math.max(0, Math.ceil(retryAfter))
      const days = Math.floor(seconds / 86_400)
      const hours = Math.floor((seconds % 86_400) / 3_600)
      const minutes = Math.ceil((seconds % 3_600) / 60)
      const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

      if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
      if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
      return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
    })

    const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

    const link = `https://opencode.ai/workspace/${workspace}/go`
    return {
      message: `${message} - ${link}`,
      action: {
        reason: "account_rate_limit",
        provider,
        title: "Go limit reached",
        message,
        label: "open settings",
        link,
      },
    }
  }
  return undefined
}

/**
 * The single dispatch table for retryable failures. Every HTTP 400–599
 * `APIError` and every network failure enters here first; the branch then
 * selects the bounded recovery. Keeping the table in one place means the base
 * backoff, the attempt cap and the terminal exceptions cannot drift.
 */
export function classify(error: Err, provider: string): RetryDecision {
  if (SessionV1.AbortedError.isInstance(error)) return terminal("terminal", messageOf(error))
  if (SessionV1.ContextOverflowError.isInstance(error)) return terminal("compaction", messageOf(error))
  if (SessionV1.AuthError.isInstance(error)) return terminal("auth", messageOf(error))
  if (SessionV1.OutputLengthError.isInstance(error)) return terminal("terminal", messageOf(error))
  if (SessionV1.StructuredOutputError.isInstance(error)) return terminal("terminal", messageOf(error))
  if (SessionV1.ContentFilterError.isInstance(error)) return terminal("terminal", messageOf(error))
  if (IncompleteResponseError.isInstance(error)) return retry("protocol", error.data.message)
  if (EmptyResponseError.isInstance(error)) return retry("protocol", error.data.message)
  if (IncompleteReasoningResponseError.isInstance(error)) return retry("protocol", error.data.message)

  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    const message = error.data.message
    // Resending rejected signed reasoning cannot succeed; /compact is the recovery.
    if (message === REASONING_STATE_MESSAGE) return terminal("terminal", message, status)
    // The provider auth loader refreshes credentials inside the request. One
    // bounded retry gives that recovery path a second chance; a second auth
    // failure stops instead of backing off blindly.
    if (status === 401 || status === 403) return { branch: "auth", status, message, maxRetries: 1 }
    // 413 and the parsed context-overflow error belong to compaction. Never
    // resend the same oversized request unchanged.
    if (status === 413) return terminal("compaction", message, status)

    const limit = usageLimit(error, provider)
    if (limit) return retry("rate_limit", limit.message, { status, action: limit.action })

    if (status !== undefined && status >= 400 && status < 600) {
      return retry(status === 429 || status === 503 ? "rate_limit" : "http", overloaded(message), { status })
    }

    if (error.data.isRetryable || matchesRetryableMessage(message) || matchesRetryableMessage(error.data.responseBody)) {
      return retry("network", overloaded(message), { status })
    }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message === "string") {
    const lower = message.toLowerCase()
    if (lower.includes("too_many_requests")) return retry("rate_limit", "Too Many Requests")
    if (lower.includes("exhausted") || lower.includes("unavailable")) return retry("rate_limit", "Provider is overloaded")
    if (matchesRetryableMessage(message)) return retry("network", message)
  }
  return {
    branch: "fallback",
    message: typeof message === "string" && message ? message : "Unknown error, reconnecting",
    maxRetries: FALLBACK_MAX_RETRIES,
  }
}

/**
 * Compatibility classifier for callers that decide whether a failed turn is
 * worth continuing (goal recovery, StopFailure routing). Auth recovery, the
 * compaction handoff and the fallback reconnect are policy concerns and are
 * not reported here.
 *
 * The HTTP policy retries every 4xx/5xx on the wire, but a deterministic 4xx
 * answer cannot succeed on resend. Report it as unrecoverable so the caller
 * pauses visibly instead of spending a recovery turn on the same rejection.
 * The exceptions keep the pre-existing transient signals: a flagged
 * `isRetryable`, or a message/body that names a rate limit, timeout, gateway
 * circuit breaker, and so on. 5xx answers stay recoverable regardless.
 */
export function retryable(error: Err, provider: string) {
  const decision = classify(error, provider)
  if (decision.maxRetries === 0) return undefined
  if (decision.branch === "auth" || decision.branch === "fallback") return undefined
  if (decision.branch === "http" && decision.status !== undefined && decision.status < 500) {
    const transient =
      SessionV1.APIError.isInstance(error) &&
      (error.data.isRetryable ||
        matchesRetryableMessage(error.data.message) ||
        matchesRetryableMessage(error.data.responseBody))
    if (!transient) return undefined
  }
  return { message: decision.message, ...(decision.action ? { action: decision.action } : {}) }
}

/**
 * Unrecognised failures get a bounded reconnect attempt. Failures with a known
 * terminal meaning stay terminal. HTTP 4xx/5xx answers never reach here:
 * `classify` already routes them through the shared exponential backoff.
 */
export function fallback(error: Err): Retryable | undefined {
  const decision = classify(error, "")
  if (decision.branch !== "fallback" || decision.maxRetries === 0) return undefined
  return { message: decision.message }
}

/** True when the dispatch table hands this failure to context compaction. */
export function isCompactionFailure(error: Err) {
  return classify(error, "").branch === "compaction"
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  /** Attempt-local safety gate, checked after the dispatch table classifies the failure. */
  shouldRetry?: (error: unknown) => boolean
  /** Gate state logged when the gate or the attempt cap stops a retry. */
  gates?: () => Record<string, unknown>
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const decision = classify(error, opts.provider)
      // A retryable failure that ends here is logged with its reason, so a
      // surfaced provider error shows whether a gate or the cap stopped it.
      const stop = (reason: string) =>
        Effect.logWarning("retry stopped", {
          reason,
          branch: decision.branch,
          ...(decision.status !== undefined ? { status: decision.status } : {}),
          attempt: meta.attempt,
          maxRetries: decision.maxRetries,
          provider: opts.provider,
          error: decision.message,
          ...(opts.gates?.() ?? {}),
        }).pipe(Effect.andThen(Cause.done(meta.attempt)))
      if (decision.maxRetries === 0) return Cause.done(meta.attempt)
      if (opts.shouldRetry?.(meta.input) === false) return stop("gated")
      if (meta.attempt > decision.maxRetries) return stop("exhausted")
      return Effect.gen(function* () {
        const wait =
          decision.branch === "fallback"
            ? fallbackDelay(meta.attempt)
            : decision.branch === "rate_limit"
              ? delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
              : delay(meta.attempt)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: decision.message,
          action: decision.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
