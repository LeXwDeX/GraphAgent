import { NamedError } from "@graphagent/core/util/error"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule, Schema } from "effect"
import { isRecord } from "@/util/record"
import { REASONING_STATE_MESSAGE } from "@/provider/error"
import { ProviderErrorClass } from "@/provider/error-class"

export type Err = ReturnType<NamedError["toObject"]>

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
  "rate_limit" | "auth" | "compaction" | "http" | "network" | "protocol" | "fallback" | "terminal"

/**
 * One row of the retry dispatch table. `maxRetries` counts retries after the
 * first attempt, so 0 means the failure is never resent. `class` says what the
 * failure means (#1466); the retry branch alone cannot, since a retried `http`
 * failure may be a server fault or a request that will never succeed.
 */
export type RetryDecision = {
  branch: RetryBranch
  class: ProviderErrorClass.ErrorClass
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
// The Responses WebSocket pool's DEFAULT_STREAM_RETRIES must stay below this, so the last attempt of a turn can
// run over the HTTP fallback (openai-ws-retry-budget.test.ts).
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

function terminal(
  branch: "terminal" | "auth" | "compaction",
  cls: ProviderErrorClass.ErrorClass,
  message: string,
  status?: number,
): RetryDecision {
  return { branch, class: cls, message, status, maxRetries: 0 }
}

function retry(
  branch: "rate_limit" | "http" | "network" | "protocol",
  cls: ProviderErrorClass.ErrorClass,
  message: string,
  options?: { status?: number; action?: Retryable["action"]; maxRetries?: number },
): RetryDecision {
  return {
    branch,
    class: cls,
    message,
    status: options?.status,
    action: options?.action,
    maxRetries: options?.maxRetries ?? RETRY_MAX_RETRIES,
  }
}

function overloaded(message: string) {
  return message.includes("Overloaded") ? "Provider is overloaded" : message
}

/**
 * True when the error itself says time can fix it: the provider flagged it
 * retryable, or its message or body names a rate limit, a timeout, an overload,
 * a gateway circuit breaker, and so on.
 */
function transientSignal(error: Err): boolean {
  return (
    SessionV1.APIError.isInstance(error) &&
    (error.data.isRetryable ||
      matchesRetryableMessage(error.data.message) ||
      matchesRetryableMessage(error.data.responseBody))
  )
}

/**
 * The provider error table's verdict on an API error, when a row names it. A
 * spent quota, a content refusal and a request the table calls invalid are
 * final; the per-minute allocation some providers report as a quota is a rate
 * limit and keeps its backoff.
 */
function tableDecision(error: SessionV1.APIError, transient: boolean): RetryDecision | undefined {
  const row = ProviderErrorClass.match(ProviderErrorClass.factsOf(error.data), transient)
  if (row === undefined) return undefined
  const { message, statusCode: status } = error.data
  if (row === "rate_limited") return retry("rate_limit", row, overloaded(message), { status })
  return terminal("terminal", row, message, status)
}

/**
 * The single dispatch table for retryable failures. Every HTTP 400–599
 * `APIError` and every network failure enters here first; the branch then
 * selects the bounded recovery. Keeping the table in one place means the base
 * backoff, the attempt cap and the terminal exceptions cannot drift.
 *
 * An API error first meets the provider error table (`ProviderErrorClass`), so
 * what the provider said outranks the status code: a 429 that reports a spent
 * plan is final, a 403 that reports a spent quota is not a credential failure.
 */
export function classify(error: Err, provider: string): RetryDecision {
  if (SessionV1.AbortedError.isInstance(error)) return terminal("terminal", "invalid_request", messageOf(error))
  if (SessionV1.ContextOverflowError.isInstance(error))
    return terminal("compaction", "context_overflow", messageOf(error))
  if (SessionV1.AuthError.isInstance(error)) return terminal("auth", "auth", messageOf(error))
  if (SessionV1.OutputLengthError.isInstance(error)) return terminal("terminal", "invalid_request", messageOf(error))
  if (SessionV1.StructuredOutputError.isInstance(error))
    return terminal("terminal", "invalid_request", messageOf(error))
  if (SessionV1.ContentFilterError.isInstance(error)) return terminal("terminal", "content_refused", messageOf(error))
  if (IncompleteResponseError.isInstance(error)) return retry("protocol", "transient", error.data.message)
  if (EmptyResponseError.isInstance(error)) return retry("protocol", "transient", error.data.message)
  if (IncompleteReasoningResponseError.isInstance(error)) return retry("protocol", "transient", error.data.message)

  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    const message = error.data.message
    // Resending rejected signed reasoning cannot succeed; /compact is the recovery.
    if (message === REASONING_STATE_MESSAGE) return terminal("terminal", "invalid_request", message, status)
    const transient = transientSignal(error)
    const row = tableDecision(error, transient)
    if (row) return row
    // The provider auth loader refreshes credentials inside the request. One
    // bounded retry gives that recovery path a second chance; a second auth
    // failure stops instead of backing off blindly.
    if (status === 401 || status === 403) return { branch: "auth", class: "auth", status, message, maxRetries: 1 }
    // 413 and the parsed context-overflow error belong to compaction. Never
    // resend the same oversized request unchanged.
    if (status === 413) return terminal("compaction", "context_overflow", message, status)

    if (status !== undefined && status >= 400 && status < 600) {
      if (status === 429 || status === 503) return retry("rate_limit", "rate_limited", overloaded(message), { status })
      // Past the table, a 4xx without a transient signal still backs off on the wire, but it is
      // a request that fails again on resend: `invalid_request` is what `retryable` reads.
      // 404 is the clearest case — the path or model does not exist — so it stops at once
      // instead of resending an identical request five times. 408 keeps its backoff: that
      // one is a transient signal by name.
      if (status === 404 && !transient) return terminal("terminal", "invalid_request", message, status)
      return retry("http", status >= 500 || transient ? "transient" : "invalid_request", overloaded(message), {
        status,
      })
    }

    if (transient) return retry("network", "transient", overloaded(message), { status })
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message === "string") {
    const lower = message.toLowerCase()
    if (lower.includes("too_many_requests")) return retry("rate_limit", "rate_limited", "Too Many Requests")
    if (lower.includes("exhausted") || lower.includes("unavailable"))
      return retry("rate_limit", "rate_limited", "Provider is overloaded")
    if (matchesRetryableMessage(message)) return retry("network", "transient", message)
  }
  return {
    branch: "fallback",
    class: "transient",
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
 * answer (class `invalid_request`) cannot succeed on resend. Report it as
 * unrecoverable so the caller pauses visibly instead of spending a recovery
 * turn on the same rejection.
 * The exceptions keep the pre-existing transient signals: a flagged
 * `isRetryable`, or a message/body that names a rate limit, timeout, gateway
 * circuit breaker, and so on. 5xx answers stay recoverable regardless.
 */
export function retryable(error: Err, provider: string) {
  const decision = classify(error, provider)
  if (decision.maxRetries === 0) return undefined
  if (decision.branch === "auth" || decision.branch === "fallback") return undefined
  if (decision.class === "invalid_request") return undefined
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

/**
 * The error as it is persisted for the user. A failure that ends the turn on a
 * spent quota, rejected credentials or a content refusal gets one more line: the
 * provider's own message first, then what to do about it (#1466). Only an
 * `APIError` and a `ProviderAuthError` carry it; any other error, and any class
 * that needs no advice, comes back as the same object.
 */
export function withHint<E extends Err>(error: E, provider: string): E
export function withHint(error: Err, provider: string): Err {
  if (!SessionV1.APIError.isInstance(error) && !SessionV1.AuthError.isInstance(error)) return error
  const hint = ProviderErrorClass.hintOf(classify(error, provider).class, provider)
  if (!hint || error.data.message.includes(hint)) return error
  // Same name, same data shape: only the message gains a line, so the caller's own type still holds.
  return { name: error.name, data: { ...error.data, message: `${error.data.message}\n${hint}` } }
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  /** Attempt-local safety gate, checked after the dispatch table classifies the failure. */
  shouldRetry?: (error: unknown) => boolean
  /** Called when the safety gate stops a retry, so the caller can record its reason. */
  onGated?: () => void
  /** Gate state logged when the gate or the attempt cap stops a retry. */
  gates?: () => Record<string, unknown>
  /**
   * Called with the computed backoff when the dispatch table classifies the
   * failure as a provider rate limit, so the process scheduler can penalize
   * that provider/model lane before the retry is resent (#1021). The callback
   * carries no error channel: it must not fail the retry schedule.
   */
  onRateLimit?: (input: { message: string; retryAfterMs: number }) => Effect.Effect<void>
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
      if (opts.shouldRetry?.(meta.input) === false) {
        opts.onGated?.()
        return stop("gated")
      }
      if (meta.attempt > decision.maxRetries) return stop("exhausted")
      return Effect.gen(function* () {
        const wait =
          decision.branch === "fallback"
            ? fallbackDelay(meta.attempt)
            : decision.branch === "rate_limit"
              ? delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
              : delay(meta.attempt)
        if (decision.branch === "rate_limit" && opts.onRateLimit) {
          yield* opts.onRateLimit({ message: decision.message, retryAfterMs: wait })
        }
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
