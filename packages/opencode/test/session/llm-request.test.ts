import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { RUNTIME_CAPABILITIES } from "@opencode-ai/core/system-context/capabilities"
import { DEFAULT_WRITING_STYLE } from "@opencode-ai/core/system-context/writing-style"
import { SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { prepare } from "../../src/session/llm/request"
import { testEffect } from "../lib/effect"
import { jsonSchema, tool } from "ai"
import { Permission } from "@/permission"

const it = testEffect(
  Layer.mergeAll(
    RuntimeFlags.layer(),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  ),
)

const itOutputOverride = testEffect(
  Layer.mergeAll(
    RuntimeFlags.layer({ outputTokenMax: 64_000 }),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  ),
)

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
      plugin: yield* Plugin.Service,
      flags: yield* RuntimeFlags.Service,
      isWorkflow: false,
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
  for (const [provider, model, npm] of [
    ["anthropic", "claude-sonnet-4", "@ai-sdk/anthropic"],
    ["openai", "gpt-5", "@ai-sdk/openai"],
    ["google", "gemini-2.5-pro", "@ai-sdk/google"],
    ["deepseek", "deepseek-chat", "@ai-sdk/openai-compatible"],
    ["zhipuai", "glm-4.7", "@ai-sdk/openai-compatible"],
    ["alibaba", "qwen3-coder", "@ai-sdk/alibaba"],
  ]) {
    it.instance(`${provider} receives product knowledge with no configured hooks or tools`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare(yield* request(provider, model, npm))
        expect(prepared.system.join("\n")).toContain(RUNTIME_CAPABILITIES)
        expect(prepared.system.join("\n").split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
        expect(prepared.messages[0]).toEqual({ role: "system", content: prepared.system[0] })
        expect(prepared.tools).toEqual({})
      }),
    )
  }

  it.instance("custom agent prompts keep capability knowledge and dynamic session context", () =>
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
      expect(system).toContain(RUNTIME_CAPABILITIES)
      expect(system.split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
      expect(system).toContain("## Active Hooks")
      expect(system).toContain("User instructions.")
      expect(system.indexOf(DEFAULT_WRITING_STYLE)).toBeLessThan(system.indexOf("User instructions."))
      expect(system.split("## GraphAgent / OpenCode capabilities")).toHaveLength(2)
    }),
  )

  it.instance("child sessions keep the writing style but omit product knowledge", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({ ...(yield* request()), parentSessionID: "ses_parent" })
      const system = prepared.system.join("\n")
      expect(system).not.toContain("## GraphAgent / OpenCode capabilities")
      expect(system.split(DEFAULT_WRITING_STYLE)).toHaveLength(2)
    }),
  )

  it.instance("OpenAI OAuth carries capabilities through instructions", () =>
    Effect.gen(function* () {
      const input = yield* request("openai", "gpt-5", "@ai-sdk/openai")
      const prepared = yield* prepare({
        ...input,
        auth: { type: "oauth", access: "synthetic", refresh: "synthetic", expires: 0 },
      })
      expect(prepared.params.options.instructions).toContain(RUNTIME_CAPABILITIES)
      expect(prepared.params.options.instructions).toContain(DEFAULT_WRITING_STYLE)
      expect(prepared.messages).toEqual(input.messages)
    }),
  )

  it.instance("workflow requests retain capabilities in their separate system field", () =>
    Effect.gen(function* () {
      const input = yield* request()
      const prepared = yield* prepare({ ...input, isWorkflow: true })
      expect(prepared.system.join("\n")).toContain(RUNTIME_CAPABILITIES)
      expect(prepared.system.join("\n")).toContain(DEFAULT_WRITING_STYLE)
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

  it.instance("small helper requests omit the product catalog", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({ ...(yield* request()), small: true })
      expect(prepared.system.join("\n")).not.toContain(RUNTIME_CAPABILITIES)
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
