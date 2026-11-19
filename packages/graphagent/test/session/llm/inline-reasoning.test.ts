// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { ModelV2 } from "@graphagent/core/model"
import { resolveProfile } from "@graphagent/core/model-profile"
import { ProviderV2 } from "@graphagent/core/provider"
import { LLMEvent } from "@graphagent/llm"
import type { LLMClientShape } from "@graphagent/llm/route"
import { streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Effect, Layer, Stream } from "effect"
import { wrapInlineReasoning } from "@/provider/inline-reasoning"
import type { Provider } from "@/provider/provider"
import { LLMInlineReasoning } from "@/session/llm/inline-reasoning"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.empty)

const TEXT = "text-0"

/** One text block the way a native route streams it: the start, the given deltas, the end. */
const block = (deltas: readonly string[], id = TEXT): LLMEvent[] => [
  LLMEvent.textStart({ id }),
  ...deltas.map((text) => LLMEvent.textDelta({ id, text })),
  LLMEvent.textEnd({ id }),
]

const split = (events: readonly LLMEvent[], tag = "think") =>
  Stream.fromIterable(events).pipe(
    LLMInlineReasoning.split(tag),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  )

/** What a consumer reads from the events: the concatenated reasoning and answer text. */
const texts = (events: readonly LLMEvent[]) => ({
  reasoning: events
    .filter(LLMEvent.is.reasoningDelta)
    .map((event) => event.text)
    .join(""),
  answer: events
    .filter(LLMEvent.is.textDelta)
    .map((event) => event.text)
    .join(""),
})

/** A compact form of an event list, for exact comparisons of order, ids and text. */
const shape = (events: readonly LLMEvent[]) =>
  events.map((event) => {
    if (event.type === "text-delta" || event.type === "reasoning-delta")
      return `${event.type}:${event.id}:${JSON.stringify(event.text)}`
    if (
      event.type === "text-start" ||
      event.type === "text-end" ||
      event.type === "reasoning-start" ||
      event.type === "reasoning-end"
    )
      return `${event.type}:${event.id}`
    return event.type
  })

const finish: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
}

/** A model that streams the given deltas as one text block, the way an endpoint with inline reasoning does. */
const answering = (deltas: readonly string[]): LanguageModelV3 =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "text-1" })
          for (const delta of deltas) controller.enqueue({ type: "text-delta", id: "text-1", delta })
          controller.enqueue({ type: "text-end", id: "text-1" })
          controller.enqueue(finish)
          controller.close()
        },
      }),
    }),
  })

/** The AI SDK path: the middleware `wrapInlineReasoning` puts around the language model. */
async function throughAISDK(deltas: readonly string[], tag = "think") {
  const result = streamText({ model: wrapInlineReasoning(answering(deltas), tag), prompt: "hello" })
  let reasoning = ""
  let answer = ""
  for await (const part of result.fullStream) {
    if (part.type === "reasoning-delta") reasoning += part.text
    if (part.type === "text-delta") answer += part.text
  }
  return { reasoning, answer }
}

// Fragmentations of the text an endpoint with inline reasoning streams. The AI SDK path and the native split must read
// the same reasoning and the same answer out of each of them.
const FRAGMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["a tag cut between two deltas", ["<thi", "nk>plan</thi", "nk>answer"]],
  ["a closing tag cut after its first character", ["<think>plan<", "/think>answer"]],
  ["a tag that arrives one character at a time", "<think>plan</think>answer".split("")],
  ["an unclosed tag", ["<think>still", " thinking", " and thinking"]],
  ["an unclosed tag after an answer", ["answer<think>trailing", " thought"]],
  ["several blocks in one delta", ["a<think>b</think>c<think>d</think>e"]],
  ["several blocks cut between deltas", ["a<th", "ink>b</th", "ink>c<think>d</think", ">e"]],
  ["two blocks back to back", ["<think>a</think><think>b</think>c"]],
  ["an empty block", ["<think></think>answer"]],
  ["no tag at all", ["plain ", "answer"]],
  ["an angle bracket that is no tag", ["1 <", " 2 and <thin", "g> 3"]],
  ["only reasoning", ["<think>just this</think>"]],
  ["blank lines after the block", ["<think>r</think>", "\n\n", "answer"]],
]

describe("LLMInlineReasoning.split", () => {
  for (const [name, deltas] of FRAGMENTS) {
    it.effect(`reads the same reasoning and answer as the AI SDK path: ${name}`, () =>
      Effect.gen(function* () {
        const native = texts(yield* split(block(deltas)))
        expect(native).toEqual(yield* Effect.promise(() => throughAISDK(deltas)))
      }),
    )
  }

  it.effect("moves the reasoning out of one delta and puts the text start behind it", () =>
    Effect.gen(function* () {
      expect(shape(yield* split(block(["<think>a</think>b"])))).toEqual([
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"a"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        'text-delta:text-0:"b"',
        "text-end:text-0",
      ])
    }),
  )

  it.effect("leaves a text block without a tag as it is", () =>
    Effect.gen(function* () {
      const events = block(["plain ", "answer"])
      expect(shape(yield* split(events))).toEqual(shape(events))
    }),
  )

  it.effect("keeps a reasoning block open across deltas, and closes it at the tag", () =>
    Effect.gen(function* () {
      expect(shape(yield* split(block(["<think>a", "b</think>", "c"])))).toEqual([
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"a"',
        'reasoning-delta:text-0:inline-0:"b"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        'text-delta:text-0:"c"',
        "text-end:text-0",
      ])
    }),
  )

  it.effect("starts a block of its own for each tag pair and separates the pieces of a kind with a newline", () =>
    Effect.gen(function* () {
      expect(shape(yield* split(block(["x<think>y</think>z<think>w</think>v"])))).toEqual([
        "text-start:text-0",
        'text-delta:text-0:"x"',
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"y"',
        "reasoning-end:text-0:inline-0",
        'text-delta:text-0:"\\nz"',
        "reasoning-start:text-0:inline-1",
        'reasoning-delta:text-0:inline-1:"\\nw"',
        "reasoning-end:text-0:inline-1",
        'text-delta:text-0:"\\nv"',
        "text-end:text-0",
      ])
    }),
  )

  it.effect("keeps a tag that is never closed as reasoning, and closes the block at the end of the text", () =>
    Effect.gen(function* () {
      expect(shape(yield* split(block(["<think>unfinished"])))).toEqual([
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"unfinished"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        "text-end:text-0",
      ])
    }),
  )

  it.effect("does not lose the start of a tag the text ends in", () =>
    Effect.gen(function* () {
      expect(shape(yield* split(block(["answer<th"])))).toEqual([
        "text-start:text-0",
        'text-delta:text-0:"answer"',
        'text-delta:text-0:"<th"',
        "text-end:text-0",
      ])
      expect(shape(yield* split(block(["<think>idea</thi"])))).toEqual([
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"idea"',
        'reasoning-delta:text-0:inline-0:"</thi"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        "text-end:text-0",
      ])
    }),
  )

  it.effect("closes an open reasoning block when the stream ends without the end of the text", () =>
    Effect.gen(function* () {
      const events = [LLMEvent.textStart({ id: TEXT }), LLMEvent.textDelta({ id: TEXT, text: "<think>half" })]
      expect(shape(yield* split(events))).toEqual([
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"half"',
        "reasoning-end:text-0:inline-0",
      ])
    }),
  )

  it.effect("passes every other event on in its place", () =>
    Effect.gen(function* () {
      const events = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: TEXT }),
        LLMEvent.textDelta({ id: TEXT, text: "<think>a</think>b" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
        LLMEvent.textEnd({ id: TEXT }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      expect(shape(yield* split(events))).toEqual([
        "step-start",
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"a"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        'text-delta:text-0:"b"',
        "tool-call",
        "text-end:text-0",
        "step-finish",
        "finish",
      ])
    }),
  )

  it.effect("keeps the state of each text block apart", () =>
    Effect.gen(function* () {
      const events = [
        LLMEvent.textStart({ id: "text-0" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-0", text: "<thi" }),
        LLMEvent.textDelta({ id: "text-1", text: "plain" }),
        LLMEvent.textDelta({ id: "text-0", text: "nk>a</think>b" }),
        LLMEvent.textEnd({ id: "text-0" }),
        LLMEvent.textEnd({ id: "text-1" }),
      ]
      expect(shape(yield* split(events))).toEqual([
        "text-start:text-1",
        'text-delta:text-1:"plain"',
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"a"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        'text-delta:text-0:"b"',
        "text-end:text-0",
        "text-end:text-1",
      ])
    }),
  )

  it.effect("does not reuse the id of a reasoning block the stream already has", () =>
    Effect.gen(function* () {
      const events = [
        LLMEvent.reasoningStart({ id: "text-0:inline-0" }),
        LLMEvent.reasoningDelta({ id: "text-0:inline-0", text: "native" }),
        LLMEvent.reasoningEnd({ id: "text-0:inline-0" }),
        ...block(["<think>inline</think>answer"]),
      ]
      const out = yield* split(events)
      expect(shape(out).filter((item) => item.startsWith("reasoning-start"))).toEqual([
        "reasoning-start:text-0:inline-0",
        "reasoning-start:text-0:inline-1",
      ])
      expect(texts(out)).toEqual({ reasoning: "nativeinline", answer: "answer" })
    }),
  )

  it.effect("reads the tag it is given", () =>
    Effect.gen(function* () {
      expect(texts(yield* split(block(["<reasoning>a</reasoning>b", "<think>c</think>"]), "reasoning"))).toEqual({
        reasoning: "a",
        answer: "b<think>c</think>",
      })
    }),
  )

  test("a step is pure: it leaves its state alone and gives the same answer for the same input", () => {
    const delta = LLMEvent.textDelta({ id: TEXT, text: "<think>a</thi" })
    const [state] = LLMInlineReasoning.step("think", LLMInlineReasoning.initial(), LLMEvent.textStart({ id: TEXT }))
    const before = JSON.stringify(Array.from(state.blocks))
    const first = LLMInlineReasoning.step("think", state, delta)
    const second = LLMInlineReasoning.step("think", state, delta)
    expect(JSON.stringify(Array.from(state.blocks))).toBe(before)
    expect(first).toEqual(second)
    expect(first[0]).not.toBe(state)
  })
})

describe("the native runtime splits inline reasoning", () => {
  const flags = { text: true, audio: false, image: false, video: false, pdf: false }
  const model = (apiID: string, options: { npm?: string; inlineTag?: string } = {}): Provider.Model => {
    const npm = options.npm ?? "@ai-sdk/openai-compatible"
    return {
      id: ModelV2.ID.make(apiID),
      providerID: ProviderV2.ID.make("relay"),
      api: { id: apiID, url: "https://relay.test/v1", npm },
      name: apiID,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: flags,
        output: flags,
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      ...(options.inlineTag === undefined
        ? {}
        : {
            profile: resolveProfile({
              providerID: "relay",
              apiID,
              npm,
              config: { profile: { reasoning_mode: { inline_tag: options.inlineTag } } },
            }),
          }),
    }
  }
  const provider: Provider.Info = {
    id: ProviderV2.ID.make("relay"),
    name: "Relay",
    source: "config",
    env: [],
    options: { apiKey: "test-key", baseURL: "https://relay.test/v1" },
    models: {},
  }

  /** The events the native runtime hands on when the endpoint streams `deltas` as one text block. */
  const through = (target: Provider.Model, deltas: readonly string[]) =>
    Effect.gen(function* () {
      const llmClient: LLMClientShape = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            ...block(deltas),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]),
        generate: () => Effect.die("unused"),
      }
      const native = yield* LLMNativeRuntime.stream({
        model: target,
        provider,
        auth: undefined,
        llmClient,
        messages: [],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)
      return Array.from(yield* Stream.runCollect(native.stream))
    })

  it.effect("turns the tag of a model a built-in rule names into reasoning events", () =>
    Effect.gen(function* () {
      const events = yield* through(model("qwen3-max"), ["<think>pla", "n</think>answer"])
      expect(shape(events)).toEqual([
        "step-start",
        "reasoning-start:text-0:inline-0",
        'reasoning-delta:text-0:inline-0:"pla"',
        'reasoning-delta:text-0:inline-0:"n"',
        "reasoning-end:text-0:inline-0",
        "text-start:text-0",
        'text-delta:text-0:"answer"',
        "text-end:text-0",
        "step-finish",
        "finish",
      ])
    }),
  )

  it.effect("reads the same text as the AI SDK path", () =>
    Effect.gen(function* () {
      const deltas = ["a<th", "ink>b</th", "ink>c<think>d</think", ">e"]
      expect(texts(yield* through(model("deepseek-r1"), deltas))).toEqual(
        yield* Effect.promise(() => throughAISDK(deltas)),
      )
    }),
  )

  it.effect("leaves the text of a model no rule names as it is", () =>
    Effect.gen(function* () {
      const events = yield* through(model("local-think"), ["<think>a</think>b"])
      expect(texts(events)).toEqual({ reasoning: "", answer: "<think>a</think>b" })
      expect(events.some(LLMEvent.is.reasoningStart)).toBe(false)
    }),
  )

  it.effect("leaves the text of a model alone whose configured inline_tag is empty", () =>
    Effect.gen(function* () {
      const events = yield* through(model("qwen3-max", { inlineTag: "" }), ["<think>a</think>b"])
      expect(texts(events)).toEqual({ reasoning: "", answer: "<think>a</think>b" })
    }),
  )

  it.effect("reads the tag the configuration declares", () =>
    Effect.gen(function* () {
      const events = yield* through(model("local-think", { inlineTag: "reasoning" }), [
        "<reasoning>a</reasoning>b<think>c</think>",
      ])
      expect(texts(events)).toEqual({ reasoning: "a", answer: "b<think>c</think>" })
    }),
  )
})
