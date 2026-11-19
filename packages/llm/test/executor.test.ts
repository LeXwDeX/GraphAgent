import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Random, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { LLM, LLMError } from "../src"
import { LLMClient, RequestExecutor } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseRaw } from "./lib/sse"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/v1/chat?api_key=secret&key=secret&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer secret", "x-safe": "visible" })),
)

const secretRequest = HttpClientRequest.post("https://provider.test/v1/chat?api_key=query-secret-123&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer header-secret-456" })),
)

const responsesLayer = (responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const countedResponsesLayer = (attempts: Ref.Ref<number>, responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (value) => value + 1)
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const randomMidpoint = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
}

const expectLLMError = (error: unknown) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  return error
}

const errorHttp = (error: LLMError) => ("http" in error.reason ? error.reason.http : undefined)

describe("RequestExecutor", () => {
  it.effect("disables HTTP retries locally without changing subsequent requests", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const first = yield* executor
          .execute(request)
          .pipe(Effect.provideService(RequestExecutor.MaxRetries, 0), Effect.flip)
        expect(first.retryable).toBe(true)
        expect(yield* Ref.get(attempts)).toBe(1)
        const second = yield* executor.execute(request)
        expect(second.status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(3)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
            new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )
    }),
  )

  it.effect("honors zero retries through the full LLM generate path", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "auxiliary-model" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Organize synthetic text." })).pipe(
        Effect.provideService(RequestExecutor.MaxRetries, 0),
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(input.respond("busy", { status: 503, headers: { "retry-after-ms": "0" } })),
            ),
          ),
        ),
        Effect.flip,
      )
      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status: 503 })
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  for (const status of [408, 504]) {
    it.effect(`can bypass only timeout retries for HTTP ${status}`, () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0)
        const error = yield* RequestExecutor.Service.use((executor) => executor.execute(request)).pipe(
          Effect.flip,
          Effect.provideService(RequestExecutor.RetryTimeouts, false),
          Effect.provide(
            countedResponsesLayer(attempts, [new Response(null, { status, headers: { "retry-after-ms": "10000" } })]),
          ),
        )
        expect(error.isTimeout).toBe(true)
        expect(yield* Ref.get(attempts)).toBe(1)
      }),
    )
  }

  it.effect("retains default HTTP 504 retries", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const response = yield* RequestExecutor.Service.use((executor) => executor.execute(request)).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response(null, { status: 504, headers: { "retry-after-ms": "0" } }),
            new Response("ok"),
          ]),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )

  it.effect("classifies context overflow responses", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", classification: "context-overflow" })
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"code":"context_length_exceeded","message":"prompt too long"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("does not classify generic HTTP 413 payload errors as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("request too large", { status: 413 })]))),
  )

  it.effect("does not classify ordinary invalid requests as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("invalid parameter", { status: 400 })]))),
  )

  const reasonOf = (status: number, body: string) =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor
        .execute(request)
        .pipe(Effect.provideService(RequestExecutor.MaxRetries, 0), Effect.flip)

      expectLLMError(error)
      return error.reason._tag
    }).pipe(Effect.provide(responsesLayer([new Response(body, { status, headers: { "retry-after-ms": "0" } })])))

  it.effect("does not read a safety_settings parameter error as a content-policy refusal", () =>
    Effect.gen(function* () {
      expect(
        yield* reasonOf(400, '{"error":{"message":"Unknown name \\"safety_settings\\": Cannot find field."}}'),
      ).toBe("InvalidRequest")
      expect(yield* reasonOf(400, "invalid value for safety_settings")).toBe("InvalidRequest")
    }),
  )

  it.effect("still reads a content filter or the word safety on a client error as a content-policy refusal", () =>
    Effect.gen(function* () {
      expect(yield* reasonOf(400, '{"error":{"code":"content_filter","message":"blocked"}}')).toBe("ContentPolicy")
      expect(yield* reasonOf(400, "Your request was blocked by our content policy")).toBe("ContentPolicy")
      expect(yield* reasonOf(400, "Blocked for safety reasons")).toBe("ContentPolicy")
      expect(yield* reasonOf(422, "SAFETY filter triggered")).toBe("ContentPolicy")
      expect(yield* reasonOf(403, "content policy violation")).toBe("ContentPolicy")
    }),
  )

  it.effect("keeps a 401, a 429 and a 5xx that mention a content filter out of the content-policy class", () =>
    Effect.gen(function* () {
      expect(yield* reasonOf(401, '{"error":{"code":"content_filter"}}')).toBe("Authentication")
      expect(yield* reasonOf(429, "Too many requests, safety classifier busy")).toBe("RateLimit")
      expect(yield* reasonOf(500, "safety filter crashed")).toBe("ProviderInternal")
      expect(yield* reasonOf(503, "content_filter backend unavailable")).toBe("ProviderInternal")
    }),
  )

  // Sample 429 bodies (#1578). `packages/graphagent/test/provider/error-class.test.ts` holds the same two lists and
  // asserts how the session table reads them; keep the two in step.
  const spentBalances: ReadonlyArray<readonly [name: string, body: string]> = [
    [
      "credit_balance_exhausted",
      '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is exhausted."}}',
    ],
    [
      "exceeded_current_quota_error",
      '{"error":{"code":"exceeded_current_quota_error","message":"You exceeded your current quota, please check your plan and billing details."}}',
    ],
    [
      "enforced_spend_limit_reached",
      '{"error":{"code":"enforced_spend_limit_reached","message":"The spend limit for this workspace has been reached."}}',
    ],
    [
      "arrearage",
      '{"error":{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}}',
    ],
    [
      "allocationquota.freetieronly",
      '{"error":{"code":"AllocationQuota.FreeTierOnly","message":"The free tier of the model has been exhausted."}}',
    ],
    [
      "free allocated quota exceeded",
      '{"error":{"message":"The Free Allocated Quota Exceeded, please purchase a plan."}}',
    ],
    [
      "insufficient_quota",
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
    ],
  ]

  // Bailian files its per-minute allocation under the same names; the phrase tells it apart.
  const bailianWindow =
    '{"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"Allocated quota exceeded, please increase your quota limit."}}'
  const windowedAllocations: ReadonlyArray<readonly [name: string, body: string]> = [
    ["insufficient_quota", bailianWindow],
    [
      "Throttling.AllocationQuota",
      '{"error":{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded, please increase your quota limit."}}',
    ],
    [
      "the phrase in capitals",
      '{"error":{"code":"Throttling.AllocationQuota","message":"ALLOCATED QUOTA EXCEEDED, PLEASE INCREASE YOUR QUOTA LIMIT."}}',
    ],
  ]

  // Sends one request against a script of responses and settles on the failure and the number of attempts, without
  // ever moving the clock. An executor that chose to wait leaves the fiber unfinished, which fails here, not hangs.
  const settle = (responses: ReadonlyArray<Response>) =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const error = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)
        for (let step = 0; step < 40 && fiber.pollUnsafe() === undefined; step++) yield* Effect.yieldNow
        if (fiber.pollUnsafe() === undefined) return yield* Effect.die(new Error("the executor is still waiting"))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(countedResponsesLayer(attempts, responses)))
      return { error, attempts: yield* Ref.get(attempts) }
    })

  for (const [name, body] of spentBalances) {
    it.effect(`reads a 429 naming ${name} as a spent balance, tries it once and does not wait`, () =>
      Effect.gen(function* () {
        // The hint asks for ten seconds; a spent balance is not worth the wait.
        const { error, attempts } = yield* settle([
          new Response(body, { status: 429, headers: { "retry-after-ms": "10000" } }),
          new Response("ok", { status: 200 }),
        ])

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "QuotaExceeded" })
        expect(error.retryable).toBe(false)
        expect(attempts).toBe(1)
      }),
    )
  }

  for (const [name, body] of windowedAllocations) {
    it.effect(`reads a 429 asking to increase the quota limit (${name}) as a rate limit and retries it`, () =>
      Effect.gen(function* () {
        const { error, attempts } = yield* settle(
          Array.from({ length: 3 }, () => new Response(body, { status: 429, headers: { "retry-after-ms": "0" } })),
        )

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "RateLimit" })
        expect(error.retryable).toBe(true)
        // The request and its two retries.
        expect(attempts).toBe(3)
      }),
    )
  }

  it.effect("succeeds on the retry of a windowed allocation once the window reopens", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const response = yield* RequestExecutor.Service.use((executor) => executor.execute(request)).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response(bailianWindow, { status: 429, headers: { "retry-after-ms": "0" } }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )

  for (const [kind, body] of [
    ["a windowed allocation", bailianWindow],
    ["a plain rate limit", "rate limited"],
  ] as const) {
    it.effect(`caps the wait before retrying ${kind} at ten seconds however long retry-after-ms asks`, () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0)
        return yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)
          const tick = (millis: number) => TestClock.adjust(millis).pipe(Effect.andThen(Effect.yieldNow))

          yield* Effect.yieldNow
          expect(yield* Ref.get(attempts)).toBe(1)

          // Each wait ends at the cap, not at the minute the provider asked for.
          yield* tick(9_999)
          expect(yield* Ref.get(attempts)).toBe(1)
          yield* tick(1)
          expect(yield* Ref.get(attempts)).toBe(2)

          yield* tick(9_999)
          expect(yield* Ref.get(attempts)).toBe(2)
          yield* TestClock.adjust(1)
          const error = yield* Fiber.join(fiber)

          expectLLMError(error)
          expect(error.reason).toMatchObject({ _tag: "RateLimit" })
          expect(yield* Ref.get(attempts)).toBe(3)
        }).pipe(
          Effect.provide(
            countedResponsesLayer(
              attempts,
              Array.from(
                { length: 3 },
                () => new Response(body, { status: 429, headers: { "retry-after-ms": "60000" } }),
              ),
            ),
          ),
        )
      }),
    )
  }

  it.effect("returns redacted diagnostics for retryable rate limits", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error).toMatchObject({
        retryable: true,
        retryAfterMs: 0,
        reason: {
          _tag: "RateLimit",
          rateLimit: { retryAfterMs: 0 },
          http: {
            requestId: "req_123",
            request: {
              method: "POST",
              url: "https://provider.test/v1/chat?api_key=%3Credacted%3E&key=%3Credacted%3E&debug=1",
              headers: { authorization: "<redacted>", "x-safe": "visible" },
            },
            response: {
              status: 429,
              headers: {
                "retry-after-ms": "0",
                "x-request-id": "req_123",
                "x-api-key": "<redacted>",
              },
            },
          },
        },
      })
      expect(errorHttp(error)?.body).toBe("rate limited")
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: { "retry-after-ms": "0", "x-request-id": "req_123", "x-api-key": "secret" },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("honors current redacted header names in diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.request.headers["x-safe"]).toBe("<redacted>")
      expect(errorHttp(error)?.response?.headers["x-safe"]).toBe("<redacted>")
    }).pipe(
      Effect.provide(responsesLayer([new Response("bad", { status: 400, headers: { "x-safe": "response-secret" } })])),
      Effect.provideService(Headers.CurrentRedactedNames, ["x-safe"]),
    ),
  )

  it.effect("extracts OpenAI-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      expect(error.reason._tag === "RateLimit" ? error.reason.rateLimit : undefined).toEqual({
        retryAfterMs: 0,
        limit: { requests: "500", tokens: "30000" },
        remaining: { requests: "499", tokens: "29900" },
        reset: { requests: "1s", tokens: "10s" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: {
                  "retry-after-ms": "0",
                  "x-ratelimit-limit-requests": "500",
                  "x-ratelimit-limit-tokens": "30000",
                  "x-ratelimit-remaining-requests": "499",
                  "x-ratelimit-remaining-tokens": "29900",
                  "x-ratelimit-reset-requests": "1s",
                  "x-ratelimit-reset-tokens": "10s",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("extracts Anthropic-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
      expect(errorHttp(error)?.rateLimit).toEqual({
        retryAfterMs: 0,
        limit: { requests: "100", "input-tokens": "10000" },
        remaining: { requests: "12", "input-tokens": "9000" },
        reset: { requests: "2026-05-06T12:00:00Z", "input-tokens": "2026-05-06T12:00:10Z" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("overloaded", {
                status: 529,
                headers: {
                  "retry-after-ms": "0",
                  "anthropic-ratelimit-requests-limit": "100",
                  "anthropic-ratelimit-requests-remaining": "12",
                  "anthropic-ratelimit-requests-reset": "2026-05-06T12:00:00Z",
                  "anthropic-ratelimit-input-tokens-limit": "10000",
                  "anthropic-ratelimit-input-tokens-remaining": "9000",
                  "anthropic-ratelimit-input-tokens-reset": "2026-05-06T12:00:10Z",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("retries retryable status responses before returning the stream", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const response = yield* executor.execute(request)

      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("ok")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
          new Response("ok", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("marks 504 and 529 status responses retryable", () =>
    Effect.gen(function* () {
      const failWith = (status: number) =>
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const error = yield* executor.execute(request).pipe(Effect.flip)

          expectLLMError(error)
          expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status })
          expect(error.retryable).toBe(true)
        }).pipe(
          Effect.provide(
            responsesLayer(
              Array.from(
                { length: 3 },
                () =>
                  new Response("retry", {
                    status,
                    headers: { "retry-after-ms": "0" },
                  }),
              ),
            ),
          ),
        )

      yield* failWith(504)
      yield* failWith(529)
    }),
  )

  it.effect("does not retry non-retryable status responses and truncates large bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Authentication" })
      expect(error.retryable).toBe(false)
      expect(errorHttp(error)?.bodyTruncated).toBe(true)
      expect(errorHttp(error)?.body).toHaveLength(16_384)
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("x".repeat(20_000), { status: 401 }),
          new Response("should not retry", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("redacts common secret fields in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain('"key":"<redacted>"')
      expect(errorHttp(error)?.body).toContain("api_key=<redacted>")
      expect(errorHttp(error)?.body).not.toContain("body-secret")
      expect(errorHttp(error)?.body).not.toContain("query-secret")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"message":"bad","key":"body-secret","detail":"api_key=query-secret"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("redacts echoed request secret values in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(secretRequest).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain("provider echoed <redacted>")
      expect(errorHttp(error)?.body).toContain("authorization <redacted>")
      expect(errorHttp(error)?.body).not.toContain("query-secret-123")
      expect(errorHttp(error)?.body).not.toContain("header-secret-456")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("provider echoed query-secret-123 and authorization header-secret-456", { status: 400 }),
        ]),
      ),
    ),
  )

  it.effect("honors Retry-After delta seconds before retrying", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1_999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        const response = yield* Fiber.join(fiber)

        expect(response.status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(2)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503, headers: { "retry-after": "2" } }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )
    }),
  )

  it.effect("uses exponential jittered delay when retry-after is absent", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(499)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(fiber)

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
        expect(yield* Ref.get(attempts)).toBe(3)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503 }),
            new Response("still busy", { status: 503 }),
            new Response("done retrying", { status: 503 }),
          ]),
        ),
      )
    }).pipe(Effect.provideService(Random.Random, randomMidpoint)),
  )

  it.effect("does not retry after a successful response reaches stream parsing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(
                input.respond(
                  sseRaw(
                    `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
                    "data: not-json",
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            ),
          ),
        ),
        Effect.flip,
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
