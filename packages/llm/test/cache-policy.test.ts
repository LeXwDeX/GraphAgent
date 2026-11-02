import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message, ToolCallPart, ToolResultPart } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AmazonBedrock } from "../src/providers"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import * as BedrockConverse from "../src/protocols/bedrock-converse"
import * as Gemini from "../src/protocols/gemini"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { applyCachePolicy } from "../src/cache-policy"
import { it } from "./lib/effect"

type OpenAIOrGeminiBody = {
  messages?: Array<{ role: string; tool_calls?: Array<{ id: string }> }>
  contents?: Array<{ role: string }>
}

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const bedrockModel = AmazonBedrock.configure({
  credentials: { region: "us-east-1", accessKeyId: "fixture", secretAccessKey: "fixture" },
}).model("anthropic.claude-3-5-sonnet-20241022-v2:0")

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const geminiModel = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-2.5-flash" })

describe("applyCachePolicy", () => {
  it.effect("undefined cache resolves to 'auto' (the recommended default)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "You are concise.",
          prompt: "hi",
        }),
      )

      // No explicit cache field → auto policy fires → last system part + latest
      // user message both get cache_control markers.
      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      })
    }),
  )

  it.effect("'auto' marks the last tool, last system part, and latest user message on Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [
            Message.user("first user"),
            Message.assistant("assistant reply"),
            Message.user("latest user message"),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys A", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "first user" }] },
          { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
          {
            role: "user",
            content: [{ type: "text", text: "latest user message", cache_control: { type: "ephemeral" } }],
          },
        ],
      })
    }),
  )

  it.effect("'auto' is a no-op on OpenAI (implicit caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { messages: Array<{ content: unknown }> }
      // OpenAI doesn't accept cache_control on messages — policy must skip.
      const flat = JSON.stringify(body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' is a no-op on Gemini (out-of-band caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: geminiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const flat = JSON.stringify(prepared.body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' on Bedrock emits cachePoint markers in the right places", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("first user"), Message.assistant("reply"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "t1" } }, { cachePoint: { type: "default" } }],
        },
        system: [{ text: "Sys" }, { cachePoint: { type: "default" } }],
        messages: [
          { role: "user", content: [{ text: "first user" }] },
          { role: "assistant", content: [{ text: "reply" }] },
          { role: "user", content: [{ text: "latest user" }, { cachePoint: { type: "default" } }] },
        ],
      })
    }),
  )

  it.effect("'none' disables auto placement even when manual hints exist", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: undefined }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("granular object form: tools-only marks just tools", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: { tools: true },
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("auto policy preserves manual CacheHints on other parts", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            { type: "text", text: "first system", cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }) },
            { type: "text", text: "last system" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { system: Array<{ text: string; cache_control?: unknown }> }
      expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("ttlSeconds in the policy flows through to wire markers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          prompt: "hi",
          cache: { system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      })
    }),
  )

  it.effect("messages: { tail: 2 } marks the last 2 message boundaries", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2"), Message.assistant("a2")],
          cache: { messages: { tail: 2 } },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[2]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages[3]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("'latest-assistant' marks the last assistant message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2")],
          cache: { messages: "latest-assistant" },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages[2]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("'auto' skips an ephemeral message and keeps the boundary on stable content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [
            Message.user("persisted user"),
            Message.make({
              role: "user",
              content: [Message.text("[todo reminder] ephemeral")],
              metadata: { cache: "none" },
            }),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ type: "text", text: "persisted user", cache_control: { type: "ephemeral" } }] },
          { role: "user", content: [{ type: "text", text: "[todo reminder] ephemeral" }] },
        ],
      })
    }),
  )

  it.effect("Bedrock keeps the cachePoint before an ephemeral message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          messages: [
            Message.user("persisted user"),
            Message.make({
              role: "user",
              content: [Message.text("[todo reminder] ephemeral")],
              metadata: { cache: "none" },
            }),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ text: "persisted user" }, { cachePoint: { type: "default" } }] },
          { role: "user", content: [{ text: "[todo reminder] ephemeral" }] },
        ],
      })
    }),
  )

  it.effect("keeps the cache breakpoint on the persisted part in a tool-call continuation", () =>
    Effect.gen(function* () {
      const continuation = (reminder: boolean) =>
        LLM.request({
          model: anthropicModel,
          cache: "auto",
          messages: [
            Message.make({
              role: "user",
              content: [
                Message.text("persisted user"),
                ...(reminder
                  ? [{ type: "text" as const, text: "[todo reminder] ephemeral", metadata: { cache: "none" } }]
                  : []),
              ],
            }),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "t1", input: { query: "x" } })]),
            Message.tool(ToolResultPart.make({ id: "call_1", name: "t1", result: { ok: true } })),
          ],
        })

      const withReminder = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(continuation(true))
      const withoutReminder = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(continuation(false))
      const withBody = withReminder.body
      const withoutBody = withoutReminder.body

      expect(withBody.messages[0]?.content[0]).toEqual({
        type: "text",
        text: "persisted user",
        cache_control: { type: "ephemeral" },
      })
      expect(withBody.messages[0]?.content[1]).toMatchObject({ type: "text", text: "[todo reminder] ephemeral" })
      expect(withBody.messages[0]?.content[1]?.cache_control).toBeUndefined()
      expect(withBody.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      // Compare the actual wire prefix up to the positional cache breakpoint,
      // not a filtered app-level message list.
      expect([withBody.system, withBody.messages[0]?.content[0]]).toEqual([
        withoutBody.system,
        withoutBody.messages[0]?.content[0],
      ])
    }),
  )

  it.effect("keeps the Bedrock cachePoint before the ephemeral part in a tool-call continuation", () =>
    Effect.gen(function* () {
      const continuation = (reminder: boolean) =>
        LLM.request({
          model: bedrockModel,
          cache: "auto",
          messages: [
            Message.make({
              role: "user",
              content: [
                Message.text("persisted user"),
                ...(reminder
                  ? [{ type: "text" as const, text: "[todo reminder] ephemeral", metadata: { cache: "none" } }]
                  : []),
              ],
            }),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "t1", input: { query: "x" } })]),
            Message.tool(ToolResultPart.make({ id: "call_1", name: "t1", result: { ok: true } })),
          ],
        })

      const withReminder = yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(continuation(true))
      const withoutReminder = yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(continuation(false))
      const withBody = withReminder.body
      const withoutBody = withoutReminder.body

      expect(withBody.messages[0]?.content).toMatchObject([
        { text: "persisted user" },
        { cachePoint: { type: "default" } },
        { text: "[todo reminder] ephemeral" },
      ])
      expect(withBody.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect([withBody.system, withBody.messages[0]?.content.slice(0, 2)]).toEqual([
        withoutBody.system,
        withoutBody.messages[0]?.content.slice(0, 2),
      ])
    }),
  )

  it.effect("preserves tool-call order with an ephemeral part on OpenAI and Gemini", () =>
    Effect.gen(function* () {
      for (const model of [openaiModel, geminiModel]) {
        const prepared = yield* LLMClient.prepare<OpenAIOrGeminiBody>(
          LLM.request({
            model,
            cache: "auto",
            messages: [
              Message.make({
                role: "user",
                content: [
                  Message.text("persisted user"),
                  { type: "text", text: "[todo reminder] ephemeral", metadata: { cache: "none" } },
                ],
              }),
              Message.assistant([ToolCallPart.make({ id: "call_1", name: "t1", input: { query: "x" } })]),
              Message.tool(ToolResultPart.make({ id: "call_1", name: "t1", result: { ok: true } })),
            ],
          }),
        )
        const body = prepared.body
        const flat = JSON.stringify(body)
        expect(flat).toContain("persisted user")
        expect(flat).toContain("[todo reminder] ephemeral")
        expect(flat).not.toContain("cache_control")
        if (model === openaiModel) {
          expect(body.messages?.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
          expect(body.messages?.[1]?.tool_calls?.[0]?.id).toBe("call_1")
        } else {
          expect(body.contents?.map((message) => message.role)).toEqual(["user", "model", "user"])
          expect(flat).toContain("functionCall")
          expect(flat).toContain("functionResponse")
        }
      }
    }),
  )

  test("returns the same request reference when policy is a no-op (pure function)", () => {
    const request = LLM.request({
      model: anthropicModel,
      prompt: "hi",
      cache: "none",
    })
    expect(applyCachePolicy(request)).toBe(request)
  })
})
