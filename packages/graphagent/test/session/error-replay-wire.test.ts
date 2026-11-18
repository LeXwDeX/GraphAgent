// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, jsonSchema, type LanguageModel } from "ai"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@graphagent/llm/route"
import { LLMNative } from "../../src/session/llm/native-request"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// An assistant step that ran two tools and then died on a 502 must keep those tool calls and their results in the
// next request, followed by a runtime note. It is checked on the bodies that leave for the provider, through the AI
// SDK path (the default) and through the native runtime (GRAPHAGENT_NATIVE_LLM=true).

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
)

const sessionID = SessionID.make("ses_error_replay_fixture")
const baseURL = "https://ai.example.test/v1"
const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: { "x-model": "model-header" },
  release_date: "2026-01-01",
}
const fixture = (id: string, providerID: string, npm: string): Provider.Model => ({
  ...baseModel,
  id: ModelV2.ID.make(id),
  providerID: ProviderV2.ID.make(providerID),
  api: { id, url: baseURL, npm },
})

type Fixture = {
  readonly name: string
  readonly model: Provider.Model
  /** The route the native runtime picks for this model. */
  readonly route: string
  /** The AI SDK language model for this package, sending its requests through `fetch`. */
  readonly sdk: (fetch: typeof globalThis.fetch) => LanguageModel
  /** The ids of the tool calls and of the tool results in the body, in order. */
  readonly pairs: (body: any) => { calls: string[]; results: string[] }
  /** The layout of the Anthropic body, which differs between the two paths. */
  readonly layout?: (body: any, path: "sdk" | "native") => void
}

// The note is one block with source="runtime" (#1456): its opening tag, then the note.
const NOTE = '<system-reminder source="runtime">\nThe previous assistant step ended with an error (APIError, HTTP 502).'

const blocks = (body: any): any[] =>
  body.messages.flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))

const fixtures: Fixture[] = [
  {
    name: "Anthropic Messages",
    model: fixture("claude-sonnet-fixture", "anthropic", "@ai-sdk/anthropic"),
    route: "anthropic-messages",
    sdk: (fetch) => createAnthropic({ apiKey: "fixture-key", baseURL, fetch })("claude-sonnet-fixture"),
    pairs: (body) => ({
      calls: blocks(body)
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id),
      results: blocks(body)
        .filter((block) => block.type === "tool_result")
        .map((block) => block.tool_use_id),
    }),
    layout: (body, path) => {
      const roles = body.messages.map((message: any) => message.role)
      const types = (index: number) => body.messages[index].content.map((block: any) => block.type)
      if (path === "native") {
        // The native lowering keeps the tool results in a user message of their own.
        expect(roles).toEqual(["user", "assistant", "user", "user", "user"])
        expect(types(2)).toEqual(["tool_result", "tool_result"])
        expect(body.messages[3].content[0].text.startsWith(NOTE)).toBe(true)
        expect(body.messages[4].content[0].text).toBe("continue")
        return
      }
      // The AI SDK joins the tool results, the note and the next prompt into one user message.
      expect(roles).toEqual(["user", "assistant", "user"])
      expect(types(2)).toEqual(["tool_result", "tool_result", "text", "text"])
      expect(body.messages[2].content[2].text.startsWith(NOTE)).toBe(true)
      expect(body.messages[2].content[3].text).toBe("continue")
    },
  },
  {
    name: "OpenAI Responses",
    model: fixture("gpt-fixture", "openai", "@ai-sdk/openai"),
    route: "openai-responses",
    sdk: (fetch) => createOpenAI({ apiKey: "fixture-key", baseURL, fetch }).responses("gpt-fixture"),
    pairs: (body) => ({
      calls: body.input.filter((item: any) => item.type === "function_call").map((item: any) => item.call_id),
      results: body.input.filter((item: any) => item.type === "function_call_output").map((item: any) => item.call_id),
    }),
  },
  {
    name: "OpenAI-compatible Chat",
    model: fixture("compat-fixture", "relay", "@ai-sdk/openai-compatible"),
    route: "openai-compatible-chat",
    sdk: (fetch) =>
      createOpenAICompatible({ name: "relay", apiKey: "fixture-key", baseURL, fetch }).chatModel("compat-fixture"),
    pairs: (body) => ({
      calls: body.messages.flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => call.id)),
      results: body.messages
        .filter((message: any) => message.role === "tool")
        .map((message: any) => message.tool_call_id),
    }),
  },
]

const messageID = (index: number) => MessageID.make(`msg_${String(index).padStart(3, "0")}`)
const partRef = (index: number, offset: number) => ({
  id: PartID.make(`prt_${index}_${offset}`),
  messageID: messageID(index),
  sessionID,
})

function prompt(index: number, model: Provider.Model, text: string): SessionV1.WithParts {
  return {
    info: {
      id: messageID(index),
      sessionID,
      role: "user",
      time: { created: index },
      agent: "fixture",
      model: { providerID: model.providerID, modelID: model.id },
      tools: {},
    },
    parts: [{ ...partRef(index, 0), type: "text", text }],
  }
}

// Two tools settled (one finished, one aborted at cleanup), then the step died on a 502 and its remaining text and
// reasoning never completed.
function history(model: Provider.Model): SessionV1.WithParts[] {
  const failure = new SessionV1.APIError({
    message: "bad gateway",
    statusCode: 502,
    isRetryable: true,
  }).toObject() as SessionV1.Assistant["error"]
  const at = (offset: number) => partRef(2, offset)
  return [
    prompt(1, model, "run it"),
    {
      info: {
        id: messageID(2),
        sessionID,
        role: "assistant",
        time: { created: 2 },
        error: failure,
        parentID: messageID(1),
        modelID: model.id,
        providerID: model.providerID,
        mode: "",
        agent: "fixture",
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { ...at(0), type: "step-start" },
        {
          ...at(1),
          type: "tool",
          callID: "call_a",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo a" },
            output: "ok-a",
            title: "bash",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
        {
          ...at(2),
          type: "tool",
          callID: "call_b",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "echo b" },
            error: "Tool execution aborted",
            metadata: { interrupted: true },
            time: { start: 0, end: 1 },
          },
        },
        { ...at(3), type: "step-start" },
        { ...at(4), type: "reasoning", text: "cut-off thinking", time: { start: 0 } },
        { ...at(5), type: "text", text: "cut-off" },
      ],
    },
    prompt(3, model, "continue"),
  ]
}

const modelMessages = async (model: Provider.Model) =>
  ProviderTransform.message(await MessageV2.toModelMessages(history(model), model, { cache: "verify" }), model, {})

// What the AI SDK sends: the request body its provider package builds. The fake transport records it and fails the
// call, so nothing leaves the process.
async function sdkBody(target: Fixture): Promise<unknown> {
  const bodies: unknown[] = []
  const transport: typeof globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Missing fixture SDK request body")
      bodies.push(JSON.parse(init.body))
      throw new Error("fixture transport stops after recording the request")
    },
    { preconnect() {} },
  )
  await generateText({
    model: target.sdk(transport),
    messages: await modelMessages(target.model),
    tools: {
      bash: {
        description: "Fixture bash",
        inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
      },
    },
    maxRetries: 0,
  }).catch(() => undefined)
  expect(bodies).toHaveLength(1)
  return bodies[0]
}

function expectReplay(target: Fixture, body: unknown) {
  const text = JSON.stringify(body)
  expect(text).not.toContain("cut-off")
  // The note comes once, after the last tool call, so the model reads the results before it.
  // `text` is the body as JSON, in which the note's line break and quotes are escaped.
  const note = JSON.stringify(NOTE).slice(1, -1)
  expect(text.split(note)).toHaveLength(2)
  expect(text.indexOf(note)).toBeGreaterThan(text.lastIndexOf("call_b"))
  // Every tool call has a result with its id, and nothing else.
  expect(target.pairs(body)).toEqual({ calls: ["call_a", "call_b"], results: ["call_a", "call_b"] })
}

for (const target of fixtures) {
  describe(`an assistant step that ended with a provider error, ${target.name}`, () => {
    test("keeps its settled tool calls and results before the runtime note through the AI SDK", async () => {
      const body = await sdkBody(target)
      expectReplay(target, body)
      target.layout?.(body, "sdk")
    })

    it.effect("keeps its settled tool calls and results before the runtime note through the native runtime", () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare(
          LLMNative.request({
            model: target.model,
            apiKey: "fixture-key",
            messages: yield* Effect.promise(() => modelMessages(target.model)),
          }),
        )
        expect(prepared.route).toBe(target.route)
        expectReplay(target, prepared.body)
        target.layout?.(prepared.body, "native")
      }),
    )
  })
}
