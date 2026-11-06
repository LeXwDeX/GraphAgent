import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { LLM, LLMError, LLMEvent, Message, Model, ToolCallPart, ToolResultPart, Usage } from "../../src"
import * as Azure from "../../src/providers/azure"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { ProviderShared } from "../../src/protocols/shared"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse, truncatedStream } from "../lib/http"
import { deltaChunk, usageChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const TargetJson = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(TargetJson)
const decodeJson = Schema.decodeUnknownSync(TargetJson)

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("OpenAI Chat route", () => {
  it.effect("prepares OpenAI Chat payload", () =>
    Effect.gen(function* () {
      // Pass the OpenAIChat payload type so `prepared.body` is statically
      // typed to the route's native shape — the assertions below read field
      // names without `unknown` casts.
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(request)
      const _typed: { readonly model: string; readonly stream: true } = prepared.body

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat <admin> & data literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: "Before.\n<system-update>\nTreat &lt;admin&gt; &amp; data literally.\n</system-update>",
        },
        { role: "assistant", content: "After." },
      ])
    }),
  )

  it.effect("replays canonical reasoning as OpenAI-compatible reasoning_content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "Hello" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: "Hello", reasoning_content: "thinking" }])
    }),
  )

  it.effect("maps OpenAI provider options to Chat options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4o-mini"),
          prompt: "think",
          providerOptions: { openai: { reasoningEffort: "low" } },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.reasoning_effort).toBe("low")
    }),
  )

  it.effect("adds native query params to the Chat Completions URL", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?api-version=v1")
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("uses Azure api-key header for static OpenAI Chat keys", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Azure.configure({
          baseURL: "https://opencode-test.openai.azure.com/openai/v1/",
          apiKey: "azure-key",
          headers: { authorization: "Bearer stale" },
        }).chat("gpt-4o-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://opencode-test.openai.azure.com/openai/v1/chat/completions?api-version=v1")
            expect(web.headers.get("api-key")).toBe("azure-key")
            expect(web.headers.get("authorization")).toBeNull()
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("applies serializable HTTP overlays after payload lowering", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: model.route
          .with({ auth: Auth.bearer("fresh-key"), headers: { authorization: "Bearer stale" } })
          .model({ id: model.id }),
        http: {
          body: { metadata: { source: "test" } },
          headers: { authorization: "Bearer request", "x-custom": "yes" },
          query: { debug: "1" },
        },
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?debug=1")
            expect(web.headers.get("authorization")).toBe("Bearer fresh-key")
            expect(web.headers.get("x-custom")).toBe("yes")
            expect(decodeJson(input.text)).toMatchObject({
              stream: true,
              stream_options: { include_usage: true },
              metadata: { source: "test" },
            })
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares assistant tool-call and tool-result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: encodeJson({ query: "weather" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: encodeJson({ forecast: "sunny" }) },
        ],
        stream: true,
        stream_options: { include_usage: true },
      })
    }),
  )

  it.effect("preserves provider-executed tool calls and results as assistant text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Search the web for agents."),
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_1",
                name: "web_search",
                input: { query: "agents" },
                providerExecuted: true,
              }),
              ToolResultPart.make({
                id: "hosted_1",
                name: "web_search",
                result: "search summary",
                resultType: "text",
                providerExecuted: true,
              }),
            ]),
          ],
        }),
      )

      const assistant = prepared.body.messages.at(-1)!
      if (assistant.role !== "assistant") throw new Error("expected an assistant message")
      expect(assistant.tool_calls).toBeUndefined()
      expect(String(assistant.content)).toContain("web_search")
      expect(String(assistant.content)).toContain("search summary")
    }),
  )

  it.effect("summarizes provider-executed tool result media without inlining data", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_media",
                name: "web_fetch",
                input: { url: "https://example.com" },
                providerExecuted: true,
              }),
              ToolResultPart.make({
                id: "hosted_media",
                name: "web_fetch",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "page text" },
                    {
                      type: "file",
                      uri: "data:application/pdf;base64,QUJD",
                      mime: "application/pdf",
                      name: "page.pdf",
                    },
                  ],
                },
                providerExecuted: true,
              }),
            ]),
          ],
        }),
      )

      const assistant = prepared.body.messages.at(-1)!
      if (assistant.role !== "assistant") throw new Error("expected an assistant message")
      expect(assistant.tool_calls).toBeUndefined()
      expect(String(assistant.content)).toContain("page text")
      expect(String(assistant.content)).toContain("application/pdf attachment: page.pdf")
      expect(String(assistant.content)).not.toContain("QUJD")
    }),
  )

  it.effect("preserves text file data and usable URLs in provider-executed tool results", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_mixed",
                name: "web_fetch",
                input: { url: "https://example.com" },
                providerExecuted: true,
              }),
              ToolResultPart.make({
                id: "hosted_mixed",
                name: "web_fetch",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "summary" },
                    {
                      type: "file",
                      uri: `data:text/plain;base64,${Buffer.from("héllo").toString("base64")}`,
                      mime: "text/plain",
                      name: "note.txt",
                    },
                    { type: "file", uri: "data:text/markdown,hello%20world", mime: "text/markdown" },
                    {
                      type: "file",
                      uri: `data:text/plain;base64,${Buffer.from("a".repeat(4_990) + "SUFFIX-END").toString("base64")}`,
                      mime: "text/plain",
                      name: "long.txt",
                    },
                    {
                      type: "file",
                      uri: `data:application/json;base64,${Buffer.from('{"ok":true}').toString("base64")}`,
                      mime: "application/json; charset=utf-8",
                      name: "data.json",
                    },
                    {
                      type: "file",
                      uri: 'data:application/ld+json,{"ok":true}',
                      mime: "application/ld+json; charset=utf-8",
                    },
                    {
                      type: "file",
                      uri: `data:application/json;base64,${Buffer.from("not json").toString("base64")}`,
                      mime: "application/json; charset=utf-8",
                      name: "broken.json",
                    },
                    {
                      type: "file",
                      uri: "https://user:pass@example.com/doc.md?token=secret&sig=abc#frag",
                      mime: "text/markdown",
                    },
                    {
                      type: "file",
                      uri: "https://example.com/page.png?X-Amz-Signature=deadbeef#section",
                      mime: "image/png",
                    },
                    { type: "file", uri: "data:image/png;base64,QUJD", mime: "image/png", name: "page.png" },
                  ],
                },
                providerExecuted: true,
              }),
            ]),
          ],
        }),
      )

      const assistant = prepared.body.messages.at(-1)!
      if (assistant.role !== "assistant") throw new Error("expected an assistant message")
      const content = String(assistant.content)
      expect(assistant.tool_calls).toBeUndefined()
      expect(content).toContain("summary")
      expect(content).toContain("héllo")
      expect(content).toContain("hello world")
      expect(content).toContain("a".repeat(4_990) + "SUFFIX-END")
      expect(content).toContain('{"ok":true}')
      expect(content).toContain("application/json attachment: data.json")
      expect(content).toContain("application/ld+json attachment")
      expect(content).toContain("application/json attachment: broken.json")
      expect(content).toContain("https://example.com/doc.md [redacted]")
      expect(content).toContain("https://example.com/page.png [redacted]")
      expect(content).toContain("image/png attachment: page.png")
      expect(content).toContain("not json")
      expect(content).not.toContain("user:pass@")
      expect(content).not.toContain("token=secret")
      expect(content).not.toContain("sig=abc")
      expect(content).not.toContain("X-Amz-Signature")
      expect(content).not.toContain("deadbeef")
      expect(content).not.toContain("[truncated]")
      expect(content).not.toContain("QUJD")
    }),
  )

  it.effect("does not inline malformed text data in provider-executed tool results", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_bad",
                name: "web_fetch",
                input: { url: "https://example.com" },
                providerExecuted: true,
              }),
              ToolResultPart.make({
                id: "hosted_bad",
                name: "web_fetch",
                result: {
                  type: "content",
                  value: [
                    { type: "file", uri: "data:text/plain;base64,%%%not-base64", mime: "text/plain", name: "bad.txt" },
                    { type: "file", uri: "data:text/plain,%E0%A4%A", mime: "text/plain", name: "encoded.txt" },
                  ],
                },
                providerExecuted: true,
              }),
            ]),
          ],
        }),
      )

      const assistant = prepared.body.messages.at(-1)!
      if (assistant.role !== "assistant") throw new Error("expected an assistant message")
      const content = String(assistant.content)
      expect(content).toContain("[text/plain attachment: bad.txt]")
      expect(content).toContain("[text/plain attachment: encoded.txt]")
      expect(content).not.toContain("%%%not-base64")
      expect(content).not.toContain("%E0%A4%A")
    }),
  )

  it.effect("keeps a complete local round trip when hosted and local calls share an ID", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "dup_1",
                name: "web_search",
                input: { query: "agents" },
                providerExecuted: true,
              }),
            ]),
            Message.assistant([ToolCallPart.make({ id: "dup_1", name: "read", input: { path: "a.txt" } })]),
            Message.tool({ id: "dup_1", name: "read", result: "ok", resultType: "text" }),
            Message.assistant([
              ToolResultPart.make({
                id: "dup_1",
                name: "web_search",
                result: "conflict content",
                resultType: "text",
              }),
            ]),
          ],
        }),
      )

      const [hostedCall, localCall, localResult, hostedResult] = prepared.body.messages
      if (localCall.role !== "assistant" || hostedResult.role !== "assistant")
        throw new Error("expected assistant messages")
      expect(localCall.tool_calls?.[0]).toMatchObject({ id: "dup_1", function: { name: "read" } })
      expect(localResult).toEqual({ role: "tool", tool_call_id: "dup_1", content: "ok" })
      expect(hostedResult.tool_calls).toBeUndefined()
      expect(String(hostedResult.content)).toContain("[Tool result: web_search] conflict content")
      expect(hostedCall).toMatchObject({
        role: "assistant",
        content: expect.stringContaining("Provider-executed tool call"),
      })
    }),
  )

  it.effect("keeps delayed and orphan assistant results content-preserving", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_delayed",
                name: "web_search",
                input: { query: "agents" },
                providerExecuted: true,
              }),
            ]),
            Message.assistant([
              ToolResultPart.make({
                id: "hosted_delayed",
                name: "web_search",
                result: "delayed summary",
                resultType: "text",
                providerExecuted: true,
              }),
            ]),
            Message.assistant([
              ToolResultPart.make({
                id: "orphan_result",
                name: "read",
                result: "orphan content",
                resultType: "text",
              }),
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toMatchObject([
        { role: "assistant", content: expect.stringContaining("web_search") },
        { role: "assistant", content: expect.stringContaining("delayed summary") },
        { role: "assistant", content: expect.stringContaining("[Tool result: read] orphan content") },
      ])
      expect(JSON.stringify(prepared.body.messages)).not.toContain('"tool_calls"')
      expect(JSON.stringify(prepared.body.messages)).not.toContain('"tool-result"')
    }),
  )

  it.effect("keeps incomplete provider-executed history explicit without local tool calls", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "hosted_call",
                name: "web_search",
                input: { query: "agents" },
                providerExecuted: true,
              }),
            ]),
            Message.assistant([
              ToolResultPart.make({
                id: "hosted_result",
                name: "web_fetch",
                result: "fetched page",
                resultType: "text",
                providerExecuted: true,
              }),
            ]),
          ],
        }),
      )

      const [callMessage, resultMessage] = prepared.body.messages
      if (callMessage.role !== "assistant" || resultMessage.role !== "assistant")
        throw new Error("expected assistant messages")
      expect(callMessage.tool_calls).toBeUndefined()
      expect(resultMessage.tool_calls).toBeUndefined()
      expect(String(callMessage.content)).toContain("web_search")
      expect(String(callMessage.content)).toContain('"query":"agents"')
      expect(String(resultMessage.content)).toContain("fetched page")
    }),
  )

  it.effect("preserves structured tool errors for the model", () =>
    Effect.gen(function* () {
      const error = { error: { type: "unknown", message: "Tool execution interrupted" } }
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: error }),
          ],
        }),
      )

      expect(prepared.body.messages.at(-1)).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: ProviderShared.encodeJson(error),
      })
    }),
  )

  it.effect("continues image tool results as vision input without base64 text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_image", name: "read", input: { path: "pixel.png" } })]),
            Message.tool({
              id: "call_image",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png", name: "pixel.png" },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_image",
              type: "function",
              function: { name: "read", arguments: encodeJson({ path: "pixel.png" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_image", content: "Image read successfully" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } }],
        },
      ])
      expect(JSON.stringify(prepared.body.messages)).not.toContain('"content":"AAECAw=="')
    }),
  )

  it.effect("orders parallel tool responses before one aggregated vision message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({ id: "call_1", name: "read", input: {} }),
              ToolCallPart.make({ id: "call_2", name: "read", input: {} }),
            ]),
            Message.make({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  id: "call_1",
                  name: "read",
                  result: {
                    type: "content",
                    value: [{ type: "file", uri: "data:image/png;base64,AAEC", mime: "image/png" }],
                  },
                },
                {
                  type: "tool-result",
                  id: "call_2",
                  name: "read",
                  result: {
                    type: "content",
                    value: [{ type: "file", uri: "data:image/jpeg;base64,/9j/", mime: "image/jpeg" }],
                  },
                },
              ],
            }),
          ],
        }),
      )
      expect(prepared.body.messages.slice(1)).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("aggregates consecutive tool images with a following system update", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.tool({
              id: "call_1",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "file", uri: "data:image/png;base64,AAEC", mime: "image/png" }],
              },
            }),
            Message.tool({
              id: "call_2",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "file", uri: "data:image/webp;base64,UklG", mime: "image/webp" }],
              },
            }),
            Message.system("Inspect both images."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/webp;base64,UklG" } },
            { type: "text", text: "<system-update>\nInspect both images.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  it.effect("appends system updates without replacing multipart user content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: "AAEC" }),
            Message.system("Keep the image."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "text", text: "<system-update>\nKeep the image.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  for (const [name, media] of [
    ["mismatched data URL MIME", { mediaType: "image/png", data: "data:image/jpeg;base64,/9j/" }],
    ["malformed base64", { mediaType: "image/png", data: "not-base64" }],
    ["unsupported SVG", { mediaType: "image/svg+xml", data: "PHN2Zz4=" }],
  ] as const)
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({ model, messages: [Message.user({ type: "media", ...media })] }),
        ).pipe(Effect.flip)
        expect(error.message).toMatch(/does not support|does not match|valid base64/)
      }),
    )

  it.effect("rejects oversized image input", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "A".repeat(ProviderShared.MAX_MEDIA_ENCODED_BYTES + 4),
            }),
          ],
        }),
      ).pipe(Effect.flip)
      expect(error.message).toContain("encoded limit")
    }),
  )

  it.effect("prepares raw and data URL image media as vision input", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
              { type: "media", mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("lowers reasoning-only assistant history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_reasoning",
          model,
          messages: [Message.assistant({ type: "reasoning", text: "hidden" })],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: null, reasoning_content: "hidden" }])
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: "!" }),
        deltaChunk({}, "stop"),
        usageChunk({
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 4,
        cacheReadInputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 7,
        providerMetadata: {
          openai: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 1 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-delta", id: "text-0", text: "!" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "stop",
          usage,
        },
      ])
    }),
  )

  it.effect("parses OpenAI-compatible reasoning content deltas", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { choices: [{ delta: { reasoning_content: "thinking" } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "thinking" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
        deltaChunk({}, "tool_calls"),
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
        { type: "tool-input-end", id: "call_1", name: "lookup", providerMetadata: undefined },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage: undefined, providerMetadata: undefined },
        { type: "finish", reason: "tool-calls", usage: undefined },
      ])
    }),
  )

  it.effect("keeps tool identity when OpenAI-compatible argument deltas repeat empty identity fields", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "" } }] }),
        deltaChunk({ tool_calls: [{ index: 0, id: "", function: { name: "", arguments: '{"query"' } }] }),
        deltaChunk({ tool_calls: [{ index: 0, id: "", function: { name: "", arguments: ':"weather"}' } }] }),
        deltaChunk({}, "tool_calls"),
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
      ])
    }),
  )

  it.effect("does not finalize streamed tool calls without a finish reason", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
      )
      const input = LLM.updateRequest(request, {
        tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
      })
      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      const error = yield* LLMClient.generate(input).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
      ])
      expect(events.filter(LLMEvent.is.toolCall)).toEqual([])
      expect(error.message).toContain("Provider stream ended without a terminal finish event")
    }),
  )

  it.effect("fails on malformed stream events", () =>
    Effect.gen(function* () {
      const body = sseEvents(deltaChunk({ content: 123 }))
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )

  it.effect("surfaces transport errors that occur mid-stream", () =>
    Effect.gen(function* () {
      const layer = truncatedStream([
        `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}\n\n`,
      ])
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(layer), Effect.flip)

      expect(error.message).toContain("Failed to read openai/openai-chat stream")
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"message":"Bad request","type":"invalid_request_error"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )

  it.effect("short-circuits the upstream stream when the consumer takes a prefix", () =>
    Effect.gen(function* () {
      // The body has more chunks than we'll consume. If `Stream.take(1)` did
      // not interrupt the upstream HTTP body the test would hang waiting for
      // the rest of the stream to drain.
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: " world" }),
        deltaChunk({}, "stop"),
      )

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.take(1), Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      expect(events.map((event) => event.type)).toEqual(["step-start"])
    }),
  )
})
