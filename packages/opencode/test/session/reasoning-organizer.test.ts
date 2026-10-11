import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV3 } from "ai/test"
import { sdkOrganizerCall } from "../../src/session/llm"

const finish: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("SDK reasoning organizer stream", () => {
  test("ignores synthetic starts/metadata and completes an active response longer than the idle timeout", async () => {
    let started = 0
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "response-metadata", id: "response" })
            controller.enqueue({ type: "text-start", id: "text" })
            await Bun.sleep(10)
            expect(started).toBe(0)
            controller.enqueue({ type: "raw", rawValue: { choices: [{ delta: { role: "assistant" } }] } })
            for (const text of ["confirmed ", "decision ", "uses ", "safe ", "path"]) {
              await Bun.sleep(40)
              controller.enqueue({ type: "text-delta", id: "text", delta: text })
            }
            controller.enqueue({ type: "text-end", id: "text" })
            controller.enqueue(finish)
            controller.close()
          },
        }),
      }),
    })
    const before = Date.now()
    const result = await sdkOrganizerCall({
      model,
      maxOutputTokens: 100,
      effort: "low",
      timeoutMs: 150,
      signal: new AbortController().signal,
      onResponseStarted: () => started++,
    })({ prompt: "organize" })
    expect(Date.now() - before).toBeGreaterThan(150)
    expect(result).toEqual({ text: "confirmed decision uses safe path", usageTokens: 25, finishReason: "stop" })
    expect(started).toBe(1)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(model.doStreamCalls[0]).toMatchObject({
      temperature: 0,
      maxOutputTokens: 100,
      includeRawChunks: true,
      providerOptions: { openaiCompatible: { reasoningEffort: "low" } },
    })
  })

  for (const responseStarted of [false, true]) {
    test(`aborts a ${responseStarted ? "stalled response" : "response that never starts"} without retry`, async () => {
      let started = 0
      let aborted = false
      const model = new MockLanguageModelV3({
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({ type: "response-metadata", id: "response" })
              if (responseStarted) controller.enqueue({ type: "raw", rawValue: { response: "started" } })
              abortSignal?.addEventListener(
                "abort",
                () => {
                  aborted = true
                  controller.error(abortSignal.reason)
                },
                { once: true },
              )
            },
          }),
        }),
      })
      expect(
        await rejection(
          sdkOrganizerCall({
            model,
            maxOutputTokens: 100,
            effort: "low",
            timeoutMs: 50,
            signal: new AbortController().signal,
            onResponseStarted: () => started++,
          })({ prompt: "organize" }),
        ),
      ).toMatchObject({ message: "Organizer response timed out" })
      expect(started).toBe(responseStarted ? 1 : 0)
      expect(aborted).toBe(true)
      expect(model.doStreamCalls).toHaveLength(1)
    })
  }

  test("preserves cancellation after the response starts", async () => {
    const cancel = new AbortController()
    let starts = 0
    let aborted = false
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true
                controller.error(abortSignal.reason)
              },
              { once: true },
            )
            controller.enqueue({ type: "raw", rawValue: { response: "started" } })
          },
        }),
      }),
    })
    expect(
      await rejection(
        sdkOrganizerCall({
          model,
          maxOutputTokens: 100,
          effort: "low",
          timeoutMs: 1000,
          signal: cancel.signal,
          onResponseStarted: () => {
            starts++
            cancel.abort(new Error("user canceled"))
          },
        })({ prompt: "organize" }),
      ),
    ).toMatchObject({ message: "user canceled" })
    expect(starts).toBe(1)
    expect(aborted).toBe(true)
    expect(model.doStreamCalls).toHaveLength(1)
  })

  test("propagates a streaming provider failure without retry", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "error", error: new Error("provider failed") })
            controller.close()
          },
        }),
      }),
    })
    expect(
      await rejection(
        sdkOrganizerCall({
          model,
          maxOutputTokens: 100,
          effort: "low",
          timeoutMs: 100,
          signal: new AbortController().signal,
        })({ prompt: "organize" }),
      ),
    ).toMatchObject({ message: "provider failed" })
    expect(model.doStreamCalls).toHaveLength(1)
  })
})
