import { afterEach, expect, test } from "bun:test"
import { unlink } from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ModelsDev } from "@graphagent/core/models-dev"
import { contextWindow } from "@graphagent/core/model-profile"
import { logLines } from "effect/testing/TestConsole"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { FSUtil } from "@graphagent/core/fs-util"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Global } from "@graphagent/core/global"
import {
  provideInstanceEffect,
  reloadInstance,
  TestInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { Env } from "../../src/env"
import { Provider } from "@/provider/provider"
import { ProviderAdapters } from "@/provider/adapter/registry"
import type { ProviderAdapter } from "@/provider/adapter/types"
import { ProviderProfile } from "@/provider/profile"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { Filesystem } from "@/util/filesystem"
import { InstanceLayer } from "@/project/instance-layer"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const setProcessEnv = (k: string, v: string) =>
  Effect.sync(() => {
    rememberEnv(k)
    process.env[k] = v
  })

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const remove = (k: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    delete process.env[k]
    yield* Env.use.remove(k)
  })

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
})

const providerLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(ProviderAdapters.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
    Layer.provide(EventV2Bridge.defaultLayer),
  )

const list = Provider.use.list()

const languageBaseURL = (language: unknown) => (language as { config: { baseURL: string } }).config.baseURL

const aggregatorExamplePath = path.join(import.meta.dir, "../../../../docs/examples/internal-llm-aggregator.jsonc")
const aggregatorExample = ConfigParse.schema(
  ConfigV1.Info,
  ConfigParse.jsonc(await Bun.file(aggregatorExamplePath).text(), aggregatorExamplePath),
  aggregatorExamplePath,
)

const emptyModelCatalogLayer = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    get: () => Effect.succeed({}),
    refresh: () => Effect.die(new Error("models.dev refresh must not be called by the aggregator contract")),
  }),
)

const aggregatorProviderLayer = Provider.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(ProviderAdapters.defaultLayer),
  Layer.provide(emptyModelCatalogLayer),
  Layer.provide(RuntimeFlags.layer({})),
  Layer.provide(EventV2Bridge.defaultLayer),
)
const aggregator = testEffect(
  Layer.mergeAll(aggregatorProviderLayer, Env.defaultLayer, ProviderAdapters.defaultLayer, emptyModelCatalogLayer),
)

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, ProviderAdapters.defaultLayer))
const experimentalModels = testEffect(providerLayer({ enableExperimentalModels: true }))

const alphaProviderConfig = {
  provider: {
    "custom-provider": {
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.custom.com/v1",
      models: {
        "active-model": {
          name: "Active Model",
        },
        "alpha-model": {
          name: "Alpha Model",
          status: "alpha" as const,
        },
      },
      options: {
        apiKey: "custom-key",
      },
    },
  },
}

it.instance("provider loaded from env variable", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // Provider should retain its connection source even if custom loaders
    // merge additional options.
    expect(providers[ProviderV2.ID.anthropic].source).toBe("env")
    expect(providers[ProviderV2.ID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
  }),
)

it.instance(
  "provider loaded from config with apiKey option",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "config-api-key" } } } } },
)

it.instance(
  "disabled_providers excludes provider",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeUndefined()
  }),
  { config: { disabled_providers: ["anthropic"] } },
)

it.instance(
  "enabled_providers restricts to only listed providers",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    yield* setProcessEnv("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { enabled_providers: ["anthropic"] } },
)

it.instance(
  "model whitelist filters models for provider",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models.length).toBe(1)
  }),
  { config: { provider: { anthropic: { whitelist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "model blacklist excludes specific models",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).not.toContain("claude-sonnet-4-20250514")
  }),
  { config: { provider: { anthropic: { blacklist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "custom model alias via config",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].models["my-alias"]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].models["my-alias"].name).toBe("My Custom Alias")
  }),
  {
    config: {
      provider: {
        anthropic: { models: { "my-alias": { id: "claude-sonnet-4-20250514", name: "My Custom Alias" } } },
      },
    },
  },
)

it.instance(
  "custom provider with npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].name).toBe("Custom Provider")
    expect(providers[ProviderV2.ID.make("custom-provider")].models["custom-model"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: {
            "custom-model": {
              name: "Custom Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "filters alpha provider models by default",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeUndefined()
  }),
  { config: alphaProviderConfig },
)

experimentalModels.instance(
  "includes alpha provider models when experimental models are enabled",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeDefined()
  }),
  { config: alphaProviderConfig },
)

it.instance(
  "custom DeepSeek openai-compatible model defaults interleaved reasoning field",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("custom-provider")]
    expect(provider.models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(provider.models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
    expect(provider.models["custom-model"].capabilities.interleaved).toBe(false)
    expect(
      providers[ProviderV2.ID.make("custom-anthropic-provider")].models["deepseek-r1"].capabilities.interleaved,
    ).toBe(false)
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: {
            "deepseek-r1": { name: "DeepSeek R1" },
            "deepseek-details": { name: "DeepSeek Details", interleaved: { field: "reasoning_details" } },
            "custom-model": { name: "Custom Model" },
          },
          options: { apiKey: "custom-key" },
        },
        "custom-anthropic-provider": {
          name: "Custom Anthropic Provider",
          npm: "@ai-sdk/anthropic",
          api: "https://api.custom.com/v1",
          models: { "deepseek-r1": { name: "DeepSeek R1" } },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "configured interleaved false switches the DeepSeek default off, and true stays a plain flag",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("custom-provider")]
    expect(provider.models["deepseek-r1"].capabilities.interleaved).toBe(false)
    expect(provider.models["deepseek-flag"].capabilities.interleaved).toBe(true)
    // A model that names no interleaved keeps the default of its own id.
    expect(provider.models["deepseek-chat"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: {
            "deepseek-r1": { name: "DeepSeek R1", interleaved: false },
            "deepseek-flag": { name: "DeepSeek Flag", interleaved: true },
            "deepseek-chat": { name: "DeepSeek Chat" },
          },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "env variable takes precedence, config merges options",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "env-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // Config options should be merged
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBe(60000)
    expect(providers[ProviderV2.ID.anthropic].options.headerTimeout).toBe(10000)
    expect(providers[ProviderV2.ID.anthropic].options.chunkTimeout).toBe(15000)
  }),
  { config: { provider: { anthropic: { options: { timeout: 60000, headerTimeout: 10000, chunkTimeout: 15000 } } } } },
)

it.instance("getModel returns model for valid provider/model", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    expect(model).toBeDefined()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.id)).toBe("claude-sonnet-4-20250514")
    const language = yield* provider.getLanguage(model)
    expect(language).toBeDefined()
  }),
)

it.instance("getModel throws ModelNotFoundError for invalid model", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("nonexistent-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

it.instance("getModel throws ModelNotFoundError for invalid provider", () =>
  Effect.gen(function* () {
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.make("nonexistent-provider"), ModelV2.ID.make("some-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

// Pure synchronous unit tests — no Effect runtime needed.

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

it.instance("defaultModel returns first available model when no config set", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(model.providerID).toBeDefined()
    expect(model.modelID).toBeDefined()
  }),
)

it.instance(
  "defaultModel respects config model setting",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
  }),
  { config: { model: "anthropic/claude-sonnet-4-20250514" } },
)

it.instance(
  "defaultModel returns a typed error when config excludes every provider",
  Effect.gen(function* () {
    const error = yield* Provider.use.defaultModel().pipe(Effect.flip)
    expect(error).toBeInstanceOf(Provider.NoProvidersError)
    expect(error._tag).toBe("ProviderNoProvidersError")
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "provider with baseURL from config",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-openai")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-openai": {
          name: "Custom OpenAI",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "gpt-4": { name: "GPT-4", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.openai.com/v1" },
        },
      },
    },
  },
)

aggregator.instance(
  "internal aggregator example resolves three protocol SDKs without models.dev",
  Effect.gen(function* () {
    yield* set("LLM_AGGREGATOR_API_KEY", "internal-test-key")
    const provider = yield* Provider.Service
    const providers = yield* provider.list()
    const modelsDev = yield* ModelsDev.Service

    expect(yield* modelsDev.get()).toEqual({})

    yield* Effect.forEach(
      [
        {
          providerID: ProviderV2.ID.make("internal-openai"),
          modelID: ModelV2.ID.make("gpt-5"),
          npm: "@ai-sdk/openai",
          baseURL: "https://llm-api.example.com/openai/v1",
        },
        {
          providerID: ProviderV2.ID.make("internal-anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
          npm: "@ai-sdk/anthropic",
          baseURL: "https://llm-api.example.com/anthropic",
        },
        {
          providerID: ProviderV2.ID.make("internal-gemini"),
          modelID: ModelV2.ID.make("gemini-2.5-pro"),
          npm: "@ai-sdk/google",
          baseURL: "https://llm-api.example.com/gemini/v1beta",
        },
      ],
      (item) =>
        Effect.gen(function* () {
          expect(providers[item.providerID]).toBeDefined()
          expect(providers[item.providerID].key).toBe("internal-test-key")
          expect(providers[item.providerID].options.baseURL).toBe(item.baseURL)
          expect(providers[item.providerID].models[item.modelID].api.npm).toBe(item.npm)

          const model = yield* provider.getModel(item.providerID, item.modelID)
          expect(yield* provider.getLanguage(model)).toBeDefined()
        }),
    )
  }),
  { config: aggregatorExample },
)

it.instance(
  "model cost defaults to zero when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(0)
    expect(model.cost.output).toBe(0)
    expect(model.cost.cache.read).toBe(0)
    expect(model.cost.cache.write).toBe(0)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "model options are merged from existing model",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.options.customOption).toBe("custom-value")
  }),
  {
    config: {
      provider: {
        anthropic: {
          options: { apiKey: "test-api-key" },
          models: { "claude-sonnet-4-20250514": { options: { customOption: "custom-value" } } },
        },
      },
    },
  },
)

it.instance(
  "provider removed when all models filtered out",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeUndefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-api-key" }, whitelist: ["nonexistent-model"] } } } },
)

it.instance("closest finds model by partial match", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["sonnet-4"])
    expect(result).toBeDefined()
    expect(String(result?.providerID)).toBe("anthropic")
    expect(String(result?.modelID)).toContain("sonnet-4")
  }),
)

it.instance("closest returns undefined for nonexistent provider", () =>
  Effect.gen(function* () {
    const result = yield* Provider.use.closest(ProviderV2.ID.make("nonexistent"), ["model"])
    expect(result).toBeUndefined()
  }),
)

it.instance(
  "getModel uses realIdByKey for aliased models",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].models["my-sonnet"]).toBeDefined()

    const model = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("my-sonnet"))
    expect(model).toBeDefined()
    expect(String(model.id)).toBe("my-sonnet")
    expect(model.name).toBe("My Sonnet Alias")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "my-sonnet": { id: "claude-sonnet-4-20250514", name: "My Sonnet Alias" } },
        },
      },
    },
  },
)

it.instance(
  "provider api field sets model api.url",
  Effect.gen(function* () {
    const providers = yield* list
    // api field is stored on model.api.url, used by getSDK to set baseURL
    expect(providers[ProviderV2.ID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "explicit baseURL overrides api field",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.override.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "model inherits properties from existing database model",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.name).toBe("Custom Name for Sonnet")
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.limit.context).toBeGreaterThan(0)
  }),
  {
    config: {
      provider: { anthropic: { models: { "claude-sonnet-4-20250514": { name: "Custom Name for Sonnet" } } } },
    },
  },
)

it.instance(
  "disabled_providers prevents loading even with env var",
  Effect.gen(function* () {
    yield* set("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { disabled_providers: ["openai"] } },
)

it.instance(
  "enabled_providers with empty array allows no providers",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    yield* set("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(Object.keys(providers).length).toBe(0)
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "whitelist and blacklist can be combined",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models).not.toContain("claude-opus-4-20250514")
    expect(models.length).toBe(1)
  }),
  {
    config: {
      provider: {
        anthropic: {
          whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
          blacklist: ["claude-opus-4-20250514"],
        },
      },
    },
  },
)

it.instance(
  "model modalities default correctly",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.capabilities.input.text).toBe(true)
    expect(model.capabilities.output.text).toBe(true)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model with custom cost values",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(5)
    expect(model.cost.output).toBe(15)
    expect(model.cost.cache.read).toBe(2.5)
    expect(model.cost.cache.write).toBe(7.5)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              limit: { context: 8000, output: 2000 },
              cost: { input: 5, output: 15, cache_read: 2.5, cache_write: 7.5 },
            },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance("getSmallModel returns appropriate small model", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeDefined()
    expect(model?.id).toContain("haiku")
  }),
)

it.instance(
  "getSmallModel respects config small_model override",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeDefined()
    expect(String(model?.providerID)).toBe("anthropic")
    expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
  }),
  { config: { small_model: "anthropic/claude-sonnet-4-20250514" } },
)

it.instance(
  "getSmallModel ignores invalid config small_model",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeUndefined()
  }),
  { config: { small_model: "anthropic/not-a-real-model" } },
)

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

it.instance(
  "multiple providers can be configured simultaneously",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-anthropic-key")
    yield* set("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBe(30000)
    expect(providers[ProviderV2.ID.openai].options.timeout).toBe(60000)
  }),
  {
    config: {
      provider: {
        anthropic: { options: { timeout: 30000 } },
        openai: { options: { timeout: 60000 } },
      },
    },
  },
)

it.instance(
  "provider with custom npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("local-llm")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(providers[ProviderV2.ID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
  }),
  {
    config: {
      provider: {
        "local-llm": {
          name: "Local LLM",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "llama-3": { name: "Llama 3", tool_call: true, limit: { context: 8192, output: 2048 } } },
          options: { apiKey: "not-needed", baseURL: "http://localhost:11434/v1" },
        },
      },
    },
  },
)

// Edge cases for model configuration

it.instance(
  "model alias name defaults to alias key when id differs",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].models["sonnet"].name).toBe("sonnet")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { sonnet: { id: "claude-sonnet-4-20250514" } },
        },
      },
    },
  },
)

it.instance(
  "provider with multiple env var options only includes apiKey when single env",
  Effect.gen(function* () {
    yield* set("MULTI_ENV_KEY_1", "test-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("multi-env")]).toBeDefined()
    // When multiple env options exist, key should NOT be auto-set
    expect(providers[ProviderV2.ID.make("multi-env")].key).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "multi-env": {
          name: "Multi Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { baseURL: "https://api.example.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "provider with single env var includes apiKey automatically",
  Effect.gen(function* () {
    yield* set("SINGLE_ENV_KEY", "my-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("single-env")]).toBeDefined()
    // Single env option should auto-set key
    expect(providers[ProviderV2.ID.make("single-env")].key).toBe("my-api-key")
  }),
  {
    config: {
      provider: {
        "single-env": {
          name: "Single Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["SINGLE_ENV_KEY"],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { baseURL: "https://api.example.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "model cost overrides existing cost values",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.cost.input).toBe(999)
    expect(model.cost.output).toBe(888)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "claude-sonnet-4-20250514": { cost: { input: 999, output: 888 } } },
        },
      },
    },
  },
)

it.instance(
  "completely new provider not in database can be configured",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("brand-new-provider")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("brand-new-provider")].name).toBe("Brand New")
    const model = providers[ProviderV2.ID.make("brand-new-provider")].models["new-model"]
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
  }),
  {
    config: {
      provider: {
        "brand-new-provider": {
          name: "Brand New",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          api: "https://new-api.com/v1",
          models: {
            "new-model": {
              name: "New Model",
              tool_call: true,
              reasoning: true,
              attachment: true,
              temperature: true,
              limit: { context: 32000, output: 8000 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
          options: { apiKey: "new-key" },
        },
      },
    },
  },
)

it.instance(
  "model tool_choice config maps to the forced tool choice capability",
  Effect.gen(function* () {
    const models = (yield* list)[ProviderV2.ID.make("tool-choice-models")].models
    expect(models.supported.capabilities.forcedToolChoice).toBe("required")
    expect(Provider.supportsForcedToolChoice(models.supported)).toBe(true)
    expect(models.unsupported.capabilities.forcedToolChoice).toBe("none")
    expect(Provider.supportsForcedToolChoice(models.unsupported)).toBe(false)
    expect(models.unknown.capabilities.forcedToolChoice).toBeUndefined()
    expect(Provider.supportsForcedToolChoice(models.unknown)).toBe(false)
  }),
  {
    config: {
      provider: {
        "tool-choice-models": {
          name: "Tool Choice Models",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            supported: {
              name: "Supported",
              tool_call: true,
              tool_choice: true,
              limit: { context: 8000, output: 2000 },
            },
            unsupported: {
              name: "Unsupported",
              tool_call: true,
              tool_choice: false,
              limit: { context: 8000, output: 2000 },
            },
            unknown: { name: "Unknown", tool_call: true, limit: { context: 8000, output: 2000 } },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "disabled_providers and enabled_providers interaction",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-anthropic")
    yield* set("OPENAI_API_KEY", "test-openai")
    yield* set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
    const providers = yield* list
    // anthropic: in enabled, not in disabled = allowed
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // openai: in enabled, but also in disabled = NOT allowed
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
    // google: not in enabled = NOT allowed (even though not disabled)
    expect(providers[ProviderV2.ID.google]).toBeUndefined()
  }),
  {
    // enabled_providers takes precedence — only these are considered
    // Then disabled_providers filters from the enabled set
    config: { enabled_providers: ["anthropic", "openai"], disabled_providers: ["openai"] },
  },
)

it.instance(
  "model with tool_call false",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
  }),
  {
    config: {
      provider: {
        "no-tools": {
          name: "No Tools Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "basic-model": { name: "Basic Model", tool_call: false, limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model defaults tool_call to true when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
  }),
  {
    config: {
      provider: {
        "default-tools": {
          name: "Default Tools Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model headers are preserved",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("headers-provider")].models["model"]
    expect(model.headers).toEqual({
      "X-Custom-Header": "custom-value",
      Authorization: "Bearer special-token",
    })
  }),
  {
    config: {
      provider: {
        "headers-provider": {
          name: "Headers Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            model: {
              name: "Model",
              tool_call: true,
              limit: { context: 4000, output: 1000 },
              headers: { "X-Custom-Header": "custom-value", Authorization: "Bearer special-token" },
            },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "provider env fallback - second env var used if first missing",
  Effect.gen(function* () {
    // Only set fallback, not primary
    yield* set("FALLBACK_KEY", "fallback-api-key")
    const providers = yield* list
    // Provider should load because fallback env var is set
    expect(providers[ProviderV2.ID.make("fallback-env")]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "fallback-env": {
          name: "Fallback Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["PRIMARY_KEY", "FALLBACK_KEY"],
          models: { model: { name: "Model", tool_call: true, limit: { context: 4000, output: 1000 } } },
          options: { baseURL: "https://api.example.com" },
        },
      },
    },
  },
)

it.instance("getModel returns consistent results", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model1 = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    const model2 = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    expect(model1.providerID).toEqual(model2.providerID)
    expect(model1.id).toEqual(model2.id)
    expect(model1).toEqual(model2)
  }),
)

it.instance(
  "provider name defaults to id when not in database",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("my-custom-id")].name).toBe("my-custom-id")
  }),
  {
    config: {
      provider: {
        "my-custom-id": {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", tool_call: true, limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance("ModelNotFoundError includes suggestions for typos", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const error = yield* Provider.use
      .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonet-4"))
      .pipe(Effect.flip)
    expect(error.suggestions).toBeDefined()
    expect((error.suggestions ?? []).length).toBeGreaterThan(0)
    expect(error.message).toContain("Model not found: anthropic/claude-sonet-4")
    expect(error.message).toContain("Did you mean:")
  }),
)

it.instance("ModelNotFoundError for provider includes suggestions", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const error = yield* Provider.use
      .getModel(ProviderV2.ID.make("antropic"), ModelV2.ID.make("claude-sonnet-4"))
      .pipe(Effect.flip)
    expect(error.suggestions).toBeDefined()
    expect(error.suggestions).toContain("anthropic")
  }),
)

it.instance("getProvider returns undefined for nonexistent provider", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service.use((svc) => svc.getProvider(ProviderV2.ID.make("nonexistent")))
    expect(provider).toBeUndefined()
  }),
)

it.instance("getProvider returns provider info", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const provider = yield* Provider.use.getProvider(ProviderV2.ID.anthropic)
    expect(provider).toBeDefined()
    expect(String(provider?.id)).toBe("anthropic")
  }),
)

it.instance("closest returns undefined when no partial match found", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["nonexistent-xyz-model"])
    expect(result).toBeUndefined()
  }),
)

it.instance("closest checks multiple query terms in order", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    // First term won't match, second will
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["nonexistent", "haiku"])
    expect(result).toBeDefined()
    expect(result?.modelID).toContain("haiku")
  }),
)

it.instance(
  "model limit defaults to zero when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("no-limit")].models["model"]
    expect(model.limit.context).toBe(0)
    expect(model.limit.output).toBe(0)
  }),
  {
    config: {
      provider: {
        "no-limit": {
          name: "No Limit Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", tool_call: true } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "provider options are deeply merged",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    // Custom options should be merged
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBe(30000)
    expect(providers[ProviderV2.ID.anthropic].options.headers["X-Custom"]).toBe("custom-value")
    // anthropic custom loader adds its own headers, they should coexist
    expect(providers[ProviderV2.ID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
  }),
  {
    config: {
      provider: { anthropic: { options: { headers: { "X-Custom": "custom-value" }, timeout: 30000 } } },
    },
  },
)

it.instance(
  "hosted nvidia provider adds billing origin header",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("nvidia")].options.headers).toEqual({
      "HTTP-Referer": "https://github.com/LeXwDeX/GraphAgent",
      "X-Title": "GraphAgent",
      "X-BILLING-INVOKE-ORIGIN": "GraphAgent",
    })
  }),
  { config: { provider: { nvidia: { options: { apiKey: "test-api-key" } } } } },
)

it.instance(
  "custom nvidia baseURL adds billing origin header",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("nvidia")].options.headers).toEqual({
      "HTTP-Referer": "https://github.com/LeXwDeX/GraphAgent",
      "X-Title": "GraphAgent",
      "X-BILLING-INVOKE-ORIGIN": "GraphAgent",
    })
  }),
  { config: { provider: { nvidia: { options: { apiKey: "test-api-key", baseURL: "http://localhost:8000/v1" } } } } },
)

it.instance(
  "explicit nvidia billing origin header is preserved",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("nvidia")].options.headers["X-BILLING-INVOKE-ORIGIN"]).toBe("CustomOrigin")
  }),
  {
    config: {
      provider: {
        nvidia: {
          options: {
            apiKey: "test-api-key",
            baseURL: "http://localhost:8000/v1",
            headers: { "X-BILLING-INVOKE-ORIGIN": "CustomOrigin" },
          },
        },
      },
    },
  },
)

it.instance(
  "custom model inherits npm package from models.dev provider config",
  Effect.gen(function* () {
    yield* set("OPENAI_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.openai].models["my-custom-model"]
    expect(model).toBeDefined()
    expect(model.api.npm).toBe("@ai-sdk/openai")
  }),
  {
    config: {
      provider: {
        openai: {
          models: {
            "my-custom-model": {
              name: "My Custom Model",
              tool_call: true,
              limit: { context: 8000, output: 2000 },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "custom model inherits api.url from models.dev provider",
  Effect.gen(function* () {
    yield* set("OPENROUTER_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.openrouter]).toBeDefined()

    // New model not in database should inherit api.url from provider
    const intellect = providers[ProviderV2.ID.openrouter].models["prime-intellect/intellect-3"]
    expect(intellect).toBeDefined()
    expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

    // Another new model should also inherit api.url
    const deepseek = providers[ProviderV2.ID.openrouter].models["deepseek/deepseek-r1-0528"]
    expect(deepseek).toBeDefined()
    expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
    expect(deepseek.name).toBe("DeepSeek R1")
  }),
  {
    config: {
      provider: {
        openrouter: {
          models: {
            "prime-intellect/intellect-3": {},
            "deepseek/deepseek-r1-0528": { name: "DeepSeek R1" },
          },
        },
      },
    },
  },
)

test("mode cost preserves over-200k pricing from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
              },
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.cost.input).toEqual(5)
  expect(model.cost.output).toEqual(30)
  expect(model.cost.cache.read).toEqual(0.5)
  expect(model.cost.cache.write).toEqual(0)
  expect(model.options["serviceTier"]).toEqual("priority")
  expect(model.cost.experimentalOver200K).toEqual({
    input: 5,
    output: 22.5,
    cache: { read: 0.5, write: 0 },
  })
})

test("models.dev normalization fills required response fields", () => {
  const provider = {
    id: "gateway",
    name: "Gateway",
    env: [],
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        cost: { input: 2.5, output: 15 },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4"]
  expect(model.api.url).toBe("")
  expect(model.capabilities.temperature).toBe(false)
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.capabilities.attachment).toBe(false)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.release_date).toBe("")
})

// Issue 764: configured long-context pricing (cost.context_over_200k) and inherited
// tier metadata must survive custom/configured model resolution.

const longContextCatalog = {
  "catalog-provider": {
    id: "catalog-provider",
    name: "Catalog Provider",
    env: [],
    api: "https://catalog.example.com/v1",
    models: {
      "long-context-model": {
        id: "long-context-model",
        name: "Long Context Model",
        family: "lc",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 2,
          tiers: [{ input: 30, output: 90, cache_read: 4, cache_write: 8, tier: { type: "context", size: 300_000 } }],
          context_over_200k: { input: 20, output: 75, cache_read: 3 },
        },
        limit: { context: 400_000, output: 64_000 },
      },
    },
  },
} as unknown as Record<string, ModelsDev.Provider>

const longContextCatalogLayer = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    get: () => Effect.succeed(longContextCatalog),
    refresh: () => Effect.void,
  }),
)

const cataloged = testEffect(
  Layer.mergeAll(
    Provider.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(ProviderAdapters.defaultLayer),
      Layer.provide(longContextCatalogLayer),
      Layer.provide(RuntimeFlags.layer({})),
      Layer.provide(EventV2Bridge.defaultLayer),
    ),
    Env.defaultLayer,
    ProviderAdapters.defaultLayer,
    longContextCatalogLayer,
  ),
)

const expectedLongContextTiers: NonNullable<Provider.Model["cost"]["tiers"]> = [
  { input: 30, output: 90, cache: { read: 4, write: 8 }, tier: { type: "context", size: 300_000 } },
]

cataloged.instance(
  "configured model without cost inherits catalog tiers and over-200k pricing",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("catalog-provider")].models["long-context-model"]
    expect(model.name).toBe("Renamed Long Context")
    expect(model.cost.input).toBe(10)
    expect(model.cost.output).toBe(50)
    expect(model.cost.cache).toEqual({ read: 1, write: 2 })
    expect(model.cost.tiers).toEqual(expectedLongContextTiers)
    expect(model.cost.experimentalOver200K).toEqual({
      input: 20,
      output: 75,
      cache: { read: 3, write: 0 },
    })
  }),
  {
    config: {
      provider: {
        "catalog-provider": {
          options: { apiKey: "test-key" },
          models: { "long-context-model": { name: "Renamed Long Context" } },
        },
      },
    },
  },
)

// Issue 780: an explicit cost object replaces the catalog price schedule. Omitted general or
// legacy tiers are not inherited (they would otherwise override the configured rates above
// their catalog thresholds). Omitted base cache rates keep the existing catalog fallback.
cataloged.instance(
  "configured context_over_200k overrides catalog legacy rate without inheriting catalog tiers",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("catalog-provider")].models["long-context-model"]
    expect(model.cost.input).toBe(999)
    expect(model.cost.output).toBe(888)
    expect(model.cost.cache).toEqual({ read: 1, write: 2 })
    expect(model.cost.tiers).toBeUndefined()
    expect(model.cost.experimentalOver200K).toEqual({
      input: 40,
      output: 90,
      cache: { read: 0, write: 0 },
    })
  }),
  {
    config: {
      provider: {
        "catalog-provider": {
          options: { apiKey: "test-key" },
          models: {
            "long-context-model": {
              cost: { input: 999, output: 888, context_over_200k: { input: 40, output: 90 } },
            },
          },
        },
      },
    },
  },
)

cataloged.instance(
  "configured flat cost override drops inherited catalog general and legacy tiers",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("catalog-provider")].models["long-context-model"]
    expect(model.cost.input).toBe(12)
    expect(model.cost.output).toBe(60)
    expect(model.cost.cache).toEqual({ read: 1, write: 2 })
    expect(model.cost.tiers).toBeUndefined()
    expect(model.cost.experimentalOver200K).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "catalog-provider": {
          options: { apiKey: "test-key" },
          models: { "long-context-model": { cost: { input: 12, output: 60 } } },
        },
      },
    },
  },
)

cataloged.instance(
  "configured tiered cost override replaces catalog tiers with configured tiers",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("catalog-provider")].models["long-context-model"]
    expect(model.cost.input).toBe(12)
    expect(model.cost.output).toBe(60)
    expect(model.cost.cache).toEqual({ read: 0.5, write: 2 })
    expect(model.cost.tiers).toEqual([
      { input: 24, output: 120, cache: { read: 1.5, write: 0 }, tier: { type: "context", size: 272_000 } },
    ])
    expect(model.cost.experimentalOver200K).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "catalog-provider": {
          options: { apiKey: "test-key" },
          models: {
            "long-context-model": {
              cost: {
                input: 12,
                output: 60,
                cache_read: 0.5,
                tiers: [{ input: 24, output: 120, cache_read: 1.5, tier: { type: "context", size: 272_000 } }],
              },
            },
          },
        },
      },
    },
  },
)

const longContextCustomConfig = {
  provider: {
    "long-context-custom": {
      name: "Long Context Custom",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        astra: {
          name: "Astra",
          tool_call: true,
          limit: { context: 400_000, output: 64_000 },
          cost: {
            input: 10,
            output: 50,
            cache_read: 1,
            cache_write: 2,
            context_over_200k: { input: 20, output: 75, cache_read: 3 },
          },
        },
        flat: {
          name: "Flat",
          tool_call: true,
          limit: { context: 400_000, output: 64_000 },
          cost: { input: 10, output: 50 },
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}

it.instance(
  "custom model resolves configured context_over_200k into runtime over-200k pricing",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("long-context-custom")].models["astra"]
    expect(model.cost.input).toBe(10)
    expect(model.cost.output).toBe(50)
    expect(model.cost.cache).toEqual({ read: 1, write: 2 })
    expect(model.cost.experimentalOver200K).toEqual({
      input: 20,
      output: 75,
      cache: { read: 3, write: 0 },
    })
    expect(model.cost.tiers).toBeUndefined()
  }),
  { config: longContextCustomConfig },
)

it.instance(
  "custom model without long-context pricing keeps base-rate-only cost metadata",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("long-context-custom")].models["flat"]
    expect(model.cost.input).toBe(10)
    expect(model.cost.output).toBe(50)
    expect(model.cost.experimentalOver200K).toBeUndefined()
    expect(model.cost.tiers).toBeUndefined()
  }),
  { config: longContextCustomConfig },
)

it.instance("model variants are generated for reasoning models", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    // Claude sonnet 4 has reasoning capability
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.variants).toBeDefined()
    expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
  }),
)

it.instance(
  "model variants can be disabled via config",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants).toBeDefined()
    expect(model.variants!["high"]).toBeUndefined()
    // max variant should still exist
    expect(model.variants!["max"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "claude-sonnet-4-20250514": { variants: { high: { disabled: true } } } },
        },
      },
    },
  },
)

it.instance(
  "model variants are ordered by reasoning effort after config merging",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(Object.keys(model.variants!)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "custom-large",
      "custom-small",
    ])
    expect(model.variants!.high.thinking.budgetTokens).toBe(20000)
    expect(model.variants!.max.thinking.budgetTokens).toBe(31999)
    expect(model.variants!.minimal).toBeUndefined()
    expect(model.variants!.low.reasoningEffort).toBe("low")
    expect(model.variants!["custom-large"].budgetTokens).toBe(8000)
    expect(model.variants!["custom-small"].budgetTokens).toBe(2000)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: {
                ultra: { effort: "ultra" },
                "custom-large": { budgetTokens: 8000 },
                xhigh: { effort: "xhigh" },
                medium: { effort: "medium" },
                minimal: { disabled: true },
                low: { reasoningEffort: "low" },
                none: { thinking: { type: "disabled" } },
                high: { thinking: { budgetTokens: 20000 } },
                "custom-small": { budgetTokens: 2000 },
              },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "model variants can be customized via config",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["high"]).toBeDefined()
    expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { high: { thinking: { type: "enabled", budgetTokens: 20000 } } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "disabled key is stripped from variant config",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["max"]).toBeDefined()
    expect(model.variants!["max"].disabled).toBeUndefined()
    expect(model.variants!["max"].customField).toBe("test")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { max: { disabled: false, customField: "test" } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "all variants can be disabled via config",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants).toBeDefined()
    expect(Object.keys(model.variants!).length).toBe(0)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { high: { disabled: true }, max: { disabled: true } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "variant config merges with generated variants",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["high"]).toBeDefined()
    // Should have both the generated thinking config and the custom option
    expect(model.variants!["high"].thinking).toBeDefined()
    expect(model.variants!["high"].extraOption).toBe("custom-value")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": { variants: { high: { extraOption: "custom-value" } } },
          },
        },
      },
    },
  },
)

const toggleConfig = {
  provider: {
    "toggle-custom": {
      name: "Toggle Custom",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        qwen: {
          name: "Qwen",
          reasoning: true,
          tool_call: true,
          limit: { context: 128_000, output: 8_000 },
          profile: {
            reasoning_mode: { toggle: { on: { enable_thinking: true }, off: { enable_thinking: false } } },
          },
        },
        plain: { name: "Plain", reasoning: true, tool_call: true, limit: { context: 128_000, output: 8_000 } },
        m3: {
          id: "MiniMax-M3",
          name: "MiniMax M3",
          reasoning: true,
          tool_call: true,
          limit: { context: 128_000, output: 8_000 },
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}

it.instance(
  "a thinking toggle of the profile becomes the none and thinking variants",
  Effect.gen(function* () {
    const providers = yield* list
    const models = providers[ProviderV2.ID.make("toggle-custom")].models
    // configured: qwen has no tiers of its own, the toggle gives it none and thinking
    expect(models["qwen"].variants).toEqual({
      none: { enable_thinking: false },
      thinking: { enable_thinking: true },
    })
    // built in: the rule of MiniMax-M3 declares the toggle, whatever the configured key is
    expect(models["m3"].variants).toEqual({
      none: { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    })
    expect(ProviderProfile.profileOf(models["m3"]).sources["reasoningMode.toggle"]).toBe("builtin:minimax-m3-toggle")
    // no toggle: the default tiers
    expect(Object.keys(models["plain"].variants!)).toEqual(["low", "medium", "high"])
  }),
  { config: toggleConfig },
)

it.instance(
  "variants filtered in second pass for database models",
  Effect.gen(function* () {
    yield* set("OPENAI_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.openai].models["gpt-5"]
    expect(model.variants).toBeDefined()
    expect(model.variants!["high"]).toBeUndefined()
    // Other variants should still exist
    expect(model.variants!["medium"]).toBeDefined()
  }),
  {
    config: {
      provider: { openai: { models: { "gpt-5": { variants: { high: { disabled: true } } } } } },
    },
  },
)

it.instance(
  "custom model with variants enabled and disabled",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("custom-reasoning")].models["reasoning-model"]
    expect(model.variants).toBeDefined()
    // Enabled variants should exist
    expect(model.variants!["low"]).toBeDefined()
    expect(model.variants!["low"].reasoningEffort).toBe("low")
    expect(model.variants!["medium"]).toBeDefined()
    expect(model.variants!["medium"].reasoningEffort).toBe("medium")
    expect(model.variants!["custom"]).toBeDefined()
    expect(model.variants!["custom"].reasoningEffort).toBe("custom")
    expect(model.variants!["custom"].budgetTokens).toBe(5000)
    // Disabled variant should not exist
    expect(model.variants!["high"]).toBeUndefined()
    // disabled key should be stripped from all variants
    expect(model.variants!["low"].disabled).toBeUndefined()
    expect(model.variants!["medium"].disabled).toBeUndefined()
    expect(model.variants!["custom"].disabled).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "custom-reasoning": {
          name: "Custom Reasoning Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "reasoning-model": {
              name: "Reasoning Model",
              tool_call: true,
              reasoning: true,
              limit: { context: 128000, output: 16000 },
              variants: {
                low: { reasoningEffort: "low" },
                medium: { reasoningEffort: "medium" },
                high: { reasoningEffort: "high", disabled: true },
                custom: { reasoningEffort: "custom", budgetTokens: 5000 },
              },
            },
          },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "Google Vertex: retains baseURL for custom proxy",
  Effect.gen(function* () {
    yield* set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("vertex-proxy")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
  }),
  {
    config: {
      provider: {
        "vertex-proxy": {
          name: "Vertex Proxy",
          npm: "@ai-sdk/google-vertex",
          api: "https://my-proxy.com/v1",
          env: ["GOOGLE_APPLICATION_CREDENTIALS"],
          models: { "gemini-pro": { name: "Gemini Pro", tool_call: true } },
          options: {
            project: "test-project",
            location: "us-central1",
            baseURL: "https://my-proxy.com/v1",
          },
        },
      },
    },
  },
)

it.instance(
  "Google Vertex: supports OpenAI compatible models",
  Effect.gen(function* () {
    yield* set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("vertex-openai")].models["gpt-4"]
    expect(model).toBeDefined()
    expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  }),
  {
    config: {
      provider: {
        "vertex-openai": {
          name: "Vertex OpenAI",
          npm: "@ai-sdk/google-vertex",
          env: ["GOOGLE_APPLICATION_CREDENTIALS"],
          models: {
            "gpt-4": {
              name: "GPT-4",
              provider: { npm: "@ai-sdk/openai-compatible", api: "https://api.openai.com/v1" },
            },
          },
          options: { project: "test-project", location: "us-central1" },
        },
      },
    },
  },
)

it.instance("Google Vertex: uses REP endpoint for Claude continental multi-regions", () =>
  Effect.gen(function* () {
    yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
    yield* set("VERTEX_LOCATION", "eu")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(
      ProviderV2.ID.make("google-vertex"),
      ModelV2.ID.make("claude-sonnet-4-6@default"),
    )
    const language = yield* provider.getLanguage(model)
    expect(languageBaseURL(language)).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/test-project/locations/eu/publishers/anthropic/models",
    )
  }),
)

it.instance("Google Vertex Anthropic: uses REP endpoint for continental multi-regions", () =>
  Effect.gen(function* () {
    yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
    yield* set("VERTEX_LOCATION", "us")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(
      ProviderV2.ID.make("google-vertex-anthropic"),
      ModelV2.ID.make("claude-sonnet-4-6@default"),
    )
    const language = yield* provider.getLanguage(model)
    expect(languageBaseURL(language)).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/test-project/locations/us/publishers/anthropic/models",
    )
  }),
)

it.instance("Google Vertex: keeps regional Claude endpoints unchanged", () =>
  Effect.gen(function* () {
    yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
    yield* set("VERTEX_LOCATION", "europe-west1")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(
      ProviderV2.ID.make("google-vertex"),
      ModelV2.ID.make("claude-sonnet-4-6@default"),
    )
    const language = yield* provider.getLanguage(model)
    expect(languageBaseURL(language)).toBe(
      "https://europe-west1-aiplatform.googleapis.com/v1/projects/test-project/locations/europe-west1/publishers/anthropic/models",
    )
  }),
)

it.instance("cloudflare-ai-gateway loads with env variables", () =>
  Effect.gen(function* () {
    yield* set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* set("CLOUDFLARE_API_TOKEN", "test-token")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("cloudflare-ai-gateway")]).toBeDefined()
  }),
)

it.instance(
  "cloudflare-ai-gateway forwards config metadata options",
  Effect.gen(function* () {
    yield* set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* set("CLOUDFLARE_API_TOKEN", "test-token")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("cloudflare-ai-gateway")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
      invoked_by: "test",
      project: "graphagent",
    })
  }),
  {
    config: {
      provider: { "cloudflare-ai-gateway": { options: { metadata: { invoked_by: "test", project: "graphagent" } } } },
    },
  },
)

// #1462: the model profile is the one place a model's capabilities are read from. A catalog entry brings its own;
// a configured model takes what it declares, then what the existing entry or a same-named catalog entry of
// another provider says; a capability nobody declares is reported once instead of being recorded as 0 or false.

const profileCatalog = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    api: "https://api.acme.test/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "acme-sonnet-4": {
        id: "acme-sonnet-4",
        name: "Acme Sonnet 4",
        family: "acme-sonnet",
        canonical_model_id: "acme/sonnet-4",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        temperature: true,
        tool_call: true,
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      // Its key is what a configured model without an `id` would look up.
      "my-sonnet": {
        id: "my-sonnet",
        name: "Decoy",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 1_000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
      },
      "no-modalities": {
        id: "no-modalities",
        name: "No Modalities",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 0, output: 0 },
      },
    },
  },
  zai: {
    id: "zai",
    name: "Z.ai",
    env: ["ZAI_API_KEY"],
    api: "https://api.zai.test/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.3": {
        id: "glm-5.3",
        name: "GLM 5.3",
        canonical_model_id: "zhipuai/glm-5.3",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
        temperature: true,
        tool_call: true,
        cost: { input: 1, output: 2 },
        limit: { context: 200_000, output: 131_072 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
} satisfies Record<string, ModelsDev.Provider>

const profileCatalogLayer = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    get: () => Effect.succeed(profileCatalog),
    refresh: () => Effect.void,
  }),
)

const profiled = testEffect(
  Layer.mergeAll(
    Provider.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(ProviderAdapters.defaultLayer),
      Layer.provide(profileCatalogLayer),
      Layer.provide(RuntimeFlags.layer({})),
      Layer.provide(EventV2Bridge.defaultLayer),
    ),
    Env.defaultLayer,
    ProviderAdapters.defaultLayer,
    profileCatalogLayer,
  ),
)

const acmeConfig = (models: Record<string, object>) => ({
  provider: { acme: { options: { apiKey: "test-key" }, models } },
})

const relayConfig = (models: Record<string, object>) => ({
  provider: {
    relay: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://relay.test/v1",
      options: { apiKey: "test-key" },
      models,
    },
  },
})

const relay = ProviderV2.ID.make("relay")
const acme = ProviderV2.ID.make("acme")
const modelOf = (providerID: ProviderV2.ID, modelID: string) =>
  Effect.gen(function* () {
    const providers = yield* list
    return providers[providerID].models[modelID]
  })

profiled.instance(
  "catalog models carry the profile of their own entry",
  Effect.gen(function* () {
    const model = yield* modelOf(acme, "acme-sonnet-4")
    expect(model.profile?.context).toBe(200_000)
    expect(model.profile?.output).toBe(64_000)
    expect(model.profile?.vendor).toBe("acme")
    expect(model.profile?.reasoningMode.controls).toEqual([{ type: "toggle" }])
    expect(model.profile?.sources).toEqual({
      context: "catalog",
      output: "catalog",
      "modalities.input": "catalog",
      "modalities.output": "catalog",
      reasoning: "catalog",
      vendor: "catalog",
      "reasoningMode.controls": "catalog",
    })
    expect(model.profile?.missing).toEqual([])
    expect(model.limit).toEqual({ context: 200_000, output: 64_000 })
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.input).toEqual({ text: true, audio: false, image: true, video: false, pdf: false })
    expect(model.capabilities.output).toEqual({ text: true, audio: false, image: false, video: false, pdf: false })
  }),
  { config: acmeConfig({}) },
)

// A catalog entry without `modalities` used to read as accepting no text; it now reads as text only, and the
// missing modalities are reported instead of being guessed away.
profiled.instance(
  "a catalog entry without modalities reads as text only and reports the gap",
  Effect.gen(function* () {
    const model = yield* modelOf(acme, "no-modalities")
    expect(model.capabilities.input).toEqual({ text: true, audio: false, image: false, video: false, pdf: false })
    expect(model.capabilities.output).toEqual({ text: true, audio: false, image: false, video: false, pdf: false })
    expect(model.limit).toEqual({ context: 0, output: 0 })
    expect(model.profile?.missing).toEqual(["context", "output", "modalities"])
    expect(model.profile?.sources["modalities.input"]).toBeUndefined()
    expect(model.profile?.sources.reasoning).toBe("catalog")
  }),
  { config: acmeConfig({}) },
)

profiled.instance(
  "a configured model with an id of the same provider inherits limit, capabilities, cost and profile",
  Effect.gen(function* () {
    const entry = yield* modelOf(acme, "acme-sonnet-4")
    const alias = yield* modelOf(acme, "my-sonnet")
    expect(alias.api.id).toBe("acme-sonnet-4")
    expect(alias.limit).toEqual(entry.limit)
    expect(alias.capabilities).toEqual(entry.capabilities)
    expect(alias.cost).toEqual(entry.cost)
    expect(alias.profile?.sources).toEqual(entry.profile?.sources)
    expect(alias.profile?.reasoningMode.controls).toEqual([{ type: "toggle" }])
    expect(alias.profile?.vendor).toBe("acme")
    expect(alias.profile?.missing).toEqual([])
  }),
  { config: acmeConfig({ "my-sonnet": { id: "acme-sonnet-4" } }) },
)

// The existing entry is the one at `model.id ?? key`: the API id first, the config key only without an id.
profiled.instance(
  "looks the existing entry up by the API id before the config key",
  Effect.gen(function* () {
    const model = yield* modelOf(acme, "my-sonnet")
    expect(model.limit.context).toBe(200_000)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
  }),
  { config: acmeConfig({ "my-sonnet": { id: "acme-sonnet-4", name: "Mine" } }) },
)

profiled.instance(
  "looks the existing entry up by the config key when there is no id",
  Effect.gen(function* () {
    const model = yield* modelOf(acme, "my-sonnet")
    expect(model.name).toBe("Mine")
    expect(model.limit).toEqual({ context: 1_000, output: 100 })
    expect(model.capabilities.reasoning).toBe(false)
    expect(model.capabilities.input.image).toBe(false)
  }),
  { config: acmeConfig({ "my-sonnet": { name: "Mine" } }) },
)

profiled.instance(
  "a configured model takes limit, modalities and reasoning from a same-named catalog entry of another provider",
  Effect.gen(function* () {
    const model = yield* modelOf(relay, "glm")
    expect(model.api.id).toBe("GLM-5.3")
    expect(model.limit).toEqual({ context: 200_000, output: 131_072 })
    expect(model.capabilities.input.image).toBe(true)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(model.profile?.sources.context).toBe("catalog-alias")
    expect(model.profile?.sources.output).toBe("catalog-alias")
    expect(model.profile?.sources["modalities.input"]).toBe("catalog-alias")
    expect(model.profile?.sources.reasoning).toBe("catalog-alias")
    expect(model.profile?.vendor).toBe("zhipuai")
    // The reasoning controls of another provider's entry are not lent.
    expect(model.profile?.reasoningMode.controls).toEqual([])
    expect(model.profile?.sources["reasoningMode.controls"]).toBeUndefined()
    expect(model.profile?.missing).toEqual([])
  }),
  { config: relayConfig({ glm: { id: "GLM-5.3" } }) },
)

profiled.instance(
  "a declared limit wins over the alias, and a limit of 0 counts as not declared",
  Effect.gen(function* () {
    const declared = yield* modelOf(relay, "declared")
    expect(declared.limit).toEqual({ context: 64_000, output: 131_072 })
    expect(declared.profile?.sources.context).toBe("config")
    expect(declared.profile?.sources.output).toBe("catalog-alias")

    const zero = yield* modelOf(relay, "zero")
    expect(zero.limit).toEqual({ context: 200_000, output: 131_072 })
    expect(zero.profile?.sources.context).toBe("catalog-alias")
  }),
  {
    config: relayConfig({
      declared: { id: "glm-5.3", limit: { context: 64_000 } },
      zero: { id: "glm-5.3", limit: { context: 0, output: 0 } },
    }),
  },
)

profiled.instance(
  "a model with neither alias nor declaration reports every capability as missing and reads the default window",
  Effect.gen(function* () {
    const model = yield* modelOf(relay, "no-such-model")
    expect(model.profile?.missing).toEqual(["context", "output", "modalities", "reasoning"])
    expect(model.profile?.sources).toEqual({})
    expect(model.limit).toEqual({ context: 0, output: 0 })
    expect(model.capabilities.reasoning).toBe(false)
    expect(model.capabilities.input.text).toBe(true)
    expect(contextWindow(ProviderProfile.profileOf(model))).toEqual({ tokens: 128_000, source: "default" })
  }),
  { config: relayConfig({ "no-such-model": {} }) },
)

profiled.instance(
  "getModel reports an incomplete profile once per model, with the keys to declare",
  Effect.gen(function* () {
    yield* Provider.use.getModel(relay, ModelV2.ID.make("bare"))
    yield* Provider.use.getModel(relay, ModelV2.ID.make("bare"))
    yield* Provider.use.getModel(relay, ModelV2.ID.make("partial"))
    yield* Provider.use.getModel(relay, ModelV2.ID.make("partial"))
    yield* Provider.use.getModel(relay, ModelV2.ID.make("declared"))
    const logs = JSON.stringify(yield* logLines)
    expect(logs.split("model profile incomplete").length - 1).toBe(2)
    expect(logs).toContain("relay/bare")
    expect(logs).toContain(
      "Declare limit.context, limit.output, modalities, reasoning under provider.relay.models.bare in graphagent.json, for example",
    )
    expect(logs).toContain("relay/partial")
    expect(logs).toContain(
      "Declare limit.output, modalities, reasoning under provider.relay.models.partial in graphagent.json, for example",
    )
    expect(logs).not.toContain("relay/declared")
  }),
  {
    config: relayConfig({
      bare: {},
      partial: { limit: { context: 8_000 } },
      declared: {
        limit: { context: 8_000, output: 1_000 },
        modalities: { input: ["text"], output: ["text"] },
        reasoning: false,
      },
    }),
  },
)

profiled.instance(
  "getModel reports again after the instance is reloaded",
  Effect.gen(function* () {
    const test = yield* TestInstance
    const count = Effect.map(logLines, (lines) => JSON.stringify(lines).split("model profile incomplete").length - 1)
    yield* Provider.use.getModel(relay, ModelV2.ID.make("bare"))
    expect(yield* count).toBe(1)
    yield* reloadInstance({ directory: test.directory })
    yield* Provider.use.getModel(relay, ModelV2.ID.make("bare"))
    yield* Provider.use.getModel(relay, ModelV2.ID.make("bare"))
    expect(yield* count).toBe(2)
  }),
  { config: relayConfig({ bare: {} }) },
)

profiled.instance(
  "the public list leaves profiles off the unconnected catalog models and keeps them on connected ones",
  Effect.gen(function* () {
    const result = yield* Provider.use.publicProviders()
    const zai = result.all.find((item) => item.id === "zai")
    const connected = result.all.find((item) => item.id === "acme")
    expect(result.connected).toContain("acme")
    expect(result.connected).not.toContain("zai")
    expect(zai?.models["glm-5.3"]).toBeDefined()
    expect(zai?.models["glm-5.3"]).not.toHaveProperty("profile")
    expect(zai?.models["glm-5.3"].limit).toEqual({ context: 200_000, output: 131_072 })
    expect(connected?.models["acme-sonnet-4"].profile?.sources.context).toBe("catalog")
  }),
  { config: acmeConfig({}) },
)

test("a catalog provider converted without a profile keeps its variants and everything else", () => {
  const provider = profileCatalog.zai
  const withProfile = Provider.fromModelsDevProvider(provider)
  const without = Provider.fromModelsDevProvider(provider, { profile: false })
  const model = without.models["glm-5.3"]
  expect(model).not.toHaveProperty("profile")
  expect(withProfile.models["glm-5.3"].profile?.vendor).toBe("zhipuai")
  expect(model.variants).toEqual(withProfile.models["glm-5.3"].variants)
  expect({ ...withProfile.models["glm-5.3"], profile: undefined }).toEqual({ ...model, profile: undefined })
})

// A model an adapter returns as a copy of a catalog model can carry the catalog's profile while the adapter narrows
// its window (the Codex adapter does). The profile must follow the model, or every reader of the window would see
// the catalog's value, and a configured override of that model would lose the adapter's limit.
const narrowingAdapters: readonly ProviderAdapter[] = [
  {
    id: "test.narrowing",
    provider: {
      id: "acme",
      models: async (provider) =>
        Object.fromEntries(
          Object.entries(provider.models ?? {}).map(([id, model]) => [
            id,
            id === "acme-sonnet-4" ? { ...model, limit: { context: 100_000, output: 16_000 } } : { ...model },
          ]),
        ),
    },
  },
]

const narrowing = testEffect(
  Layer.mergeAll(
    Provider.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(
        Layer.succeed(ProviderAdapters.Service, ProviderAdapters.createRegistry(Effect.succeed(narrowingAdapters))),
      ),
      Layer.provide(profileCatalogLayer),
      Layer.provide(RuntimeFlags.layer({})),
      Layer.provide(EventV2Bridge.defaultLayer),
    ),
    Env.defaultLayer,
    profileCatalogLayer,
  ),
)

narrowing.instance(
  "the profile of an adapter model follows the limit the adapter changed",
  Effect.gen(function* () {
    const narrowed = yield* modelOf(acme, "acme-sonnet-4")
    expect(narrowed.limit).toEqual({ context: 100_000, output: 16_000 })
    expect(narrowed.profile?.context).toBe(100_000)
    expect(narrowed.profile?.output).toBe(16_000)
    expect(narrowed.profile?.sources.context).toBe("adapter")
    // What the adapter left alone keeps the catalog as its source.
    expect(narrowed.profile?.sources.reasoning).toBe("catalog")
    expect(narrowed.profile?.reasoningMode.controls).toEqual([{ type: "toggle" }])
    expect(contextWindow(ProviderProfile.profileOf(narrowed))).toEqual({ tokens: 100_000, source: "adapter" })
    // A model the adapter did not touch stays as the catalog has it.
    const untouched = yield* modelOf(acme, "my-sonnet")
    expect(untouched.profile?.sources.context).toBe("catalog")
  }),
  { config: acmeConfig({}) },
)

narrowing.instance(
  "a configured override of an adapter model keeps the limit the adapter set",
  Effect.gen(function* () {
    const model = yield* modelOf(acme, "acme-sonnet-4")
    expect(model.name).toBe("Renamed")
    expect(model.limit).toEqual({ context: 100_000, output: 16_000 })
    expect(model.profile?.context).toBe(100_000)
    expect(model.profile?.sources.context).toBe("adapter")
  }),
  { config: acmeConfig({ "acme-sonnet-4": { name: "Renamed" } }) },
)
