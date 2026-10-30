import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Effect, Exit, Fiber, Logger, Schedule, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

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
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          shouldRetry: () => false,
          gates: () => ({ aborted: true, pendingToolExecutions: 1 }),
          set: () => Effect.void,
        }),
      )

      yield* Effect.ignore(step(error)).pipe(Effect.withLogger(collector))

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
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise),
  )

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
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise),
  )

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
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise),
  )

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
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise),
  )

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
    for (const statusCode of [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504, 599]) {
      const error = statusError(statusCode)
      const decision = SessionRetry.classify(error, retryProvider)

      expect(decision.status).toBe(statusCode)
      expect(decision.message).toBe(`status ${statusCode}`)
      if (statusCode === 401 || statusCode === 403) {
        expect(decision).toMatchObject({ branch: "auth", maxRetries: 1 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else if (statusCode === 413) {
        expect(decision).toMatchObject({ branch: "compaction", maxRetries: 0 })
        expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
      } else {
        expect(decision).toMatchObject({
          branch: statusCode === 429 || statusCode === 503 ? "rate_limit" : "http",
          maxRetries: SessionRetry.RETRY_MAX_RETRIES,
        })
        expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: `status ${statusCode}` })
      }
    }
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

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
        label: "subscribe",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")).toEqual({
      message:
        "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
        message:
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        label: "open settings",
        link: "https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")?.action?.message).toBe(
      "Usage limit reached. It will reset in 15 minutes. To continue using this model now, enable usage from your available balance",
    )
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
