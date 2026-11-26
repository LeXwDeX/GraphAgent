import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { NamedError } from "@graphagent/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Effect, Exit, Fiber, Logger, Schedule, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import {
  ContentPolicyReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  QuotaExceededReason,
} from "@graphagent/llm"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(LayerNode.buildLayer(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>, statusCode?: number): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      statusCode,
      responseHeaders: headers,
    }).toObject(),
  )
}

function statusError(statusCode: number, headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: `status ${statusCode}`,
      isRetryable: false,
      statusCode,
      responseHeaders: headers,
    }).toObject(),
  )
}

/** An API error as the provider reported it: status, flag, body and metadata chosen by the case. */
function providerError(init: {
  message?: string
  statusCode?: number
  isRetryable?: boolean
  responseBody?: unknown
  metadata?: Record<string, string>
}): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: init.message ?? `status ${init.statusCode ?? "none"}`,
      isRetryable: init.isRetryable ?? false,
      statusCode: init.statusCode,
      responseBody: init.responseBody === undefined ? undefined : JSON.stringify(init.responseBody),
      metadata: init.metadata,
    }).toObject(),
  )
}

/**
 * A native-runtime 429 the way the executor reports it for any body that says "quota exceeded": the body sits in the
 * message and in the HTTP context, and the reason carries the `QuotaExceeded` tag whatever the body means.
 */
function nativeQuota(body: string, headers: Record<string, string> = {}) {
  return MessageV2.fromError(
    new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new QuotaExceededReason({
        message: `Provider request failed with HTTP 429: ${body}`,
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://provider.test/v1/chat", headers: {} }),
          response: new HttpResponseDetails({ status: 429, headers }),
          body,
        }),
      }),
    }),
    { providerID },
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

function retryStopped(logs: unknown[]) {
  const entry = logs.find((message) => Array.isArray(message) && message[0] === "retry stopped")
  return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : undefined
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, 0))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("caps exponential fallback at 30 seconds when headers carry no retry hint", () => {
    const error = apiError({ "x-request-id": "req-1" })
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, 0))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("adds jitter to exponential delays", () => {
    const error = apiError()
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
    expect(SessionRetry.delay(1, error, 1)).toBe(2500)
    expect(SessionRetry.delay(4, error, 1)).toBe(20000)
    expect(SessionRetry.delay(5, error, 1)).toBe(30000)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" }, 429)
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  it.instance("policy stops after five retries and logs the dispatch", () =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const logs: unknown[] = []
      const collector = Logger.make((opts) => {
        logs.push(opts.message)
      })
      const error = statusError(503, { "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          gates: () => ({ aborted: false, pendingToolExecutions: 0 }),
          set: (info) =>
            Effect.sync(() => {
              attempts.push(info.attempt)
            }),
        }),
      )

      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES + 1 }), () =>
        Effect.ignore(step(error)),
      ).pipe(Effect.withLogger(collector))

      expect(attempts).toStrictEqual([1, 2, 3, 4, 5])
      expect(retryStopped(logs)).toMatchObject({
        reason: "exhausted",
        branch: "rate_limit",
        status: 503,
        attempt: SessionRetry.RETRY_MAX_RETRIES + 1,
        maxRetries: SessionRetry.RETRY_MAX_RETRIES,
        provider: "test",
        aborted: false,
        pendingToolExecutions: 0,
      })
    }),
  )

  it.instance("policy logs a gated stop with its dispatch branch", () =>
    Effect.gen(function* () {
      const logs: unknown[] = []
      const collector = Logger.make((opts) => {
        logs.push(opts.message)
      })
      const error = statusError(503, { "retry-after-ms": "0" })
      let gated = 0
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          shouldRetry: () => false,
          onGated: () => {
            gated += 1
          },
          gates: () => ({ aborted: true, pendingToolExecutions: 1 }),
          set: () => Effect.void,
        }),
      )

      yield* Effect.ignore(step(error)).pipe(Effect.withLogger(collector))

      expect(gated).toBe(1)
      expect(retryStopped(logs)).toMatchObject({
        reason: "gated",
        branch: "rate_limit",
        status: 503,
        attempt: 1,
        maxRetries: SessionRetry.RETRY_MAX_RETRIES,
        provider: "test",
        aborted: true,
        pendingToolExecutions: 1,
      })
    }),
  )

  it.instance("policy keeps the gate callback idle when a retry continues", () =>
    Effect.gen(function* () {
      let gated = 0
      const error = statusError(503, { "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          shouldRetry: () => true,
          onGated: () => {
            gated += 1
          },
          set: () => Effect.void,
        }),
      )

      yield* Effect.ignore(step(error))

      expect(gated).toBe(0)
    }),
  )

  test("policy backs a 4xx off exactly like a 5xx and honors rate-limit headers only", () =>
    Effect.gen(function* () {
      const waitsFor = (statusCode: number, headers?: Record<string, string>) =>
        Effect.gen(function* () {
          const waits: number[] = []
          let calls = 0
          const fiber = yield* Effect.suspend(() => {
            calls++
            return Effect.fail(
              new SessionV1.APIError({
                message: `status ${statusCode}`,
                isRetryable: false,
                statusCode,
                responseHeaders: headers,
              }).toObject(),
            )
          }).pipe(
            Effect.retry(
              SessionRetry.policy({
                provider: "test",
                parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
                set: (info) =>
                  Effect.gen(function* () {
                    waits.push(info.next - (yield* Clock.currentTimeMillis))
                  }),
              }),
            ),
            Effect.exit,
            Effect.forkChild,
          )
          yield* TestClock.adjust("5 minutes")
          yield* Fiber.join(fiber)
          return { calls, waits }
        })

      for (const statusCode of [400, 429, 502]) {
        const { calls, waits } = yield* waitsFor(statusCode)
        expect(calls).toBe(SessionRetry.RETRY_MAX_RETRIES + 1)
        waits.forEach((wait, index) => {
          const base = SessionRetry.RETRY_INITIAL_DELAY * Math.pow(SessionRetry.RETRY_BACKOFF_FACTOR, index)
          expect(wait).toBeGreaterThanOrEqual(Math.min(base, SessionRetry.RETRY_MAX_DELAY_NO_HEADERS))
          expect(wait).toBeLessThanOrEqual(
            Math.min(Math.ceil(base * (1 + SessionRetry.RETRY_JITTER_FACTOR)), SessionRetry.RETRY_MAX_DELAY_NO_HEADERS),
          )
        })
      }

      for (const statusCode of [429, 503]) {
        const { waits } = yield* waitsFor(statusCode, { "retry-after-ms": "1500" })
        expect(waits[0]).toBe(1500)
      }
      for (const statusCode of [400, 502]) {
        const { waits } = yield* waitsFor(statusCode, { "retry-after-ms": "1500" })
        expect(waits[0]).toBeGreaterThanOrEqual(SessionRetry.RETRY_INITIAL_DELAY)
        expect(waits[0]).toBeLessThanOrEqual(
          Math.ceil(SessionRetry.RETRY_INITIAL_DELAY * (1 + SessionRetry.RETRY_JITTER_FACTOR)),
        )
      }
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("policy retries a 401 once through the auth branch and then stops", () =>
    Effect.gen(function* () {
      let calls = 0
      const logs: unknown[] = []
      const collector = Logger.make((opts) => {
        logs.push(opts.message)
      })
      const error = statusError(401)
      const fiber = yield* Effect.suspend(() => {
        calls++
        return Effect.fail(error)
      }).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            gates: () => ({ aborted: false }),
            set: () => Effect.void,
          }),
        ),
        Effect.exit,
        Effect.withLogger(collector),
        Effect.forkChild,
      )
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(calls).toBe(2)
      expect(retryStopped(logs)).toMatchObject({
        reason: "exhausted",
        branch: "auth",
        status: 401,
        attempt: 2,
        maxRetries: 1,
        aborted: false,
      })
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("policy hands a 413 and a context overflow to compaction without resending", () =>
    Effect.gen(function* () {
      for (const error of [
        statusError(413),
        new SessionV1.ContextOverflowError({ message: "Input exceeds context window of this model" }).toObject(),
      ]) {
        let calls = 0
        const waits: number[] = []
        const fiber = yield* Effect.suspend(() => {
          calls++
          return Effect.fail(error)
        }).pipe(
          Effect.retry(
            SessionRetry.policy({
              provider: "test",
              parse: (input) => input as ReturnType<NamedError["toObject"]>,
              set: (info) =>
                Effect.sync(() => {
                  waits.push(info.next)
                }),
            }),
          ),
          Effect.exit,
          Effect.forkChild,
        )
        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(fiber)

        expect(calls).toBe(1)
        expect(waits).toStrictEqual([])
        expect(SessionRetry.classify(error, "test")).toMatchObject({ branch: "compaction", maxRetries: 0 })
      }
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("policy sends a spent balance or quota once and never backs off", () =>
    Effect.gen(function* () {
      for (const error of [
        statusError(402),
        providerError({
          statusCode: 429,
          message: "已达到 5 小时的使用上限",
          responseBody: { error: { code: "1308", message: "已达到 5 小时的使用上限" } },
        }),
        new SessionV1.APIError({
          message: "Quota exceeded.",
          isRetryable: false,
          responseBody: '{"type":"error","error":{"code":"insufficient_quota"}}',
        }).toObject(),
      ]) {
        let calls = 0
        const waits: number[] = []
        const fiber = yield* Effect.suspend(() => {
          calls++
          return Effect.fail(error)
        }).pipe(
          Effect.retry(
            SessionRetry.policy({
              provider: "test",
              parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
              set: (info) =>
                Effect.sync(() => {
                  waits.push(info.next)
                }),
            }),
          ),
          Effect.exit,
          Effect.forkChild,
        )
        yield* TestClock.adjust("5 minutes")
        yield* Fiber.join(fiber)

        expect(calls).toBe(1)
        expect(waits).toStrictEqual([])
        expect(SessionRetry.classify(error, "test")).toMatchObject({ class: "quota_exhausted", maxRetries: 0 })
      }
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("policy backs a native per-minute quota 429 off like a rate limit and honors its retry-after", () =>
    Effect.gen(function* () {
      const error = nativeQuota("Quota exceeded for requests per minute. Please retry in 20 seconds.", {
        "retry-after": "20",
      })
      const waits: number[] = []
      let calls = 0
      const fiber = yield* Effect.suspend(() => {
        calls++
        return Effect.fail(error)
      }).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            set: (info) =>
              Effect.gen(function* () {
                waits.push(info.next - (yield* Clock.currentTimeMillis))
              }),
          }),
        ),
        Effect.exit,
        Effect.forkChild,
      )
      yield* TestClock.adjust("10 minutes")
      yield* Fiber.join(fiber)

      expect(calls).toBe(SessionRetry.RETRY_MAX_RETRIES + 1)
      expect(waits).toStrictEqual(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES }, () => 20_000))
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("policy reconnects unrecognised failures up to three times", () =>
    Effect.gen(function* () {
      const waits: number[] = []
      let calls = 0
      const fiber = yield* Effect.suspend(() => {
        calls++
        return Effect.fail(new Error("socket went sideways"))
      }).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "test",
            parse: (error) => MessageV2.fromError(error, { providerID }),
            set: (info) =>
              Effect.gen(function* () {
                waits.push(info.next - (yield* Clock.currentTimeMillis))
              }),
          }),
        ),
        Effect.exit,
        Effect.forkChild,
      )
      yield* TestClock.adjust("30 seconds")
      const exit = yield* Fiber.join(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(SessionRetry.FALLBACK_MAX_RETRIES + 1)
      expect(waits).toStrictEqual([3000, 6000, 6000])
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  test("keeps terminal failures out of the fallback", () => {
    const terminal = [
      new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
      new SessionV1.ContextOverflowError({ message: "too long" }).toObject(),
      new SessionV1.AuthError({ providerID: "test", message: "bad key" }).toObject(),
      new SessionV1.ContentFilterError({ message: "filtered" }).toObject(),
      new SessionV1.APIError({ message: ProviderError.REASONING_STATE_MESSAGE, isRetryable: false }).toObject(),
      statusError(401),
      statusError(403),
      statusError(413),
    ]
    expect(terminal.map(SessionRetry.fallback)).toStrictEqual(terminal.map(() => undefined))
    expect(SessionRetry.fallback(wrap("socket went sideways"))).toEqual({ message: "socket went sideways" })
  })
})

describe("session.retry.fallbackDelay", () => {
  test("backs off from 3 seconds and caps at 6 seconds", () => {
    expect([1, 2, 3].map(SessionRetry.fallbackDelay)).toStrictEqual([3000, 6000, 6000])
  })
})

describe("session.retry.retryable", () => {
  test("retries serialized too_many_requests messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("retries serialized overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("retries serialized rate_limit messages", () => {
    const message = JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } })
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test.each([
    "Internal server error",
    "internal error",
    "server-error",
    "Provider returned error",
    "provider-returned-error",
    "terminated",
    "fetch failed",
    "network error",
    "network-error",
    "network_error",
    "connection refused",
    "connect ECONNREFUSED",
    "request ETIMEDOUT",
    "failed to fetch",
    "EAI_AGAIN",
    "response timed out",
    "Please retry your request",
    "try your request again",
    "Please try again in a few minutes",
    "The model is currently at capacity due to high demand",
    "The service is temporarily at capacity",
    "upstream returned status 524",
    "all targets recovering (half-open probe in flight)",
    "upstream target is half-open",
    "circuit breaker open",
    "Circuit breaker is open for this channel",
    "circuit open",
  ])("retries matching API error text: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("retries hyphenated service-unavailable errors", () => {
    expect(SessionRetry.retryable(wrap("service-unavailable"), retryProvider)).toEqual({
      message: "Provider is overloaded",
    })
  })

  test("matches retryable API response bodies", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "upstream connection refused" } }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Request failed" })
  })

  test("retries 4xx circuit-breaker rejections from gateways", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "all targets recovering (half-open probe in flight)",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "all targets recovering (half-open probe in flight)",
    })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries incomplete response protocol failures", () => {
    const error = new SessionRetry.IncompleteResponseError({
      message: "The model response ended before the tool call was complete",
    }).toObject()
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "The model response ended before the tool call was complete",
    })
  })

  test("retries empty response protocol failures", () => {
    const error = new SessionRetry.EmptyResponseError({
      message: SessionRetry.EMPTY_RESPONSE_MESSAGE,
    }).toObject()
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: SessionRetry.EMPTY_RESPONSE_MESSAGE,
    })
  })

  test("retries abnormal reasoning-only response protocol failures", () => {
    const error = new SessionRetry.IncompleteReasoningResponseError({
      message: SessionRetry.INCOMPLETE_REASONING_RESPONSE_MESSAGE,
    }).toObject()
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: SessionRetry.INCOMPLETE_REASONING_RESPONSE_MESSAGE,
    })
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("dispatches every 4xx and 5xx status through one table", () => {
    for (let statusCode = 400; statusCode <= 599; statusCode++) {
      const error = statusError(statusCode)
      const decision = SessionRetry.classify(error, retryProvider)

      expect(decision.status).toBe(statusCode)
      expect(decision.message).toBe(`status ${statusCode}`)
      if (statusCode === 401 || statusCode === 403) {
        expect(decision).toMatchObject({ branch: "auth", class: "auth", maxRetries: 1 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else if (statusCode === 413) {
        expect(decision).toMatchObject({ branch: "compaction", class: "context_overflow", maxRetries: 0 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else if (statusCode === 402) {
        // The payment status alone says the balance is gone: resending cannot succeed.
        expect(decision).toMatchObject({ branch: "terminal", class: "quota_exhausted", maxRetries: 0 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else if (statusCode === 404) {
        // A path or model that does not exist fails identically on resend.
        expect(decision).toMatchObject({ branch: "terminal", class: "invalid_request", maxRetries: 0 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else {
        expect(decision).toMatchObject({
          branch: statusCode === 429 || statusCode === 503 ? "rate_limit" : "http",
          class:
            statusCode === 429 || statusCode === 503
              ? "rate_limited"
              : statusCode >= 500
                ? "transient"
                : "invalid_request",
          maxRetries: SessionRetry.RETRY_MAX_RETRIES,
        })
        // The wire policy resends every status, but goal recovery only
        // resumes when the failure is transient. A plain 4xx is final; 429 is
        // a rate limit that clears on its own.
        if (statusCode >= 500 || statusCode === 429) {
          expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: `status ${statusCode}` })
        } else {
          expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
        }
      }
    }
  })

  test("keeps a flagged 4xx recoverable for goal continuation", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "request timed out",
        isRetryable: true,
        statusCode: 408,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "request timed out" })
  })

  test("keeps rejected reasoning state terminal whatever its status", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: ProviderError.REASONING_STATE_MESSAGE,
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not read token counts in a status-less body as a retryable status", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "max_tokens: 15000 > 4096, which is the maximum allowed",
        isRetryable: false,
        responseBody: JSON.stringify({ error: { message: "prompt is 150000 tokens, request id req_5029" } }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("still retries a bare status code in a provider message", () => {
    expect(SessionRetry.retryable(wrap("upstream returned 503"), retryProvider)).toEqual({
      message: "upstream returned 503",
    })
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })
})

describe("session.retry.classify by provider semantics", () => {
  test("a 402 is a spent balance and is never resent", () => {
    expect(SessionRetry.classify(statusError(402), retryProvider)).toMatchObject({
      branch: "terminal",
      class: "quota_exhausted",
      status: 402,
      maxRetries: 0,
    })
  })

  test("a 429 whose body reports the plan limit is a spent quota, not a rate limit", () => {
    const error = providerError({
      statusCode: 429,
      message: "已达到 5 小时的使用上限",
      responseBody: { error: { code: "1308", message: "已达到 5 小时的使用上限" } },
    })
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "quota_exhausted",
      status: 429,
      maxRetries: 0,
    })
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("an HTTP-shaped 429 flagged retryable still stops on insufficient_quota", () => {
    const error = providerError({
      statusCode: 429,
      isRetryable: true,
      message: "Too Many Requests",
      metadata: { code: "insufficient_quota" },
    })
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "quota_exhausted",
      maxRetries: 0,
    })
  })

  test("a 429 and a 500 that name no quota keep the bounded backoff", () => {
    expect(SessionRetry.classify(statusError(429), retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
    expect(SessionRetry.classify(statusError(500), retryProvider)).toMatchObject({
      branch: "http",
      class: "transient",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
  })

  test("an in-stream insufficient_quota error with no status is not reconnected", () => {
    const error = new SessionV1.APIError({
      message: "Quota exceeded.",
      isRetryable: false,
      responseBody: '{"type":"error","error":{"code":"insufficient_quota"}}',
    }).toObject()
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "quota_exhausted",
      maxRetries: 0,
    })
    expect(SessionRetry.fallback(error)).toBeUndefined()
  })

  test("an in-stream invalid_prompt error with no status is not reconnected", () => {
    const error = new SessionV1.APIError({
      message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      isRetryable: false,
      responseBody:
        '{"type":"error","error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged"}}',
    }).toObject()
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "invalid_request",
      maxRetries: 0,
    })
    expect(SessionRetry.fallback(error)).toBeUndefined()
  })

  test("a quota 403 is a spent quota, not a credential failure", () => {
    const error = providerError({
      statusCode: 403,
      message: "Access denied",
      responseBody: { error: { code: "AllocationQuota.FreeTierOnly", message: "The free tier has been used up" } },
    })
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({ class: "quota_exhausted", maxRetries: 0 })
    // A plain 403 still gets its one credential retry.
    expect(SessionRetry.classify(statusError(403), retryProvider)).toMatchObject({ class: "auth", maxRetries: 1 })
  })

  test("a content-filter refusal is final", () => {
    const error = providerError({
      statusCode: 400,
      message: "Output blocked",
      metadata: { type: "content_filter" },
    })
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "content_refused",
      maxRetries: 0,
    })
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("a deterministic 400 named by the table is final, and a transient signal keeps it retryable", () => {
    const body = (message: string) => ({ error: { type: "invalid_request_error", message } })
    const plain = providerError({ statusCode: 400, message: "Bad request", responseBody: body("messages: required") })
    expect(SessionRetry.classify(plain, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "invalid_request",
      status: 400,
      maxRetries: 0,
    })

    const named = providerError({
      statusCode: 400,
      message: "Bad request",
      responseBody: body("upstream connection refused"),
    })
    expect(SessionRetry.classify(named, retryProvider)).toMatchObject({
      branch: "http",
      class: "transient",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
    expect(SessionRetry.retryable(named, retryProvider)).toEqual({ message: "Bad request" })

    const flagged = providerError({
      statusCode: 400,
      isRetryable: true,
      message: "Bad request",
      responseBody: body("messages: required"),
    })
    expect(SessionRetry.classify(flagged, retryProvider)).toMatchObject({ branch: "http", class: "transient" })
  })

  test("only a 400 or 422 reaches the invalid-request row", () => {
    const body = { error: { type: "invalid_request_error", message: "no such model" } }
    expect(SessionRetry.classify(providerError({ statusCode: 400, responseBody: body }), retryProvider)).toMatchObject({
      branch: "terminal",
      class: "invalid_request",
      maxRetries: 0,
    })
    expect(
      SessionRetry.classify(
        providerError({ statusCode: 422, responseBody: { error: { code: "invalid_parameter_error" } } }),
        retryProvider,
      ),
    ).toMatchObject({ branch: "terminal", class: "invalid_request", maxRetries: 0 })
  })

  test("a 404 is a routing answer and stops at once", () => {
    const missing = providerError({ statusCode: 404, message: "Not Found" })
    expect(SessionRetry.classify(missing, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "invalid_request",
      maxRetries: 0,
    })
    expect(SessionRetry.retryable(missing, retryProvider)).toBeUndefined()
  })

  test("the per-minute allocation reported as a quota is still a rate limit", () => {
    const message = "Allocated quota exceeded, please increase your quota limit."
    const withStatus = providerError({
      statusCode: 429,
      message,
      responseBody: { error: { code: "insufficient_quota", type: "insufficient_quota", message } },
    })
    expect(SessionRetry.classify(withStatus, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      status: 429,
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })

    const withoutStatus = providerError({ message, metadata: { code: "Throttling.AllocationQuota" } })
    expect(SessionRetry.classify(withoutStatus, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
    expect(SessionRetry.retryable(withoutStatus, retryProvider)).toEqual({ message })
  })

  test("a native quota or content-policy failure keeps its meaning after fromError", () => {
    const quota = MessageV2.fromError(
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new QuotaExceededReason({ message: "Provider request failed with HTTP 429" }),
      }),
      { providerID },
    )
    expect(SessionRetry.classify(quota, retryProvider)).toMatchObject({ class: "quota_exhausted", maxRetries: 0 })

    const policy = MessageV2.fromError(
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new ContentPolicyReason({ message: "Provider request failed with HTTP 400" }),
      }),
      { providerID },
    )
    expect(SessionRetry.classify(policy, retryProvider)).toMatchObject({ class: "content_refused", maxRetries: 0 })
  })

  test("a native quota 429 that says the limit is per minute backs off instead of ending the turn", () => {
    const error = nativeQuota("Quota exceeded for requests per minute. Please retry in 20 seconds.")
    // The tag the table sees: the executor labels every "quota exceeded" 429 this way.
    expect(error.name === "APIError" ? error.data.metadata?.code : undefined).toBe("QuotaExceeded")
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      status: 429,
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
    expect(SessionRetry.retryable(error, retryProvider)).toBeDefined()
  })

  test("a native quota 429 is a temporary limit when only its retry-after header says so", () => {
    const error = nativeQuota("Quota exceeded.", { "retry-after": "20" })
    expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
  })

  test("a native quota 429 with no sign of a temporary limit is a spent balance", () => {
    for (const body of [
      "Quota exceeded. Your account balance is insufficient, please top up.",
      "You exceeded your current quota, please check your plan and billing details.",
    ]) {
      const error = nativeQuota(body)
      expect(SessionRetry.classify(error, retryProvider)).toMatchObject({
        branch: "terminal",
        class: "quota_exhausted",
        status: 429,
        maxRetries: 0,
      })
      expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
    }
  })

  test("the QuotaExceeded tag in the HTTP shape follows the same rule", () => {
    const code = { code: "QuotaExceeded" }
    const temporary = providerError({
      statusCode: 429,
      isRetryable: true,
      message: "Quota exceeded for requests per minute. Please retry in 20 seconds.",
      metadata: code,
    })
    expect(SessionRetry.classify(temporary, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })

    const withoutStatus = providerError({
      message: "Quota exceeded for requests per day.",
      responseBody: { error: { code: "QuotaExceeded", message: "Quota exceeded for requests per day." } },
    })
    expect(SessionRetry.classify(withoutStatus, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })

    const spent = providerError({
      statusCode: 429,
      isRetryable: true,
      message: "Quota exceeded. Please top up your account.",
      metadata: code,
    })
    expect(SessionRetry.classify(spent, retryProvider)).toMatchObject({
      branch: "terminal",
      class: "quota_exhausted",
      maxRetries: 0,
    })
  })

  test("a 429 with quota wording and no provider code keeps its backoff in either shape", () => {
    const message = "Quota exceeded for quota metric 'Generate Content API requests per minute'. Please retry in 20s."
    const wire = providerError({
      statusCode: 429,
      isRetryable: true,
      message,
      responseBody: { error: { code: 429, message, status: "RESOURCE_EXHAUSTED" } },
    })
    expect(SessionRetry.classify(wire, retryProvider)).toMatchObject({
      branch: "rate_limit",
      class: "rate_limited",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
  })

  test("every other branch carries its class", () => {
    const classOf = (error: ReturnType<NamedError["toObject"]>) => SessionRetry.classify(error, retryProvider).class
    expect(classOf(new SessionV1.AbortedError({ message: "Aborted" }).toObject())).toBe("invalid_request")
    expect(classOf(new SessionV1.OutputLengthError({}).toObject())).toBe("invalid_request")
    expect(classOf(new SessionV1.StructuredOutputError({ message: "missing", retries: 0 }).toObject())).toBe(
      "invalid_request",
    )
    expect(
      classOf(
        new SessionV1.APIError({ message: ProviderError.REASONING_STATE_MESSAGE, isRetryable: false }).toObject(),
      ),
    ).toBe("invalid_request")
    expect(classOf(new SessionV1.ContentFilterError({ message: "filtered" }).toObject())).toBe("content_refused")
    expect(classOf(new SessionV1.AuthError({ providerID: "test", message: "bad key" }).toObject())).toBe("auth")
    expect(classOf(new SessionV1.ContextOverflowError({ message: "too long" }).toObject())).toBe("context_overflow")
    expect(
      classOf(new SessionRetry.EmptyResponseError({ message: SessionRetry.EMPTY_RESPONSE_MESSAGE }).toObject()),
    ).toBe("transient")
    expect(classOf(apiError(undefined, undefined))).toBe("transient")
    expect(classOf(wrap("Too many requests, please slow down"))).toBe("transient")
    expect(classOf(wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } })))).toBe("rate_limited")
    expect(classOf(wrap("socket went sideways"))).toBe("transient")
  })
})

describe("session.retry.withHint", () => {
  const quota = () => statusError(402)
  const hintLine = 'Provider "zhipuai": quota or balance used up, so resending cannot succeed. Top up or switch model.'

  test("appends the quota hint on its own line and keeps every other field", () => {
    const error = providerError({
      statusCode: 429,
      message: "已达到 5 小时的使用上限",
      responseBody: { error: { code: "1308" } },
      metadata: { code: "1308" },
    })
    const result = SessionRetry.withHint(error, "zhipuai")
    expect(result).toEqual({
      name: "APIError",
      data: { ...error.data, message: `已达到 5 小时的使用上限\n${hintLine}` },
    })
    expect(result.data.statusCode).toBe(429)
    expect(result.data.responseBody).toBe(error.data.responseBody)
    expect(result.data.metadata).toEqual({ code: "1308" })
    // The input is left as it was.
    expect(error.data.message).toBe("已达到 5 小时的使用上限")
  })

  test("appends the login hint to a rejected credential of either shape", () => {
    const apiError = SessionRetry.withHint(statusError(401), "anthropic")
    expect(apiError.data.message).toBe(
      'status 401\nProvider "anthropic" rejected the credentials. Run `graphagent providers login --provider anthropic`.',
    )
    const authError = new SessionV1.AuthError({ providerID: "anthropic", message: "bad key" }).toObject()
    expect(SessionRetry.withHint(authError, "anthropic")).toEqual({
      name: "ProviderAuthError",
      data: {
        providerID: "anthropic",
        message:
          'bad key\nProvider "anthropic" rejected the credentials. Run `graphagent providers login --provider anthropic`.',
      },
    })
  })

  test("appends the content hint to a content-filter API error", () => {
    const error = providerError({ statusCode: 400, message: "Output blocked", metadata: { type: "content_filter" } })
    expect(SessionRetry.withHint(error, "test").data.message).toBe(
      "Output blocked\nThe provider's content filter rejected this conversation. Rephrase the last message or start a new session.",
    )
  })

  test("gives no quota advice to a native quota 429 that says the limit is temporary", () => {
    const temporary = nativeQuota("Quota exceeded for requests per minute. Please retry in 20 seconds.")
    expect(SessionRetry.withHint(temporary, "zhipuai")).toBe(temporary)
    const spent = nativeQuota("Quota exceeded. Please top up.")
    expect(SessionRetry.withHint(spent, "zhipuai")).toMatchObject({
      data: { message: expect.stringContaining("quota or balance used up") },
    })
  })

  test("does not stack the hint when it is already there", () => {
    const once = SessionRetry.withHint(quota(), "zhipuai")
    expect(SessionRetry.withHint(once, "zhipuai")).toBe(once)
  })

  test("returns the very same object for everything the table gives no hint for", () => {
    for (const error of [
      statusError(500),
      statusError(429),
      statusError(400),
      statusError(413),
      providerError({ statusCode: 400, responseBody: { error: { type: "invalid_request_error" } } }),
      new SessionV1.ContextOverflowError({ message: "too long" }).toObject(),
      new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
      new SessionV1.ContentFilterError({ message: "filtered" }).toObject(),
      new SessionRetry.EmptyResponseError({ message: SessionRetry.EMPTY_RESPONSE_MESSAGE }).toObject(),
      wrap("socket went sideways"),
    ]) {
      expect(SessionRetry.withHint(error, "test")).toBe(error)
    }
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
