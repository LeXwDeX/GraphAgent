// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { contextWindow, type BuiltinRule, type ModelProfile } from "@graphagent/core/model-profile"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { Provider } from "@/provider/provider"
import { ProviderProfile } from "@/provider/profile"

type Fixture = Parameters<typeof ProviderProfile.profileOf>[0]

// Fixtures the way the session tests build them: only what the test reads.
const bare = (extra: Partial<Provider.Model> = {}): Fixture => ({
  id: ModelV2.ID.make("reasoner"),
  providerID: ProviderV2.ID.make("local"),
  ...extra,
})

const flags = (...on: string[]) => ({
  text: on.includes("text"),
  audio: on.includes("audio"),
  image: on.includes("image"),
  video: on.includes("video"),
  pdf: on.includes("pdf"),
})

const full = (extra: Partial<Provider.Model> = {}): Provider.Model => ({
  id: ModelV2.ID.make("m"),
  providerID: ProviderV2.ID.make("relay"),
  api: { id: "m", url: "https://relay.test/v1", npm: "@ai-sdk/openai-compatible" },
  name: "M",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: flags("text", "image"),
    output: flags("text"),
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 64_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
  ...extra,
})

describe("ProviderProfile.profileOf", () => {
  test("does not throw on a fixture that has only an id, a provider and a limit", () => {
    const profile = ProviderProfile.profileOf(bare({ limit: { context: 128_000, output: 8_192 } }))
    expect(profile.context).toBe(128_000)
    expect(profile.output).toBe(8_192)
    expect(profile.sources.context).toBe("adapter")
    expect(profile.sources.output).toBe("adapter")
    expect(profile.missing).toEqual(["modalities", "reasoning"])
    expect(profile.modalities).toEqual({ input: ["text"], output: ["text"] })
    expect(contextWindow(profile)).toEqual({ tokens: 128_000, source: "adapter" })
  })

  test("a fixture without limit, capabilities, api or release date misses all four capabilities", () => {
    const profile = ProviderProfile.profileOf(bare())
    expect(profile.missing).toEqual(["context", "output", "modalities", "reasoning"])
    expect(profile.sources).toEqual({})
    expect(contextWindow(profile)).toEqual({ tokens: 128_000, source: "default" })
  })

  test("a limit of zero or less is no value", () => {
    for (const value of [0, -1, Number.NaN]) {
      const profile = ProviderProfile.profileOf(bare({ limit: { context: value, output: value } }))
      expect(profile.context).toBeUndefined()
      expect(profile.output).toBeUndefined()
      expect(profile.missing).toContain("context")
      expect(profile.missing).toContain("output")
    }
  })

  test("returns the profile a model carries, as it is", () => {
    const profile = ProviderProfile.builtinProfileOf("relay", "m")
    const model = full({ profile })
    expect(ProviderProfile.profileOf(model)).toBe(profile)
    // Even when the model's own limit says otherwise: the carried profile is the declaration.
    expect(ProviderProfile.profileOf({ ...model, limit: { context: 1, output: 1 } })).toBe(profile)
  })

  test("derives the profile of a model without one from its limit and capabilities", () => {
    const profile = ProviderProfile.profileOf(
      full({
        capabilities: { ...full().capabilities, input: flags("pdf", "image", "text"), output: flags("text", "audio") },
      }),
    )
    expect(profile.context).toBe(200_000)
    expect(profile.output).toBe(64_000)
    expect(profile.reasoning).toBe(true)
    expect(profile.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text", "audio"] })
    expect(profile.sources).toEqual({
      context: "adapter",
      output: "adapter",
      "modalities.input": "adapter",
      "modalities.output": "adapter",
      reasoning: "adapter",
    })
    expect(profile.missing).toEqual([])
  })

  test("a reasoning flag of false is a value, not a gap", () => {
    const profile = ProviderProfile.profileOf(full({ capabilities: { ...full().capabilities, reasoning: false } }))
    expect(profile.reasoning).toBe(false)
    expect(profile.sources.reasoning).toBe("adapter")
    expect(profile.missing).toEqual([])
  })

  test("uses the API id, and falls back to the model id", () => {
    expect(ProviderProfile.profileOf(full({ api: { id: "vendor/real-name", url: "", npm: "x" } })).vendor).toBe(
      "vendor",
    )
    expect(ProviderProfile.profileOf(bare({ id: ModelV2.ID.make("acme/model") })).vendor).toBe("acme")
    expect(ProviderProfile.profileOf(bare({ id: ModelV2.ID.make("model") })).vendor).toBeUndefined()
  })
})

describe("ProviderProfile.modalityFlags", () => {
  test("turns a list of modalities into the five booleans", () => {
    expect(ProviderProfile.modalityFlags(["text", "image"])).toEqual(flags("text", "image"))
    expect(ProviderProfile.modalityFlags([])).toEqual(flags())
    expect(ProviderProfile.modalityFlags(["pdf", "video", "audio", "text", "image"])).toEqual(
      flags("text", "audio", "image", "video", "pdf"),
    )
  })
})

describe("ProviderProfile.builtinProfileOf", () => {
  test("does not throw for a model that is not registered and misses all four capabilities", () => {
    const profile = ProviderProfile.builtinProfileOf("relay", "no-such-model")
    expect(profile.missing).toEqual(["context", "output", "modalities", "reasoning"])
    expect(profile.sources).toEqual({})
    expect(profile.editTools).toBe("edit")
  })

  test("applies an injected rule that matches the id, and records the rule as the source", () => {
    const rule: BuiltinRule = {
      name: "gpt-edit",
      source: "test",
      match: (input) => input.apiID.includes("gpt-"),
      set: () => ({ editTools: "apply_patch" }),
    }
    const matched = ProviderProfile.builtinProfileOf("relay", "vendor/gpt-9", [rule])
    expect(matched.editTools).toBe("apply_patch")
    expect(matched.sources.editTools).toBe("builtin:gpt-edit")
    expect(matched.vendor).toBe("vendor")
    const missed = ProviderProfile.builtinProfileOf("relay", "claude-9", [rule])
    expect(missed.editTools).toBe("edit")
    expect(missed.sources.editTools).toBeUndefined()
  })
})

describe("ProviderProfile.syncProfile", () => {
  const profiled = () => {
    const base = full()
    const profile = ProviderProfile.profileOf(base)
    return { ...base, profile: { ...profile, sources: { ...profile.sources, context: "catalog" } } }
  }

  test("returns the same model when nothing in it contradicts its profile", () => {
    const model = profiled()
    expect(ProviderProfile.syncProfile(model)).toBe(model)
    const unprofiled = full()
    expect(ProviderProfile.syncProfile(unprofiled)).toBe(unprofiled)
  })

  test("takes the adapter's window and output limit, and keeps what it did not touch", () => {
    const model = profiled()
    const narrowed = ProviderProfile.syncProfile({ ...model, limit: { context: 400_000, output: 128_000 } })
    expect(narrowed.profile?.context).toBe(400_000)
    expect(narrowed.profile?.output).toBe(128_000)
    expect(narrowed.profile?.sources.context).toBe("adapter")
    expect(narrowed.profile?.sources.output).toBe("adapter")
    // Fields the adapter did not change keep their own origin.
    expect(narrowed.profile?.sources.reasoning).toBe("adapter")
    expect(narrowed.profile?.modalities).toEqual(model.profile.modalities)
    expect(narrowed.limit).toEqual({ context: 400_000, output: 128_000 })
    expect(contextWindow(ProviderProfile.profileOf(narrowed))).toEqual({ tokens: 400_000, source: "adapter" })
  })

  test("takes a changed modality direction and reasoning flag", () => {
    const model = profiled()
    const changed = ProviderProfile.syncProfile({
      ...model,
      capabilities: { ...model.capabilities, input: flags("text", "image", "pdf"), reasoning: false },
    })
    expect(changed.profile?.modalities.input).toEqual(["text", "image", "pdf"])
    expect(changed.profile?.modalities.output).toEqual(model.profile.modalities.output)
    expect(changed.profile?.sources["modalities.input"]).toBe("adapter")
    expect(changed.profile?.reasoning).toBe(false)
    expect(changed.profile?.sources.reasoning).toBe("adapter")
  })

  test("a different order of the same modalities is no change", () => {
    const model = profiled()
    const reordered: Provider.Model = {
      ...model,
      profile: { ...model.profile, modalities: { input: ["image", "text"], output: ["text"] } },
    }
    expect(ProviderProfile.syncProfile(reordered)).toBe(reordered)
  })

  test("keeps a field with a source of its own when the model's value agrees", () => {
    const model = profiled()
    const synced = ProviderProfile.syncProfile({ ...model, limit: { ...model.limit, context: model.limit.context } })
    expect(synced.profile?.sources.context).toBe("catalog")
  })
})

describe("module boundary", () => {
  test("imports provider.ts for types only", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../src/provider/profile.ts"), "utf8")
    const imports = source.split("\n").filter((line) => /^import .*provider"/.test(line))
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatch(/^import type /)
  })

  test("a profile is JSON, so it survives the public copy of a provider", () => {
    const profile: ModelProfile = ProviderProfile.profileOf(full())
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile)
  })
})
