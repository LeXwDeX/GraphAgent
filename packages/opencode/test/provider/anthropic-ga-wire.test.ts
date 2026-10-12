import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createAnthropic } from "@ai-sdk/anthropic"
import { AnthropicMessagesLanguageModel } from "@ai-sdk/anthropic/internal"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"

const require = createRequire(import.meta.url)
const publicCjs: typeof import("@ai-sdk/anthropic") = require("@ai-sdk/anthropic")
const internalCjs: typeof import("@ai-sdk/anthropic/internal") = require("@ai-sdk/anthropic/internal")
const baseURL = "https://mock.invalid/v1"
const legacyBeta = "structured-outputs-2025-11-13"
const schema = { type: "object" as const, properties: { answer: { type: "string" as const } }, required: ["answer"] }
const tool = { type: "function" as const, name: "answer", description: "Answer the question", inputSchema: schema }
const prompt: LanguageModelV3CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "synthetic prompt" }] },
]

const entrypoints = [
  {
    name: "public ESM",
    create: (fetch: typeof globalThis.fetch, headers: Record<string, string>) =>
      createAnthropic({ apiKey: "synthetic-key", baseURL, fetch, headers })("claude-opus-4-6"),
  },
  {
    name: "public CJS",
    create: (fetch: typeof globalThis.fetch, headers: Record<string, string>) =>
      publicCjs.createAnthropic({ apiKey: "synthetic-key", baseURL, fetch, headers })("claude-opus-4-6"),
  },
  {
    name: "internal ESM",
    create: (fetch: typeof globalThis.fetch, headers: Record<string, string>) =>
      new AnthropicMessagesLanguageModel("claude-opus-4-6", {
        provider: "anthropic.messages",
        baseURL,
        fetch,
        headers,
      }),
  },
  {
    name: "internal CJS",
    create: (fetch: typeof globalThis.fetch, headers: Record<string, string>) =>
      new internalCjs.AnthropicMessagesLanguageModel("claude-opus-4-6", {
        provider: "anthropic.messages",
        baseURL,
        fetch,
        headers,
      }),
  },
] satisfies Array<{
  name: string
  create: (fetch: typeof globalThis.fetch, headers: Record<string, string>) => LanguageModelV3
}>

const message = {
  type: "message",
  id: "synthetic",
  model: "claude-opus-4-6",
  role: "assistant",
  content: [{ type: "text", text: "answer" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

function response(stream: boolean, jsonTool: boolean) {
  const content = jsonTool
    ? { type: "tool_use", id: "synthetic-tool", name: "json", input: { answer: "answer" } }
    : message.content[0]
  const stop_reason = jsonTool ? "tool_use" : "end_turn"
  if (!stream) return Response.json({ ...message, content: [content], stop_reason })
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    {
      type: "content_block_start",
      index: 0,
      content_block: jsonTool ? { ...content, input: {} } : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: jsonTool
        ? { type: "input_json_delta", partial_json: JSON.stringify({ answer: "answer" }) }
        : { type: "text_delta", text: "answer" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function capture(
  entrypoint: (typeof entrypoints)[number],
  stream: boolean,
  options: Omit<LanguageModelV3CallOptions, "prompt">,
  headers: Record<string, string> = {},
) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const jsonTool = options.providerOptions?.anthropic?.structuredOutputMode === "jsonTool"
  const text = jsonTool ? JSON.stringify({ answer: "answer" }) : "answer"
  const mockFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      expect(url).toBe(`${baseURL}/messages`)
      if (typeof init?.body !== "string") throw new Error("missing mock request body")
      const body: unknown = JSON.parse(init.body)
      if (!record(body)) throw new Error("invalid mock request body")
      requests.push({ headers: new Headers(init.headers), body })
      return response(stream, jsonTool)
    },
    { preconnect: () => {} },
  )
  const model = entrypoint.create(mockFetch, headers)
  if (stream) {
    const result = await model.doStream({ prompt, ...options })
    const chunks = await Array.fromAsync(result.stream)
    expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
    expect(chunks).toContainEqual(expect.objectContaining({ type: "text-delta", delta: text }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: "finish" }))
  } else {
    const result = await model.doGenerate({ prompt, ...options })
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text }))
  }
  expect(requests).toHaveLength(1)
  expect(requests[0].body.stream).toBe(stream ? true : undefined)
  return requests[0]
}

function betas(headers: Headers) {
  return headers.get("anthropic-beta")?.split(",") ?? []
}

function wireTool(stream: boolean) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
    ...(stream ? { eager_input_streaming: true } : {}),
  }
}

// Exercise the package exports, not a local transport filter. Cloud SDKs share
// the internal model; CJS and ESM each ship their own copy of tool preparation.
for (const entrypoint of entrypoints) {
  for (const stream of [false, true]) {
    describe(`Anthropic GA wire: ${entrypoint.name}, ${stream ? "streaming" : "non-streaming"}`, () => {
      test("ordinary function tools do not add the structured-output beta", async () => {
        const { headers, body } = await capture(entrypoint, stream, { tools: [tool] })
        expect(betas(headers)).toEqual([])
        expect(body.tools).toEqual([wireTool(stream)])
        expect(body).not.toHaveProperty("output_config")
        expect(body).not.toHaveProperty("output_format")
      })

      test("JSON schema output and strict tools keep their GA payload without the beta", async () => {
        const { headers, body } = await capture(entrypoint, stream, {
          tools: [{ ...tool, strict: true }],
          responseFormat: { type: "json", schema },
        })
        expect(betas(headers)).toEqual([])
        expect(body.output_config).toEqual({
          format: { type: "json_schema", schema: { ...schema, additionalProperties: false } },
        })
        expect(body).not.toHaveProperty("output_format")
        expect(body.tools).toEqual([{ ...wireTool(stream), strict: true }])
      })

      test("explicit legacy betas and unrelated caller and automatic betas are preserved", async () => {
        const { headers, body } = await capture(
          entrypoint,
          stream,
          {
            headers: { "anthropic-beta": "context-1m-2025-08-07" },
            providerOptions: { anthropic: { anthropicBeta: ["fine-grained-tool-streaming-2025-05-14"] } },
            tools: [{ ...tool, inputExamples: [{ input: { answer: "example" } }] }],
          },
          { "anthropic-beta": legacyBeta },
        )
        expect(betas(headers).toSorted()).toEqual(
          [
            legacyBeta,
            "context-1m-2025-08-07",
            "fine-grained-tool-streaming-2025-05-14",
            "advanced-tool-use-2025-11-20",
          ].toSorted(),
        )
        expect(body.tools).toEqual([{ ...wireTool(stream), input_examples: [{ answer: "example" }] }])
      })

      test("the existing JSON-tool fallback remains available without the beta", async () => {
        const { headers, body } = await capture(entrypoint, stream, {
          responseFormat: { type: "json", schema },
          providerOptions: { anthropic: { structuredOutputMode: "jsonTool" } },
        })
        expect(betas(headers)).toEqual([])
        expect(body).not.toHaveProperty("output_config")
        expect(body).not.toHaveProperty("output_format")
        expect(body.tools).toEqual([{ ...wireTool(stream), name: "json", description: "Respond with a JSON object." }])
        expect(body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true })
      })
    })
  }
}
