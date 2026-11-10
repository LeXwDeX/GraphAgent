// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { DEFAULT_WRITING_STYLE } from "@graphagent/core/system-context/writing-style"
import { SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Provider } from "../../src/provider/provider"
import { isInternalOneShot } from "../../src/session/llm/internal-one-shot"
import { prepare } from "../../src/session/llm/request"
import type { ProviderAdapters } from "../../src/provider/adapter/registry"
import type { ChatInput, ChatParams } from "../../src/provider/adapter/types"
import { testEffect } from "../lib/effect"
import { jsonSchema, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Permission } from "@/permission"

const PROMPT_IDENTITY = "You are graphagent, a coding agent working in the user's workspace."
const REMOVED_CATALOG = "## GraphAgent / OpenCode capabilities"

const it = testEffect(Layer.mergeAll(RuntimeFlags.layer()))

const itOutputOverride = testEffect(Layer.mergeAll(RuntimeFlags.layer({ outputTokenMax: 64_000 })))

function fixture(providerName: string, modelName: string, npm: string) {
  const providerID = ProviderV2.ID.make(providerName)
  const model: Provider.Model = {
    id: ModelV2.ID.make(modelName),
    providerID,
    api: { id: modelName, url: "https://example.invalid/v1", npm },
    name: modelName,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  return {
    model,
    provider: {
      id: providerID,
      name: providerName,
      source: "config",
      env: [],
      options: {},
      models: {},
    } satisfies Provider.Info,
  }
}

const request = (providerName = "deepseek", modelName = "deepseek-chat", npm = "@ai-sdk/openai-compatible") =>
  Effect.gen(function* () {
    const { model, provider } = fixture(providerName, modelName, npm)
    return {
      model,
      provider,
      cfg: {},
      user: {
        id: SessionV1.MessageID.make("msg_test"),
        sessionID: SessionID.make("ses_test"),
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      },
      sessionID: "ses_test",
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      system: [],
      messages: [{ role: "user" as const, content: "Does this runtime support hooks?" }],
      tools: {},
      auth: undefined,
      flags: yield* RuntimeFlags.Service,
    } satisfies Parameters<typeof prepare>[0]
  })

describe("runtime capabilities in model requests", () => {
  for (const disabled of ["permission", "user", "none", "empty"] as const)
    it.instance(`editing prompt uses the final tool set (${disabled})`, () =>
      Effect.gen(function* () {
        const input = yield* request("openai", "gpt-5", "@ai-sdk/openai")
        const prepared = yield* prepare({
          ...input,
          tools:
            disabled === "empty"
              ? {}
              : {
                  apply_patch: tool({
                    description: "Apply a patch",
                    inputSchema: jsonSchema({ type: "object", properties: {} }),
                  }),
                },
          permission: disabled === "permission" ? Permission.fromConfig({ edit: "deny" }) : [],
          user: { ...input.user, ...(disabled === "user" ? { tools: { apply_patch: false } } : {}) },
        })
        expect(Object.keys(prepared.tools)).toEqual(disabled === "none" ? ["apply_patch"] : [])
        const system = prepared.system.join("\n")
        expect(system.includes("Use apply_patch for manual file edits")).toBe(disabled === "none")
        expect(system.includes("No file-editing tool is available")).toBe(disabled !== "none")
      }),
    )
  it.instance("native role denies stay ahead of user allows in advertised tools", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const toolDef = (description: string) =>
        tool({ description, inputSchema: jsonSchema({ type: "object", properties: {} }) })
      const prepared = yield* prepare({
        ...input,
        tools: { edit: toolDef("edit"), read: toolDef("read") },
        agent: {
          ...input.agent,
          permission: Permission.fromConfig({ "*": "allow", edit: "allow" }),
        },
        nativePermission: Permission.fromConfig({ "*": "deny", read: "allow" }),
      })
      expect(Object.keys(prepared.tools)).toEqual(["read"])
    }),
  )
  for (const [provider, model, npm] of [
    ["anthropic", "claude-sonnet-4", "@ai-sdk/anthropic"],
    ["openai", "gpt-5", "@ai-sdk/openai"],
    ["google", "gemini-2.5-pro", "@ai-sdk/google"],
    ["deepseek", "deepseek-chat", "@ai-sdk/openai-compatible"],
    ["zhipuai", "glm-4.7", "@ai-sdk/openai-compatible"],
    ["alibaba", "qwen3-coder", "@ai-sdk/alibaba"],
  ]) {
    it.instance(`${provider} receives the unified prompt with no configured hooks or tools`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare(yield* request(provider, model, npm))
        expect(prepared.system.join("\n")).toContain(PROMPT_IDENTITY)
        expect(prepared.system.join("\n")).not.toContain(REMOVED_CATALOG)
        expect(prepared.system.join("\n").split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
        expect(prepared.messages[0]).toEqual({ role: "system", content: prepared.system[0] })
        expect(prepared.tools).toEqual({})
      }),
    )
  }

  it.instance("custom agent prompts keep the writing style and dynamic session context", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        agent: { ...input.agent, prompt: "Custom agent instructions." },
        system: ["## Active Hooks\n- Stop [project/command] echo done"],
        user: { ...input.user, system: "User instructions." },
      })
      const system = prepared.system.join("\n")
      expect(system).toStartWith("Custom agent instructions.")
      expect(system).not.toContain(REMOVED_CATALOG)
      expect(system.split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
      expect(system).toContain("## Active Hooks")
      expect(system).toContain("User instructions.")
      expect(system.indexOf(DEFAULT_WRITING_STYLE)).toBeLessThan(system.indexOf("User instructions."))
    }),
  )

  it.instance("child sessions keep the shared prompt and writing style without the removed catalog", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({ ...(yield* request()), parentSessionID: "ses_parent" })
      const system = prepared.system.join("\n")
      expect(system).toContain(PROMPT_IDENTITY)
      expect(system).not.toContain(REMOVED_CATALOG)
      expect(system.split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
    }),
  )

  it.instance("OpenAI OAuth carries the unified prompt through instructions", () =>
    Effect.gen(function* () {
      const input = yield* request("openai", "gpt-5", "@ai-sdk/openai")
      const prepared = yield* prepare({
        ...input,
        auth: { type: "oauth", access: "synthetic", refresh: "synthetic", expires: 0 },
      })
      expect(prepared.params.options.instructions).toContain(PROMPT_IDENTITY)
      expect(prepared.params.options.instructions).not.toContain(REMOVED_CATALOG)
      expect(prepared.params.options.instructions).toContain(DEFAULT_WRITING_STYLE)
      expect(prepared.messages).toEqual(input.messages)
    }),
  )

  it.instance("honors an explicitly configured output limit above 32k", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        model: { ...input.model, limit: { context: 128_000, output: 384_000 } },
        cfg: {
          provider: { deepseek: { models: { "deepseek-chat": { limit: { context: 128_000, output: 384_000 } } } } },
        },
      })
      expect(prepared.params.maxOutputTokens).toBe(384_000)
    }),
  )

  it.instance("keeps the conservative default when the limit only comes from the catalog", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        model: { ...input.model, limit: { context: 1_000_000, output: 384_000 } },
      })
      expect(prepared.params.maxOutputTokens).toBe(32_000)
    }),
  )

  it.instance("small helper requests omit the removed product catalog", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({ ...(yield* request()), small: true })
      expect(prepared.system.join("\n")).not.toContain(REMOVED_CATALOG)
      expect(prepared.system.join("\n")).toContain(DEFAULT_WRITING_STYLE)
    }),
  )
})

describe("output token override", () => {
  itOutputOverride.instance("an override above the conservative default applies to a catalog-only limit", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        model: { ...input.model, limit: { context: 128_000, output: 128_000 } },
      })
      expect(prepared.params.maxOutputTokens).toBe(64_000)
    }),
  )

  itOutputOverride.instance("keeps a catalog cap below the override", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        model: { ...input.model, limit: { context: 128_000, output: 8_192 } },
      })
      expect(prepared.params.maxOutputTokens).toBe(8_192)
    }),
  )

  itOutputOverride.instance("caps an explicitly configured limit with the override", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        model: { ...input.model, limit: { context: 128_000, output: 384_000 } },
        cfg: {
          provider: { deepseek: { models: { "deepseek-chat": { limit: { context: 128_000, output: 384_000 } } } } },
        },
      })
      expect(prepared.params.maxOutputTokens).toBe(64_000)
    }),
  )
})

const adapter = (chatParams: (input: ChatInput, output: ChatParams) => Effect.Effect<ChatParams>) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub implements only the hooks prepare calls.
  ({
    chatParams,
    chatHeaders: (_input: ChatInput, output: { headers: Record<string, string> }) => Effect.succeed(output.headers),
  }) as unknown as ProviderAdapters.Interface

describe("request output cap after the adapter hook", () => {
  it.instance("applies the cap as a minimum even when an adapter raises the limit", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        maxOutputTokens: 2_000,
        adapters: adapter((_hookInput, output) => Effect.succeed({ ...output, maxOutputTokens: 9_000 })),
      })
      expect(prepared.params.maxOutputTokens).toBe(2_000)
    }),
  )

  it.instance("uses the cap when an adapter clears the limit", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        maxOutputTokens: 2_000,
        adapters: adapter((_hookInput, output) => Effect.succeed({ ...output, maxOutputTokens: undefined })),
      })
      expect(prepared.params.maxOutputTokens).toBe(2_000)
    }),
  )

  it.instance("keeps an adapter limit below the cap", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        maxOutputTokens: 2_000,
        adapters: adapter((_hookInput, output) => Effect.succeed({ ...output, maxOutputTokens: 1_000 })),
      })
      expect(prepared.params.maxOutputTokens).toBe(1_000)
    }),
  )

  it.instance("does not touch the adapter limit when no cap is requested", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({
        ...input,
        adapters: adapter((_hookInput, output) => Effect.succeed({ ...output, maxOutputTokens: 9_000 })),
      })
      expect(prepared.params.maxOutputTokens).toBe(9_000)
    }),
  )
})

describe("internal one-shot agents", () => {
  it.instance("routes title and btw requests away from conversation transports", () =>
    Effect.sync(() => {
      expect(isInternalOneShot("title")).toBe(true)
      expect(isInternalOneShot("btw")).toBe(true)
      expect(isInternalOneShot("build")).toBe(false)
      expect(isInternalOneShot("plan")).toBe(false)
    }),
  )
})

describe("hosted history projection before SDK prompt conversion", () => {
  it.effect("projects expired hosted file URLs before AI SDK downloads them", () =>
    Effect.gen(function* () {
      const input = yield* request("local", "qwen3", "@ai-sdk/openai-compatible")
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "Fetch the page." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "hosted_1",
              toolName: "web_fetch",
              input: { url: "https://expired.invalid/secret" },
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "hosted_1",
              toolName: "web_fetch",
              output: {
                type: "content",
                value: [
                  {
                    type: "file-url",
                    mediaType: "text/plain",
                    url: "https://expired.invalid/secret?token=abc#frag",
                  },
                ],
              },
            },
          ],
        },
      ]

      const prepared = yield* prepare({ ...input, messages })
      expect(JSON.stringify(prepared.messages)).not.toContain('"file-url"')
      expect(JSON.stringify(prepared.messages)).toContain("https://expired.invalid/secret [redacted]")

      const requested: string[] = []
      const provider = createOpenAICompatible({
        name: "local",
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        fetch: Object.assign(
          async (request: RequestInfo | URL) => {
            requested.push(request instanceof Request ? request.url : String(request))
            return new Response(
              [
                `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "qwen3", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
                `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "qwen3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
                "data: [DONE]",
              ].join("\n\n") + "\n\n",
              { headers: { "Content-Type": "text/event-stream" } },
            )
          },
          { preconnect: () => undefined },
        ),
      })
      const observed: unknown[] = []
      const model = wrapLanguageModel({
        model: provider("qwen3"),
        middleware: {
          specificationVersion: "v3" as const,
          async transformParams({ params }) {
            observed.push(params.prompt)
            return params
          },
        },
      })

      const originalFetch = globalThis.fetch
      const downloaded: string[] = []
      globalThis.fetch = Object.assign(
        async (source: RequestInfo | URL) => {
          downloaded.push(source instanceof Request ? source.url : String(source))
          throw new Error("network disabled")
        },
        { preconnect: () => undefined },
      )
      try {
        const result = streamText({ model, messages: prepared.messages, maxRetries: 0 })
        yield* Effect.promise(() => result.consumeStream())
      } finally {
        globalThis.fetch = originalFetch
      }

      expect(downloaded).toEqual([])
      expect(requested).toEqual(["https://example.invalid/v1/chat/completions"])
      expect(JSON.stringify(observed)).toContain("expired.invalid/secret")
      expect(JSON.stringify(observed)).not.toContain('"type":"file"')
    }),
  )
})
