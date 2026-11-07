// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * #953 provider wire boundary: the request-only reminder is a part of the
 * persisted user message, and positional cache markers stay on the persisted
 * part before it. These tests exercise installed provider SDK lowering, not
 * only the intermediate ModelMessage array.
 */
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"
import { RuntimeContext } from "@/session/runtime-context"
import { TodoReminders } from "@/session/todo-reminders"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"

const model = (input: { id: string; providerID: string; npm: string; url: string }): Provider.Model => ({
  id: ModelV2.ID.make(input.id),
  providerID: ProviderV2.ID.make(input.providerID),
  api: { id: input.id, url: input.url, npm: input.npm },
  name: input.id,
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
})

const cacheMessages = (): ModelMessage[] => {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: RuntimeContext.render(["<project_memory_data>epoch 1</project_memory_data>"])! }],
      providerOptions: { graphagent: { context: true, cache: "none" } },
    },
    { role: "user", content: [{ type: "text", text: "persisted user" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "ok" } }],
    },
    {
      role: "user",
      providerOptions: { graphagent: { synthetic: "attachment", cache: "none" } },
      content: [
        {
          type: "text",
          text: "Attached media from tool result:",
          providerOptions: { graphagent: { synthetic: "attachment", cache: "none" } },
        },
        { type: "file", mediaType: "image/png", data: "data:image/png;base64,AA==", filename: "attachment.png" },
      ],
    },
  ]
  return TodoReminders.append(messages, "[todo reminder] ephemeral")
}

const cacheBlocks = (value: unknown) => {
  const text = JSON.stringify(value)
  return (text.match(/cache_control|cachePoint/g) ?? []).length
}

type AnthropicBody = { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
type BedrockBody = AnthropicBody
type OpenAIBody = { messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ id: string }> }> }
type GeminiBody = { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }

const capture = <T>(parse: (body: string) => T) => {
  const bodies: T[] = []
  const fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Missing serialized SDK body")
      bodies.push(parse(init.body))
      throw new Error("Request captured without network")
    },
    { preconnect: () => undefined },
  )
  return { bodies, fetch }
}

type CacheMarker = { type: string }
type V3UserPart = Extract<LanguageModelV3Message, { role: "user" }>["content"][number]
type V3AssistantPart = Extract<LanguageModelV3Message, { role: "assistant" }>["content"][number]
type V3ToolPart = Extract<LanguageModelV3Message, { role: "tool" }>["content"][number]

const prompt = (cacheControl?: CacheMarker, cachePoint?: CacheMarker): LanguageModelV3Prompt => [
  {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: "persisted user",
        providerOptions: cacheControl ? { anthropic: { cacheControl } } : cachePoint ? { bedrock: { cachePoint } } : {},
      },
      {
        type: "text" as const,
        text: "[todo reminder] ephemeral",
        providerOptions: { graphagent: { cache: "none" } },
      },
    ],
  },
  {
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call_1",
        toolName: "t1",
        input: { query: "x" },
      },
    ],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "t1",
        output: { type: "text" as const, value: "ok" },
      },
    ],
  },
]

const toV3Prompt = (messages: ModelMessage[]): LanguageModelV3Prompt =>
  messages.map((message): LanguageModelV3Message => {
    if (message.role === "system") return message
    if (message.role === "user") {
      const content: V3UserPart[] =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content.map((part): V3UserPart => {
              if (part.type === "text") return { type: "text" as const, text: part.text, providerOptions: part.providerOptions }
              if (part.type === "file") {
                if (typeof part.data !== "string" && !(part.data instanceof URL)) throw new Error("Unsupported file data")
                return {
                  type: "file" as const,
                  data: part.data,
                  mediaType: part.mediaType,
                  filename: part.filename,
                  providerOptions: part.providerOptions,
                }
              }
              throw new Error(`Unexpected user part: ${part.type}`)
            })
      return { role: "user", content, providerOptions: message.providerOptions }
    }
    if (message.role === "assistant") {
      const content: V3AssistantPart[] =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content.map((part): V3AssistantPart => {
              if (part.type === "text") return { type: "text" as const, text: part.text, providerOptions: part.providerOptions }
              if (part.type === "file") {
                if (typeof part.data !== "string" && !(part.data instanceof URL)) throw new Error("Unsupported file data")
                return {
                  type: "file" as const,
                  data: part.data,
                  mediaType: part.mediaType,
                  filename: part.filename,
                  providerOptions: part.providerOptions,
                }
              }
              if (part.type === "reasoning") return { type: "reasoning" as const, text: part.text, providerOptions: part.providerOptions }
              if (part.type === "tool-call") return { ...part }
              if (part.type === "tool-result") {
                const output = part.output
                if (output.type !== "text" && output.type !== "error-text" && output.type !== "json" && output.type !== "error-json")
                  throw new Error("Unsupported tool output")
                return { ...part, output }
              }
              throw new Error(`Unexpected assistant part: ${part.type}`)
            })
      return { role: "assistant", content, providerOptions: message.providerOptions }
    }
    const content: V3ToolPart[] = message.content.map((part): V3ToolPart => {
      if (part.type === "tool-result") {
        const output = part.output
        if (output.type !== "text" && output.type !== "error-text" && output.type !== "json" && output.type !== "error-json")
          throw new Error("Unsupported tool output")
        return { ...part, output }
      }
      throw new Error(`Unexpected tool part: ${part.type}`)
    })
    return { role: "tool", content, providerOptions: message.providerOptions }
  })

describe("todo reminder provider wire boundary (#953)", () => {
  test("Anthropic keeps cache_control on the persisted user block before the reminder", async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic")
    const { bodies, fetch } = capture<AnthropicBody>((body) => JSON.parse(body))
    const model = createAnthropic({ apiKey: "fixture", fetch })("claude-haiku-5-5")
    await Promise.resolve(model.doGenerate({ prompt: prompt({ type: "ephemeral" }), maxOutputTokens: 8 })).catch(
      () => undefined,
    )
    const body = bodies[0]
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(body.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "persisted user",
      cache_control: { type: "ephemeral" },
    })
    expect(body.messages[0]?.content[1]).toMatchObject({ type: "text", text: "[todo reminder] ephemeral" })
    expect(body.messages[0]?.content[1]?.cache_control).toBeUndefined()
  })

  test("Bedrock keeps cachePoint on the persisted user block before the reminder", async () => {
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
    const { bodies, fetch } = capture<BedrockBody>((body) => JSON.parse(body))
    const model = createAmazonBedrock({
      apiKey: "fixture",
      region: "us-east-1",
      fetch,
    })("anthropic.claude-3-5-sonnet-20241022-v2:0")
    await Promise.resolve(
      model.doGenerate({
        prompt: prompt(undefined, { type: "default" }),
        tools: [{ type: "function", name: "t1", inputSchema: { type: "object", properties: {} } }],
        maxOutputTokens: 8,
      }),
    ).catch(() => undefined)
    const body = bodies[0]
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(body.messages[0]?.content).toMatchObject([
      { text: "persisted user" },
      { cachePoint: { type: "default" } },
      { text: "[todo reminder] ephemeral" },
    ])
  })

  test("OpenAI preserves user/assistant-tool/tool ordering with the reminder inline", async () => {
    const { createOpenAI } = await import("@ai-sdk/openai")
    const { bodies, fetch } = capture<OpenAIBody>((body) => JSON.parse(body))
    const model = createOpenAI({ apiKey: "fixture", fetch }).chat("gpt-4o-mini")
    await Promise.resolve(model.doGenerate({ prompt: prompt(), maxOutputTokens: 8 })).catch(() => undefined)
    const body = bodies[0]
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(JSON.stringify(body.messages[0]?.content)).toContain("persisted user")
    expect(JSON.stringify(body.messages[0]?.content)).toContain("[todo reminder] ephemeral")
    expect(body.messages[1]?.tool_calls?.[0]?.id).toBe("call_1")
  })

  test("Gemini preserves user/model/tool-response ordering with the reminder inline", async () => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
    const { bodies, fetch } = capture<GeminiBody>((body) => JSON.parse(body))
    const model = createGoogleGenerativeAI({ apiKey: "fixture", fetch })("gemini-2.5-flash")
    await Promise.resolve(model.doGenerate({ prompt: prompt(), maxOutputTokens: 8 })).catch(() => undefined)
    const body = bodies[0]
    expect(body.contents.map((message) => message.role)).toEqual(["user", "model", "user"])
    const flat = JSON.stringify(body)
    expect(flat).toContain("persisted user")
    expect(flat).toContain("[todo reminder] ephemeral")
    expect(flat).toContain("functionCall")
    expect(flat).toContain("functionResponse")
  })

  test("Anthropic caches the persisted user and skips synthetic attachment and runtime context", async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic")
    const { bodies, fetch } = capture<AnthropicBody>((body) => JSON.parse(body))
    const anthropic = model({
      id: "claude-haiku-5-5",
      providerID: "anthropic",
      npm: "@ai-sdk/anthropic",
      url: "https://api.anthropic.com",
    })
    const sdk = createAnthropic({ apiKey: "fixture", fetch })("claude-haiku-5-5")
    const transformed = ProviderTransform.message(cacheMessages(), anthropic, {})
    await Promise.resolve(sdk.doGenerate({ prompt: toV3Prompt(transformed), maxOutputTokens: 8 })).catch(() => undefined)
    const body = bodies[0]
    const persisted = body.messages[0]
    expect(persisted.content.find((block) => block.text === "persisted user")).toMatchObject({
      text: "persisted user",
      cache_control: { type: "ephemeral" },
    })
    const attachment = body.messages.find((message) => JSON.stringify(message).includes("Attached media"))
    expect(attachment).toBeDefined()
    expect(JSON.stringify(attachment)).not.toContain("cache_control")
    const context = body.messages
      .flatMap((message) => message.content)
      .find((block) => JSON.stringify(block).includes("<project_memory_data>"))
    expect(context).toBeDefined()
    expect(JSON.stringify(context)).not.toContain("cache_control")
    expect(cacheBlocks(attachment)).toBe(0)
    expect(cacheBlocks(context)).toBe(0)
  })

  test("Bedrock caches the persisted user and skips synthetic attachment and runtime context", async () => {
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
    const { bodies, fetch } = capture<BedrockBody>((body) => JSON.parse(body))
    const bedrock = model({
      id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      providerID: "amazon-bedrock",
      npm: "@ai-sdk/amazon-bedrock",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com",
    })
    const sdk = createAmazonBedrock({ apiKey: "fixture", region: "us-east-1", fetch })(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    )
    const transformed = ProviderTransform.message(cacheMessages(), bedrock, {})
    await Promise.resolve(
      sdk.doGenerate({
        prompt: toV3Prompt(transformed),
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        maxOutputTokens: 8,
      }),
    ).catch(() => undefined)
    const body = bodies[0]
    const persisted = body.messages[0]
    const persistedIndex = persisted.content.findIndex((block) => block.text === "persisted user")
    expect(persistedIndex).toBeGreaterThanOrEqual(0)
    expect(persisted.content[persistedIndex + 1]).toEqual({ cachePoint: { type: "default" } })
    const attachment = body.messages.find((message) => JSON.stringify(message).includes("Attached media"))
    expect(attachment).toBeDefined()
    expect(JSON.stringify(attachment)).not.toContain("cachePoint")
    const context = body.messages
      .flatMap((message) => message.content)
      .find((block) => JSON.stringify(block).includes("<project_memory_data>"))
    expect(context).toBeDefined()
    expect(JSON.stringify(context)).not.toContain("cachePoint")
    expect(cacheBlocks(attachment)).toBe(0)
    expect(cacheBlocks(context)).toBe(0)
  })
})
