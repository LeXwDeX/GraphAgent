import { describe, expect } from "bun:test"
import { LLMEvent, LLMResponse, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  declaresNoReasoning,
  engineOrganizerCall,
  makeRewriteBudget,
  organizePrompt,
  ReasoningDistillationPolicy,
  runReasoningRewrite,
  type OrganizeCall,
} from "../../src/session/reasoning-distillation"
import { Token } from "../../src/util/token"
import { it } from "../lib/effect"

const model = Model.make({
  id: "small",
  provider: "provider",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_096 } }),
})
const slot = {
  messageID: "msg_1",
  partID: "r1",
  text: `需要保留这个决定：使用安全路径。${"重复背景。".repeat(200)}`,
}

const response = (text: string, totalTokens?: number) => {
  const value = LLMResponse.fromEvents([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: "stop",
      ...(totalTokens === undefined ? {} : { usage: { inputTokens: totalTokens - 5, outputTokens: 5, totalTokens } }),
    }),
    LLMEvent.finish({ reason: "stop" }),
  ])
  if (!value) throw new Error("expected complete response")
  return value
}

const client = (generate: LLMClientShape["generate"]): LLMClientShape => ({
  prepare: (() => Effect.die("unused")) as LLMClientShape["prepare"],
  stream: (request) =>
    Stream.unwrap(generate(request).pipe(Effect.map((response) => Stream.fromIterable(response.events)))),
  generate: () => Effect.die("organizer must stream"),
})

const fixed = (text: string | undefined, usageTokens?: number) => (): OrganizeCall => async () =>
  text === undefined ? undefined : { text, usageTokens, finishReason: "stop" }

describe("engine organizer transport", () => {
  it.live("starts on an upstream frame and lets an active response outlast the idle timeout", () => {
    let starts = 0
    const encoder = new TextEncoder()
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                async start(controller) {
                  const send = (value: unknown) =>
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
                  send({ id: "organizer-stream", choices: [{ delta: { role: "assistant" } }] })
                  await Bun.sleep(40)
                  expect(starts).toBe(1)
                  for (const text of ["confirmed ", "decision ", "uses ", "safe ", "path"]) {
                    send({ id: "organizer-stream", choices: [{ delta: { content: text } }] })
                    await Bun.sleep(40)
                  }
                  send({ id: "organizer-stream", choices: [{ delta: {}, finish_reason: "stop" }] })
                  send({
                    id: "organizer-stream",
                    choices: [],
                    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                  })
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  controller.close()
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            ),
          ),
        ),
      ),
    )
    return Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const before = Date.now()
      const result = yield* Effect.promise(() =>
        engineOrganizerCall({
          llm,
          model,
          effort: "low",
          timeoutMs: 150,
          onResponseStarted: () => starts++,
        })({ prompt: "organize" }),
      )
      expect(Date.now() - before).toBeGreaterThan(150)
      expect(result).toEqual({ text: "confirmed decision uses safe path", usageTokens: 25, finishReason: "stop" })
      expect(starts).toBe(1)
    }).pipe(
      Effect.provide(
        LLMClient.layer.pipe(
          Layer.provide(Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(http)), WebSocketExecutor.layer)),
        ),
      ),
    )
  })

  it.effect("sends one tool-less request with low effort and no automatic retries", () =>
    Effect.gen(function* () {
      const requests: LLMRequest[] = []
      let retries: number | undefined
      const llm = client((request) =>
        Effect.gen(function* () {
          requests.push(request)
          retries = yield* RequestExecutor.MaxRetries
          return response("决定使用安全路径。", 30)
        }),
      )
      const call = engineOrganizerCall({ llm, model, effort: "low", timeoutMs: 45_000 })
      const output = yield* Effect.promise(() => call({ prompt: "整理" }))
      expect(output).toEqual({ text: "决定使用安全路径。", usageTokens: 30, finishReason: "stop" })
      expect(retries).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].tools).toEqual([])
      expect(requests[0].generation?.temperature).toBe(0)
      // The fixture model declares a 4096-token output limit.
      expect(requests[0].generation?.maxTokens).toBe(4_096)
      expect(requests[0].http?.body).toEqual({ reasoning_effort: "low" })
      expect(Duration.toMillis(Duration.fromInputUnsafe(requests[0].http!.timeout!))).toBe(45_000)
    }),
  )

  it.effect("caps the organizer output at the model's declared output limit", () =>
    Effect.gen(function* () {
      const requests: LLMRequest[] = []
      const llm = client((request) => Effect.sync(() => (requests.push(request), response("ok"))))
      for (const output of [4_096, 100_000]) {
        const limited = Model.make({
          id: "small",
          provider: "provider",
          route: model.route.with({ limits: { output } }),
        })
        yield* Effect.promise(() =>
          engineOrganizerCall({ llm, model: limited, effort: "low", timeoutMs: 1_000 })({ prompt: "p" }),
        )
      }
      expect(requests.map((request) => request.generation?.maxTokens)).toEqual([
        4_096,
        ReasoningDistillationPolicy.tokens.maxOutputTokens,
      ])
    }),
  )

  it.effect("translates effort per protocol and keeps a declared no-reasoning model untouched", () =>
    Effect.gen(function* () {
      const requests: LLMRequest[] = []
      const llm = client((request) => Effect.sync(() => (requests.push(request), response("ok"))))
      const responses = Model.make({ id: "r", provider: "openai", route: OpenAIResponses.route })
      yield* Effect.promise(() =>
        engineOrganizerCall({ llm, model: responses, effort: "none", timeoutMs: 1_000 })({ prompt: "p" }),
      )
      expect(requests[0].http?.body).toEqual({ reasoning: { effort: "none" } })
      const none = Model.make({
        id: "small-none",
        provider: "provider",
        route: model.route.with({ http: { body: { reasoning_effort: "none" } } }),
      })
      expect(declaresNoReasoning(none)).toBe(true)
      expect(declaresNoReasoning(model)).toBe(false)
      yield* Effect.promise(() =>
        engineOrganizerCall({ llm, model: none, effort: "default", timeoutMs: 1_000 })({ prompt: "p" }),
      )
      expect(requests[1].http?.body).toBeUndefined()
      expect(requests[1].providerOptions).toBeUndefined()
    }),
  )
})

describe("reasoning rewrite job", () => {
  it.effect("adopts an organized replacement and records reported usage", () =>
    Effect.gen(function* () {
      const budget = makeRewriteBudget()
      const outcome = yield* runReasoningRewrite({
        budget,
        sessionID: "s",
        slot,
        language: "zh",
        call: fixed("决定使用安全路径。", 40),
        adopt: (replacement) => Effect.succeed(replacement.after),
      })
      expect(outcome).toMatchObject({ status: "adopted", adopted: "决定使用安全路径。", modelCalls: 1 })
      expect(budget.snapshot("s").tokens).toBe(40)
    }),
  )

  it.effect("estimates omitted usage instead of pausing the session", () =>
    Effect.gen(function* () {
      const budget = makeRewriteBudget()
      for (const _ of [0, 1])
        expect(
          (yield* runReasoningRewrite({
            budget,
            sessionID: "s",
            slot,
            language: "zh",
            call: fixed("决定使用安全路径。"),
            adopt: () => Effect.succeed(true),
          })).status,
        ).toBe("adopted")
      const expected =
        2 * (Token.estimateReserve(organizePrompt(slot.text, "zh")) + Token.estimateReserve("决定使用安全路径。"))
      expect(budget.snapshot("s")).toEqual({ tokens: expected, consecutiveFailures: 0, paused: false })
    }),
  )

  it.effect("pauses only after consecutive failures and keeps sessions independent", () =>
    Effect.gen(function* () {
      const budget = makeRewriteBudget()
      const failing = {
        budget,
        sessionID: "s",
        slot,
        language: "zh" as const,
        call: fixed(undefined),
        adopt: () => Effect.succeed(true),
      }
      for (let index = 0; index < ReasoningDistillationPolicy.calls.maxConsecutiveFailures; index++)
        expect((yield* runReasoningRewrite(failing)).reason).toBe("model-failure")
      expect((yield* runReasoningRewrite(failing)).reason).toBe("budget-paused")
      expect((yield* runReasoningRewrite({ ...failing, sessionID: "t", call: fixed("决定。", 5) })).status).toBe(
        "adopted",
      )
    }),
  )

  it.effect("stops once the session token ceiling is reached", () =>
    Effect.gen(function* () {
      const budget = makeRewriteBudget()
      const input = {
        budget,
        sessionID: "s",
        slot,
        language: "zh" as const,
        call: fixed("决定。", ReasoningDistillationPolicy.tokens.maxTokensPerSession),
        adopt: () => Effect.succeed(true),
      }
      expect((yield* runReasoningRewrite(input)).status).toBe("adopted")
      expect(yield* runReasoningRewrite(input)).toMatchObject({
        status: "skipped",
        reason: "budget-exhausted",
        modelCalls: 0,
      })
    }),
  )

  it.effect("skips without a model, reports a rejected adoption and never adopts a skipped result", () =>
    Effect.gen(function* () {
      const budget = makeRewriteBudget()
      let adopts = 0
      const adopt = () => Effect.sync(() => (adopts++, undefined))
      expect(
        yield* runReasoningRewrite({ budget, sessionID: "s", slot, language: "zh", call: undefined, adopt }),
      ).toMatchObject({ status: "skipped", reason: "small-model-unavailable", modelCalls: 0 })
      expect(
        yield* runReasoningRewrite({ budget, sessionID: "s", slot, language: "zh", call: fixed(slot.text), adopt }),
      ).toMatchObject({ status: "skipped", reason: "unchanged" })
      expect(adopts).toBe(0)
      expect(
        yield* runReasoningRewrite({ budget, sessionID: "s", slot, language: "zh", call: fixed("决定。"), adopt }),
      ).toMatchObject({ status: "rejected", reason: "adoption-rejected" })
      expect(adopts).toBe(1)
    }),
  )

  it.live("interruption aborts the engine request without counting a failure", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let aborted = false
      const llm = client(() =>
        Effect.promise(
          (signal) =>
            new Promise<LLMResponse>((resolve) => {
              signal.addEventListener("abort", () => ((aborted = true), resolve(response("late"))), { once: true })
              queueMicrotask(() => Effect.runSync(Deferred.succeed(started, undefined)))
            }),
        ),
      )
      const budget = makeRewriteBudget()
      const fiber = yield* runReasoningRewrite({
        budget,
        sessionID: "s",
        slot,
        language: "zh",
        call: (signal) => engineOrganizerCall({ llm, model, effort: "low", timeoutMs: 30_000, signal }),
        adopt: () => Effect.succeed(true),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started).pipe(Effect.timeout(Duration.seconds(2)), Effect.orDie)
      yield* Fiber.interrupt(fiber).pipe(Effect.timeout(Duration.seconds(2)), Effect.orDie)
      expect(aborted).toBe(true)
      expect(budget.snapshot("s")).toEqual({ tokens: 0, consecutiveFailures: 0, paused: false })
    }),
  )
})
