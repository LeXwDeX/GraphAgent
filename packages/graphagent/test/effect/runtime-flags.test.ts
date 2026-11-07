import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

const fromConfig = (input: Record<string, unknown>) =>
  RuntimeFlags.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readFlags = RuntimeFlags.Service.useSync((flags) => flags)

describe("RuntimeFlags", () => {
  it.effect("defaultLayer parses runtime flags from the active ConfigProvider", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            GRAPHAGENT_DISABLE_LSP_DOWNLOAD: "true",
            GRAPHAGENT_ENABLE_EXA: "true",
            GRAPHAGENT_ENABLE_PARALLEL: "true",
            GRAPHAGENT_ENABLE_EXPERIMENTAL_MODELS: "true",
            GRAPHAGENT_ENABLE_QUESTION_TOOL: "true",
            GRAPHAGENT_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
            GRAPHAGENT_LSP_TOOL: "true",
            GRAPHAGENT_OXFMT: "true",
            GRAPHAGENT_PLAN_MODE: "true",
            GRAPHAGENT_WORKSPACES: "true",
            GRAPHAGENT_ICON_DISCOVERY: "true",
            GRAPHAGENT_CLIENT: "desktop",
          }),
        ),
      )

      expect(flags.disableLspDownload).toBe(true)
      expect(flags.enableExa).toBe(true)
      expect(flags.enableParallel).toBe(true)
      expect(flags.enableExperimentalModels).toBe(true)
      expect(flags.enableQuestionTool).toBe(true)
      expect(flags.experimentalBackgroundSubagents).toBe(true)
      expect(flags.experimentalLspTy).toBe(false)
      expect(flags.experimentalLspTool).toBe(true)
      expect(flags.experimentalOxfmt).toBe(true)
      expect(flags.experimentalPlanMode).toBe(true)
      expect(flags.experimentalWorkspaces).toBe(true)
      expect(flags.experimentalIconDiscovery).toBe(true)
      expect(flags.experimentalNativeLlm).toBe(false)
      expect(flags.experimentalWebSockets).toBe(false)
      expect(flags.client).toBe("desktop")
    }),
  )

  it.effect("defaultLayer parses GRAPHAGENT_LSP_TY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            GRAPHAGENT_LSP_TY: "true",
          }),
        ),
      )

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )

  it.effect("enables native LLM via GRAPHAGENT_NATIVE_LLM", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ GRAPHAGENT_NATIVE_LLM: "true" })))
      const absent = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(explicit.experimentalNativeLlm).toBe(true)
      expect(absent.experimentalNativeLlm).toBe(false)
    }),
  )

  it.effect("enables WebSockets via GRAPHAGENT_WEBSOCKETS", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ GRAPHAGENT_WEBSOCKETS: "true" })))
      const absent = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(explicit.experimentalWebSockets).toBe(true)
      expect(absent.experimentalWebSockets).toBe(false)
    }),
  )

  it.effect("layer accepts partial test overrides and fills defaults from Config definitions", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 1_000 })))

      expect(flags.disableLspDownload).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBe(1_000)
      expect(flags.enableExperimentalModels).toBe(false)
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("experimentalIconDiscovery defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("disableLspDownload defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableLspDownload).toBe(false)
    }),
  )

  it.effect("disableLspDownload reads GRAPHAGENT_DISABLE_LSP_DOWNLOAD", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ GRAPHAGENT_DISABLE_LSP_DOWNLOAD: "true" })))

      expect(flags.disableLspDownload).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery reads GRAPHAGENT_ICON_DISCOVERY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ GRAPHAGENT_ICON_DISCOVERY: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("experimentalOxfmt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalOxfmt).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt is enabled by GRAPHAGENT_OXFMT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            GRAPHAGENT_OXFMT: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "0" }, expected: undefined },
    { name: "negative", config: { GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses bashDefaultTimeoutMs from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.bashDefaultTimeoutMs).toBe(input.expected)
      }),
    )
  }

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { GRAPHAGENT_BASH_SILENCE_WARN_MS: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { GRAPHAGENT_BASH_SILENCE_WARN_MS: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { GRAPHAGENT_BASH_SILENCE_WARN_MS: "0" }, expected: undefined },
    { name: "negative", config: { GRAPHAGENT_BASH_SILENCE_WARN_MS: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { GRAPHAGENT_BASH_SILENCE_WARN_MS: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses bashSilenceWarnMs from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.bashSilenceWarnMs).toBe(input.expected)
      }),
    )
  }

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { GRAPHAGENT_OUTPUT_TOKEN_MAX: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { GRAPHAGENT_OUTPUT_TOKEN_MAX: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { GRAPHAGENT_OUTPUT_TOKEN_MAX: "0" }, expected: undefined },
    { name: "negative", config: { GRAPHAGENT_OUTPUT_TOKEN_MAX: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { GRAPHAGENT_OUTPUT_TOKEN_MAX: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses outputTokenMax from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.outputTokenMax).toBe(input.expected)
      }),
    )
  }

  it.effect("layer ignores the active ConfigProvider for omitted test overrides", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer()),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              GRAPHAGENT_DISABLE_LSP_DOWNLOAD: "true",
              GRAPHAGENT_ENABLE_EXA: "true",
              GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS: "1234",
              GRAPHAGENT_CLIENT: "desktop",
            }),
          ),
        ),
      )

      expect(flags.disableLspDownload).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBeUndefined()
      expect(flags.client).toBe("cli")
    }),
  )
})
