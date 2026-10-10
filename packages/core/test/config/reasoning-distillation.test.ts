import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigReasoningDistillation } from "../../src/config/reasoning-distillation"

describe("ConfigReasoningDistillation.resolveEnabled (D02)", () => {
  test("defaults on when nothing is set", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false })).toEqual({
      enabled: true,
      source: "default",
    })
  })

  test("the environment kill-switch overrides the default", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: true })).toEqual({
      enabled: false,
      source: "environment",
    })
  })

  test("the environment kill-switch overrides an explicit config value", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: true, enabled: true })).toEqual({
      enabled: false,
      source: "environment",
    })
  })

  test("an explicit config value is honored", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false, enabled: false })).toEqual({
      enabled: false,
      source: "config",
    })
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false, enabled: true })).toEqual({
      enabled: true,
      source: "config",
    })
  })

  test("decodes exact compatibility evidence records", () => {
    const decoded = Schema.decodeUnknownSync(ConfigReasoningDistillation.Info)({
      enabled: true,
      compatibility: [
        {
          runtime: "opencode-ai-sdk",
          protocol: "openai-compatible",
          providerModelVariant: "provider/model/default",
          endpointIdentity: "endpoint-hash",
          adapterVersion: "adapter-v1",
          optionsFingerprint: "options-hash",
          transportVerified: true,
          upstreamVerified: true,
        },
      ],
    })
    expect(decoded.compatibility).toHaveLength(1)
    expect(decoded.compatibility?.[0].upstreamVerified).toBe(true)
  })
})

describe("ConfigReasoningDistillation language", () => {
  test("defaults to Chinese and accepts only zh or en", () => {
    expect(ConfigReasoningDistillation.resolveLanguage(undefined)).toBe("zh")
    expect(ConfigReasoningDistillation.resolveLanguage({})).toBe("zh")
    const decode = Schema.decodeUnknownSync(ConfigReasoningDistillation.Info)
    expect(ConfigReasoningDistillation.resolveLanguage(decode({ enabled: true, language: "en" }))).toBe("en")
    expect(ConfigReasoningDistillation.resolveLanguage(decode({ language: "zh" }))).toBe("zh")
    expect(() => decode({ language: "fr" })).toThrow()
  })
})
