import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import * as TestClock from "effect/testing/TestClock"
import { LLM, LLMError, LLMEvent } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { HttpOptions, Model, mergeHttpOptions } from "../src/schema"
import { LLMClient } from "../src/route"
import { testEffect } from "./lib/effect"
import { dynamicResponse, fixedResponse, runtimeLayer } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents, sseRaw } from "./lib/sse"

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

const request = (timeout?: number, baseURL?: string) =>
  LLM.request({
    model:
      baseURL === undefined
        ? model
        : Model.make({
            id: "fake-model",
            provider: "fake",
            route: OpenAIChat.route.with({ endpoint: { baseURL } }),
          }),
    prompt: "Say hello.",
    http: timeout === undefined ? undefined : { timeout: Duration.millis(timeout) },
  })

const hangingHeaders = dynamicResponse(() => Effect.never)

const hangingBody = dynamicResponse((input) =>
  Effect.sync(() =>
    input.respond(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
  ),
)

const stalledAfterFirstFrame = dynamicResponse((input) =>
  Effect.sync(() =>
    input.respond(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sseRaw(`data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`),
            ),
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  ),
)

const expectTimeoutExit = (exit: Exit.Exit<readonly LLMEvent[], LLMError>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected a Timeout failure, stream completed with ${exit.value.length} events`)
  }
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
}

const waitForFence = <A>(name: string, promise: Promise<A>) =>
  Effect.promise(() => promise).pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.mapError(() => new Error(`${name} was not observed within 2000ms`)),
  )

const timeoutProvider = () => {
  const requestReceived = Promise.withResolvers<void>()
  const responseCanceled = Promise.withResolvers<void>()
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requestReceived.resolve()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"))
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { server, requestReceived: requestReceived.promise, responseCanceled: responseCanceled.promise }
}

const networkRuntime = runtimeLayer(FetchHttpClient.layer)

describe("http transport timeout", () => {
  testEffect(networkRuntime).live(
    "cancels the provider response stream when a real HTTP request times out",
    () =>
      Effect.gen(function* () {
        const provider = yield* Effect.acquireRelease(
          Effect.sync(timeoutProvider),
          (fixture) => Effect.promise(() => fixture.server.stop(true)),
        )
        const fiber = yield* LLMClient.stream(request(200, provider.server.url.origin)).pipe(
          Stream.runCollect,
          Effect.forkScoped,
        )

        yield* waitForFence("provider request", provider.requestReceived)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
        yield* waitForFence("provider response cancellation", provider.responseCanceled)
      }),
  )

  testEffect(hangingHeaders).effect(
    "ends the stream with a Timeout error when the provider never sends response headers",
    () =>
      Effect.gen(function* () {
        const fiber = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect, Effect.forkChild)
        yield* TestClock.adjust(2000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )

  testEffect(hangingBody).effect(
    "ends the stream with a Timeout error when the response body never emits",
    () =>
      Effect.gen(function* () {
        const fiber = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(1)
        yield* TestClock.adjust(2000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )

  testEffect(stalledAfterFirstFrame).effect(
    "delivers the first frame before timing out the next inter-frame gap",
    () =>
      Effect.gen(function* () {
        const firstFrameDelivered = yield* Deferred.make<void>()
        const fiber = yield* LLMClient.stream(request(1000)).pipe(
          Stream.tap((event) =>
            LLMEvent.is.textDelta(event) && event.text === "Hello"
              ? Deferred.succeed(firstFrameDelivered, undefined)
              : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkChild,
        )

        yield* Deferred.await(firstFrameDelivered)
        yield* TestClock.adjust(2000)
        yield* Effect.yieldNow

        const exit = fiber.pollUnsafe()
        if (exit === undefined) throw new Error("expected the stalled stream to time out")
        expectTimeoutExit(exit)
      }),
  )

  testEffect(fixedResponse(sseEvents(deltaChunk({ role: "assistant", content: "Hello" })))).effect(
    "completes normally when the stream finishes within the timeout",
    () =>
      Effect.gen(function* () {
        const events = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect)
        expect(events.some(LLMEvent.is.textDelta)).toBe(true)
      }),
  )

  testEffect(hangingHeaders).effect(
    "applies the route default timeout when the request omits http",
    () =>
      Effect.gen(function* () {
        const defaultModel = Model.make({
          id: "fake-model",
          provider: "fake",
          route: OpenAIChat.route.with({ http: { timeout: Duration.millis(500) } }),
        })
        const fiber = yield* LLMClient.stream(LLM.request({ model: defaultModel, prompt: "Say hello." })).pipe(
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* TestClock.adjust(1000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )
})

describe("HttpOptions.timeout merging", () => {
  test("keeps existing merge behavior when no timeout is set", () => {
    expect(mergeHttpOptions(new HttpOptions({ headers: { "x-a": "1" } }), undefined)).toEqual(
      new HttpOptions({ headers: { "x-a": "1" } }),
    )
    expect(mergeHttpOptions()).toBeUndefined()
    expect(new HttpOptions({ headers: { "x-a": "1" } }).timeout).toBeUndefined()
  })

  test("merges timeout with last-wins semantics", () => {
    const merged = mergeHttpOptions(
      new HttpOptions({ timeout: Duration.millis(1000) }),
      new HttpOptions({ headers: { "x-a": "1" }, timeout: Duration.millis(2500) }),
      undefined,
    )
    expect(merged?.headers).toEqual({ "x-a": "1" })
    expect(Duration.toMillis(merged?.timeout ?? Duration.zero)).toBe(2500)
  })
})
