// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import {
  contextWindow,
  DEFAULT_CONTEXT_WINDOW,
  fromCatalogEntry,
  ModelProfile,
  resolveProfile,
  type BuiltinRule,
  type ProfileConfig,
  type ProfilePatch,
  type RuleInput,
} from "@graphagent/core/model-profile"
import { BUILTIN_RULES } from "@graphagent/core/model-profile-builtin"
import type { ModelsDev } from "@graphagent/core/models-dev"

const entry = (id: string, extra: Partial<ModelsDev.Model> = {}): ModelsDev.Model => ({
  id,
  name: id,
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 8_000, output: 1_000 },
  modalities: { input: ["text"], output: ["text"] },
  ...extra,
})

/** A catalog entry the way the runtime receives it: parsed JSON that is never decoded, so any shape can arrive. */
const parsed = (value: unknown): ModelsDev.Model => JSON.parse(JSON.stringify(value))

const catalogOf = (
  providers: Record<string, ModelsDev.Model[] | Record<string, ModelsDev.Model>>,
): Record<string, ModelsDev.Provider> =>
  Object.fromEntries(
    Object.entries(providers).map(([id, models]) => [
      id,
      {
        id,
        name: id,
        env: [],
        models: Array.isArray(models) ? Object.fromEntries(models.map((item) => [item.id, item])) : models,
      },
    ]),
  )

/** A rule that matches by the start of the API id and fills the given patch. */
const rule = (name: string, prefix: string, patch: ProfilePatch): BuiltinRule => ({
  name,
  source: "test",
  match: (input) => input.apiID.startsWith(prefix),
  set: () => patch,
})

const same = { providerID: "relay", apiID: "m" }

describe("resolveProfile defaults", () => {
  test("empty input yields the missing values and reports every capability as missing", () => {
    const profile = resolveProfile({ providerID: "relay", apiID: "no-such-model" })
    expect(profile).toStrictEqual({
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCallId: { charset: "any" },
      userAfterToolResult: "allow",
      toolResultMedia: "none",
      cacheMarker: "none",
      reasoningMode: { controls: [], placeholder: false, replay: "none" },
      sampling: {},
      finishReasons: {},
      editTools: "edit",
      toolLimits: {},
      schemaFixes: [],
      sources: {},
      missing: ["context", "output", "modalities", "reasoning"],
    })
  })

  test("every field a profile can hold decodes with its own schema", () => {
    const config: ProfileConfig = {
      limit: { context: 200_000, output: 64_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: true,
      profile: {
        vendor: "ZhipuAI",
        effective_context: 100_000,
        tool_call_id: { charset: "alnum", length: 9 },
        user_after_tool_result: "bridge",
        tool_result_media: "image",
        cache_marker: "explicit",
        reasoning_mode: {
          controls: [
            { type: "toggle" },
            { type: "effort", values: ["low", "high"] },
            { type: "budget_tokens", min: 1 },
          ],
          toggle: { on: { thinking: { type: "enabled" } }, off: { thinking: { type: "disabled" } } },
          placeholder: true,
          replay: "field",
          inline_tag: "think",
        },
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 },
        finish_reasons: { sensitive: "content-filter", network_error: "stream_error" },
        edit_tools: "apply_patch",
        tool_limits: { max_tools: 128, name_max_length: 64, name_pattern: "^[a-z_]+$" },
        schema_fixes: ["moonshot"],
      },
    }
    const profile = resolveProfile({ ...same, config })
    expect(profile.missing).toEqual([])
    expect(Schema.decodeUnknownSync(ModelProfile)(profile)).toEqual(profile)
    expect(Schema.encodeSync(ModelProfile)(profile)).toEqual(profile)
    expect(profile.vendor).toBe("zhipuai")
    expect(profile.toolLimits).toStrictEqual({ maxTools: 128, nameMaxLength: 64, namePattern: "^[a-z_]+$" })
    expect(profile.sampling).toStrictEqual({ temperature: 0.6, topP: 0.95, topK: 20 })
    expect(profile.reasoningMode.inlineTag).toBe("think")
  })
})

describe("resolveProfile priority", () => {
  const base = { context: 2_000, sources: { context: "adapter" } }
  const catalog = catalogOf({ other: [entry("m", { limit: { context: 3_000, output: 300 } })] })
  const rules = [rule("window", "m", { context: 4_000 })]

  test("takes the first value in the order config, base, alias, rules, default", () => {
    const resolve = (input: Partial<Parameters<typeof resolveProfile>[0]>) => resolveProfile({ ...same, ...input })
    const config = { limit: { context: 1_000 } }
    expect(resolve({ config, base, catalog, rules }).context).toBe(1_000)
    expect(resolve({ config, base, catalog, rules }).sources.context).toBe("config")
    expect(resolve({ base, catalog, rules }).context).toBe(2_000)
    expect(resolve({ base, catalog, rules }).sources.context).toBe("adapter")
    expect(resolve({ catalog, rules }).context).toBe(3_000)
    expect(resolve({ catalog, rules }).sources.context).toBe("catalog-alias")
    expect(resolve({ rules }).context).toBe(4_000)
    expect(resolve({ rules }).sources.context).toBe("builtin:window")
    expect(resolve({}).context).toBeUndefined()
    expect(resolve({}).sources.context).toBeUndefined()
  })

  test("a field of the base without a source is not inherited", () => {
    const profile = resolveProfile({ ...same, base: { context: 2_000, output: 200, sources: { output: "catalog" } } })
    expect(profile.context).toBeUndefined()
    expect(profile.output).toBe(200)
    expect(profile.missing).toEqual(["context", "modalities", "reasoning"])
  })

  test("zero, negative and non-finite windows count as absent and fall through", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fromBase = resolveProfile({
        ...same,
        config: { limit: { context: value, output: value } },
        base: {
          context: 5_000,
          output: 500,
          sources: { context: "adapter", output: "adapter" },
        },
      })
      expect(fromBase.context).toBe(5_000)
      expect(fromBase.output).toBe(500)
      expect(fromBase.sources.context).toBe("adapter")

      const alone = resolveProfile({ ...same, config: { limit: { context: value, output: value } } })
      expect(alone.context).toBeUndefined()
      expect(alone.output).toBeUndefined()
      expect(alone.missing).toEqual(["context", "output", "modalities", "reasoning"])
    }
  })

  test("config values replace whole: sampling and tool limits are not merged with the base", () => {
    const profile = resolveProfile({
      ...same,
      config: { profile: { sampling: { temperature: 0.6 }, tool_limits: { max_tools: 10 } } },
      base: {
        sampling: { topP: 0.9 },
        toolLimits: { nameMaxLength: 64 },
        sources: { sampling: "adapter", toolLimits: "adapter" },
      },
    })
    expect(profile.sampling).toStrictEqual({ temperature: 0.6 })
    expect(profile.toolLimits).toStrictEqual({ maxTools: 10 })
  })

  test("reasoning_mode goes per key", () => {
    const profile = resolveProfile({
      ...same,
      config: { profile: { reasoning_mode: { replay: "field" } } },
      base: {
        reasoningMode: { controls: [{ type: "toggle" }], placeholder: true, replay: "signed" },
        sources: {
          "reasoningMode.controls": "catalog",
          "reasoningMode.placeholder": "adapter",
          "reasoningMode.replay": "adapter",
        },
      },
    })
    expect(profile.reasoningMode).toEqual({ controls: [{ type: "toggle" }], placeholder: true, replay: "field" })
    expect(profile.sources["reasoningMode.replay"]).toBe("config")
    expect(profile.sources["reasoningMode.placeholder"]).toBe("adapter")
    expect(profile.sources["reasoningMode.controls"]).toBe("catalog")
  })

  test("an explicitly empty list in the config still counts as a declaration", () => {
    const profile = resolveProfile({
      ...same,
      config: { profile: { schema_fixes: [], reasoning_mode: { controls: [] } } },
      rules: [rule("fix", "m", { schemaFixes: ["gemini"], reasoningMode: { controls: [{ type: "toggle" }] } })],
    })
    expect(profile.schemaFixes).toEqual([])
    expect(profile.reasoningMode.controls).toEqual([])
    expect(profile.sources.schemaFixes).toBe("config")
    expect(profile.sources["reasoningMode.controls"]).toBe("config")
  })

  test("effective_context must be a positive integer to count", () => {
    expect(resolveProfile({ ...same, config: { profile: { effective_context: 90_000 } } }).effectiveContext).toBe(
      90_000,
    )
    for (const value of [0, -5, 1.5, Number.NaN]) {
      expect(
        resolveProfile({ ...same, config: { profile: { effective_context: value } } }).effectiveContext,
      ).toBeUndefined()
    }
  })

  test("modalities are replaced per direction", () => {
    const base = fromCatalogEntry(entry("m", { modalities: { input: ["text", "pdf"], output: ["text", "image"] } }))
    const profile = resolveProfile({ ...same, base, config: { modalities: { input: ["text", "audio"] } } })
    expect(profile.modalities).toEqual({ input: ["text", "audio"], output: ["text", "image"] })
    expect(profile.sources["modalities.input"]).toBe("config")
    expect(profile.sources["modalities.output"]).toBe("catalog")

    const outputOnly = resolveProfile({ ...same, base, config: { modalities: { output: [] } } })
    expect(outputOnly.modalities).toEqual({ input: ["text", "pdf"], output: [] })
    expect(outputOnly.sources["modalities.output"]).toBe("config")
  })

  test("a configured reasoning flag wins even when false", () => {
    const base = fromCatalogEntry(entry("m", { reasoning: true }))
    const profile = resolveProfile({ ...same, base, config: { reasoning: false } })
    expect(profile.reasoning).toBe(false)
    expect(profile.sources.reasoning).toBe("config")
    expect(profile.missing).not.toContain("reasoning")
  })
})

describe("catalog aliases", () => {
  const aliasEntry = (id: string, canonical: string | undefined, context: number) =>
    entry(id, {
      ...(canonical === undefined ? {} : { canonical_model_id: canonical }),
      reasoning: true,
      limit: { context, output: context / 10 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
  const catalog = catalogOf({
    zhipuai: [aliasEntry("glm-5.3", "zhipuai/glm-5.3", 200_000)],
    openrouter: [aliasEntry("z-ai/glm-5.3", "zhipuai/glm-5.3", 128_000)],
  })

  test("matches the id ignoring case", () => {
    const profile = resolveProfile({ providerID: "relay", apiID: "GLM-5.3", catalog })
    expect(profile.context).toBe(200_000)
    expect(profile.output).toBe(20_000)
    expect(profile.reasoning).toBe(true)
    expect(profile.modalities.input).toEqual(["text", "image"])
    expect(profile.vendor).toBe("zhipuai")
    expect(profile.sources).toEqual({
      context: "catalog-alias",
      output: "catalog-alias",
      "modalities.input": "catalog-alias",
      "modalities.output": "catalog-alias",
      reasoning: "catalog-alias",
      vendor: "catalog-alias",
    })
    expect(profile.missing).toEqual([])
  })

  test("matches the canonical name, and the id comes before the canonical name", () => {
    // `zhipuai/glm-5.3` is the canonical name of both entries and the id of neither: the first provider wins.
    const byCanonical = resolveProfile({ providerID: "relay", apiID: "zhipuai/glm-5.3", catalog })
    expect(byCanonical.context).toBe(128_000)
    expect(byCanonical.sources.context).toBe("catalog-alias")
    // `glm-5.3` is the id of one entry and the tail of both canonical names: the id match wins.
    const byId = resolveProfile({ providerID: "relay", apiID: "glm-5.3", catalog })
    expect(byId.context).toBe(200_000)
  })

  test("matches a canonical name that ends with the id, ignoring case", () => {
    const only = catalogOf({ zhipuai: [aliasEntry("glm-x", "Zhipuai/GLM-5.3", 99_000)] })
    expect(resolveProfile({ providerID: "relay", apiID: "glm-5.3", catalog: only }).context).toBe(99_000)
    expect(resolveProfile({ providerID: "relay", apiID: "ZHIPUAI/glm-5.3", catalog: only }).context).toBe(99_000)
    // A longer tail is not a match: the canonical name must end with `/` plus the id.
    expect(resolveProfile({ providerID: "relay", apiID: "5.3", catalog: only }).context).toBeUndefined()
    expect(resolveProfile({ providerID: "relay", apiID: "lm-5.3", catalog: only }).context).toBeUndefined()
  })

  test("takes the first of several hits by provider id, then entry key", () => {
    const crowded = catalogOf({
      zzz: [aliasEntry("glm-5.3", undefined, 1_000)],
      mmm: { "b-key": aliasEntry("glm-5.3", undefined, 2_000), "a-key": aliasEntry("glm-5.3", undefined, 3_000) },
      aaa: [aliasEntry("other", undefined, 4_000)],
    })
    expect(resolveProfile({ providerID: "relay", apiID: "glm-5.3", catalog: crowded }).context).toBe(3_000)
  })

  test("lends nothing when it finds no entry, and nothing without a catalog", () => {
    expect(resolveProfile({ providerID: "relay", apiID: "unrelated", catalog }).missing).toEqual([
      "context",
      "output",
      "modalities",
      "reasoning",
    ])
    expect(resolveProfile({ providerID: "relay", apiID: "glm-5.3" }).context).toBeUndefined()
    expect(resolveProfile({ providerID: "relay", apiID: "", catalog }).context).toBeUndefined()
  })

  test("does not lend reasoning controls, but an existing entry of the same provider keeps them", () => {
    const withControls = catalogOf({
      zhipuai: [
        entry("glm-5.3", {
          canonical_model_id: "zhipuai/glm-5.3",
          reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
        }),
      ],
    })
    const aliased = resolveProfile({ providerID: "relay", apiID: "glm-5.3", catalog: withControls })
    expect(aliased.reasoningMode.controls).toEqual([])
    expect(aliased.sources["reasoningMode.controls"]).toBeUndefined()

    const inherited = resolveProfile({
      providerID: "zhipuai",
      apiID: "glm-5.3",
      catalog: withControls,
      base: fromCatalogEntry(withControls.zhipuai.models["glm-5.3"]),
    })
    expect(inherited.reasoningMode.controls).toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high"] }])
    expect(inherited.sources["reasoningMode.controls"]).toBe("catalog")
  })

  test("is skipped when the base and config already declare every alias field", () => {
    let reads = 0
    const spy = new Proxy(catalog, {
      ownKeys(target) {
        reads += 1
        return Reflect.ownKeys(target)
      },
    })
    const base = fromCatalogEntry(aliasEntry("glm-5.3", "zhipuai/glm-5.3", 200_000))
    resolveProfile({ providerID: "zhipuai", apiID: "glm-5.3", catalog: spy, base })
    expect(reads).toBe(0)
    resolveProfile({ providerID: "zhipuai", apiID: "glm-5.3", catalog: spy })
    expect(reads).toBeGreaterThan(0)
  })
})

describe("vendor", () => {
  test("comes from the canonical name of the entry", () => {
    const base = fromCatalogEntry(entry("glm-5.3", { canonical_model_id: "ZhipuAI/glm-5.3" }))
    expect(base.vendor).toBe("zhipuai")
    expect(base.sources?.vendor).toBe("catalog")
    expect(resolveProfile({ providerID: "zhipuai", apiID: "glm-5.3", base }).vendor).toBe("zhipuai")
  })

  test("falls back to the part of the API id before the first slash, without a source", () => {
    const profile = resolveProfile({ providerID: "relay", apiID: "Moonshot/kimi-k2" })
    expect(profile.vendor).toBe("moonshot")
    expect(profile.sources.vendor).toBeUndefined()
    expect(resolveProfile({ providerID: "relay", apiID: "kimi-k2" }).vendor).toBeUndefined()
    expect(resolveProfile({ providerID: "relay", apiID: "/kimi-k2" }).vendor).toBeUndefined()
  })

  test("a configured vendor wins and is lowercased; an empty one is ignored", () => {
    const configured = resolveProfile({ providerID: "relay", apiID: "a/b", config: { profile: { vendor: "Acme" } } })
    expect(configured.vendor).toBe("acme")
    expect(configured.sources.vendor).toBe("config")
    expect(resolveProfile({ providerID: "relay", apiID: "a/b", config: { profile: { vendor: "" } } }).vendor).toBe("a")
  })

  test("a rule sees the vendor and may supply it before the fallback", () => {
    const seen: Array<string | undefined> = []
    const named: BuiltinRule = {
      name: "named",
      source: "test",
      match: (input) => {
        seen.push(input.vendor)
        return true
      },
      set: () => ({ vendor: "Named" }),
    }
    const profile = resolveProfile({ providerID: "relay", apiID: "a/b", rules: [named] })
    expect(seen).toEqual(["a"])
    expect(profile.vendor).toBe("named")
    expect(profile.sources.vendor).toBe("builtin:named")
  })
})

describe("fromCatalogEntry", () => {
  test("reads what the entry declares and nothing else", () => {
    const profile = fromCatalogEntry(
      entry("glm-5.3", {
        canonical_model_id: "zhipuai/glm-5.3",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1, max: 81_920 }],
        limit: { context: 200_000, output: 131_072 },
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    )
    expect(profile).toStrictEqual({
      context: 200_000,
      output: 131_072,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: true,
      vendor: "zhipuai",
      reasoningMode: {
        controls: [{ type: "toggle" }, { type: "budget_tokens", min: 1, max: 81_920 }],
        placeholder: false,
        replay: "none",
      },
      sources: {
        context: "catalog",
        output: "catalog",
        "modalities.input": "catalog",
        "modalities.output": "catalog",
        reasoning: "catalog",
        vendor: "catalog",
        "reasoningMode.controls": "catalog",
      },
    })
  })

  test("an entry without a canonical name, options or usable limits declares less", () => {
    const profile = fromCatalogEntry(entry("plain", { limit: { context: 0, output: 0 } }))
    expect(profile.vendor).toBeUndefined()
    expect(profile.context).toBeUndefined()
    expect(profile.output).toBeUndefined()
    expect(profile.reasoningMode).toBeUndefined()
    expect(Object.keys(profile.sources ?? {}).sort()).toEqual(["modalities.input", "modalities.output", "reasoning"])
  })

  test("keeps an empty reasoning_options: the model is known to have no control", () => {
    const profile = fromCatalogEntry(entry("none", { reasoning_options: [] }))
    expect(profile.reasoningMode?.controls).toEqual([])
    expect(profile.sources?.["reasoningMode.controls"]).toBe("catalog")
    const resolved = resolveProfile({ ...same, base: profile })
    expect(resolved.reasoningMode.controls).toEqual([])
    expect(resolved.sources["reasoningMode.controls"]).toBe("catalog")
  })

  test("reads a malformed entry defensively", () => {
    const malformed = parsed({
      ...entry("bad"),
      reasoning: "yes",
      reasoning_options: [
        { type: "toggle" },
        { type: "unknown" },
        { type: "effort" },
        { type: "effort", values: "high" },
        { type: "effort", values: [1, 2] },
        { type: "effort", values: [] },
        { type: "effort", values: ["low", "high"] },
        { type: "budget_tokens", min: "1", max: 100 },
        { type: "budget_tokens" },
        null,
        "toggle",
        7,
      ],
      modalities: { input: ["text", "file", "image", "image"], output: "text" },
      limit: { context: "200000", output: 1_000 },
    })
    const profile = fromCatalogEntry(malformed)
    expect(profile.reasoning).toBeUndefined()
    expect(profile.reasoningMode?.controls).toEqual([
      { type: "toggle" },
      { type: "effort", values: [] },
      { type: "effort", values: ["low", "high"] },
      { type: "budget_tokens", max: 100 },
      { type: "budget_tokens" },
    ])
    expect(profile.modalities?.input).toEqual(["text", "image"])
    expect(profile.sources?.["modalities.output"]).toBeUndefined()
    expect(profile.context).toBeUndefined()
    expect(profile.output).toBe(1_000)

    const notAnArray = fromCatalogEntry(parsed({ ...entry("odd"), reasoning_options: "toggle" }))
    expect(notAnArray.reasoningMode).toBeUndefined()
    expect(notAnArray.sources?.["reasoningMode.controls"]).toBeUndefined()

    expect(() => fromCatalogEntry(parsed(null))).not.toThrow()
    expect(fromCatalogEntry(parsed({})).sources).toEqual({})
  })
})

describe("built-in rules", () => {
  test("run in declaration order and only fill fields that have no source", () => {
    const profile = resolveProfile({
      ...same,
      apiID: "gpt-x",
      config: { profile: { cache_marker: "explicit" } },
      base: { toolResultMedia: "image", sources: { toolResultMedia: "catalog" } },
      rules: [
        rule("first", "gpt-", { editTools: "apply_patch", cacheMarker: "none", toolResultMedia: "all" }),
        rule("second", "gpt-", { editTools: "edit", userAfterToolResult: "bridge" }),
        rule("never", "claude-", { schemaFixes: ["openai"] }),
      ],
    })
    expect(profile.editTools).toBe("apply_patch")
    expect(profile.sources.editTools).toBe("builtin:first")
    expect(profile.cacheMarker).toBe("explicit")
    expect(profile.sources.cacheMarker).toBe("config")
    expect(profile.toolResultMedia).toBe("image")
    expect(profile.sources.toolResultMedia).toBe("catalog")
    expect(profile.userAfterToolResult).toBe("bridge")
    expect(profile.sources.userAfterToolResult).toBe("builtin:second")
    expect(profile.schemaFixes).toEqual([])
    expect(profile.sources.schemaFixes).toBeUndefined()
  })

  test("a partial reasoningMode fills only the sub-fields it names, one by one", () => {
    const profile = resolveProfile({
      ...same,
      rules: [
        rule("a", "m", { reasoningMode: { replay: "field" } }),
        rule("b", "m", { reasoningMode: { replay: "signed", placeholder: true, inlineTag: "think" } }),
      ],
    })
    expect(profile.reasoningMode).toEqual({ controls: [], placeholder: true, replay: "field", inlineTag: "think" })
    expect(profile.sources["reasoningMode.replay"]).toBe("builtin:a")
    expect(profile.sources["reasoningMode.placeholder"]).toBe("builtin:b")
    expect(profile.sources["reasoningMode.inlineTag"]).toBe("builtin:b")
    expect(profile.sources["reasoningMode.controls"]).toBeUndefined()
  })

  test("a rule reaching a capability removes it from missing", () => {
    const profile = resolveProfile({
      ...same,
      rules: [
        rule("caps", "m", {
          context: 64_000,
          reasoning: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        }),
      ],
    })
    expect(profile.missing).toEqual(["output"])
    expect(profile.sources["modalities.input"]).toBe("builtin:caps")
    expect(profile.sources["modalities.output"]).toBe("builtin:caps")
  })

  test("match receives only the inputs that are known, and set is called only on a match", () => {
    const inputs: unknown[] = []
    let sets = 0
    const probe: BuiltinRule = {
      name: "probe",
      source: "test",
      match: (input) => {
        inputs.push(input)
        return input.apiID === "hit"
      },
      set: () => {
        sets += 1
        return {}
      },
    }
    resolveProfile({ providerID: "relay", apiID: "miss", rules: [probe] })
    expect(sets).toBe(0)
    resolveProfile({
      providerID: "relay",
      apiID: "hit",
      npm: "@ai-sdk/openai-compatible",
      releaseDate: "2026-01-01",
      rules: [probe],
    })
    resolveProfile({ providerID: "relay", apiID: "hit", npm: "", releaseDate: "", rules: [probe] })
    expect(sets).toBe(2)
    expect(inputs).toEqual([
      { providerID: "relay", apiID: "miss" },
      { providerID: "relay", apiID: "hit", npm: "@ai-sdk/openai-compatible", releaseDate: "2026-01-01" },
      { providerID: "relay", apiID: "hit" },
    ])
  })

  test("a base field a rule produced is evaluated again for the new input", () => {
    const rules = [
      rule("gpt", "gpt-", { editTools: "apply_patch" }),
      rule("claude", "claude-", { cacheMarker: "explicit" }),
    ]
    const gpt = resolveProfile({ providerID: "relay", apiID: "gpt-4", rules })
    expect(gpt.editTools).toBe("apply_patch")
    const next = resolveProfile({ providerID: "relay", apiID: "claude-4", base: gpt, rules })
    expect(next.editTools).toBe("edit")
    expect(next.sources.editTools).toBeUndefined()
    expect(next.cacheMarker).toBe("explicit")
    expect(next.sources.cacheMarker).toBe("builtin:claude")
    // Fields from other sources are inherited as they are.
    const withCatalog = resolveProfile({
      providerID: "relay",
      apiID: "claude-4",
      base: { ...gpt, context: 7_000, sources: { ...gpt.sources, context: "catalog" } },
      rules,
    })
    expect(withCatalog.context).toBe(7_000)
    expect(withCatalog.sources.context).toBe("catalog")
  })

  test("every shipped rule obeys the table rules", () => {
    const names = BUILTIN_RULES.map((item) => item.name)
    expect(new Set(names).size).toBe(names.length)
    for (const item of BUILTIN_RULES) {
      expect(item.name).not.toBe("")
      expect(item.source).not.toBe("")
      expect(() => item.match({ providerID: "relay", apiID: "m" })).not.toThrow()
    }
  })

  test("resolveProfile reads BUILTIN_RULES when no rules are passed", () => {
    expect(resolveProfile({ providerID: "relay", apiID: "gpt-4" }).sources).toEqual({})
  })
})

describe("shipped rule edit-tools-apply-patch", () => {
  // The predicate the rule replaces: `usesApplyPatch` of packages/graphagent/src/tool/editing-tools.ts at 296a1a5d0.
  const replaced = (id: string) => id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4")
  const resolved = (apiID: string, extra: { config?: ProfileConfig; npm?: string } = {}) =>
    resolveProfile({ providerID: "openai", apiID, ...extra })
  const shipped = BUILTIN_RULES.find((item) => item.name === "edit-tools-apply-patch")

  test("is in the shipped table, once, and cites the code it replaces", () => {
    expect(shipped?.source).toBe("296a1a5d0:packages/graphagent/src/tool/editing-tools.ts:6")
    expect(BUILTIN_RULES.filter((item) => item.name === "edit-tools-apply-patch")).toHaveLength(1)
  })

  test("matches exactly the lowercase ids the replaced predicate matched", () => {
    const ids = [
      "gpt-5",
      "gpt-5.2",
      "gpt-5-codex",
      "gpt-5-mini",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "gpt-4",
      "gpt-4.1",
      "gpt-4o-mini",
      "gpt-3.5-turbo",
      "chatgpt-4o-latest",
      "gpt5",
      "o3",
      "claude-sonnet-4",
      "gemini-2.5-pro",
      "openai/gpt-5",
      "",
    ]
    const actual = ids.map((id): [string, string] => [id, resolved(id).editTools])
    const expected = ids.map((id): [string, string] => [id, replaced(id) ? "apply_patch" : "edit"])
    expect(actual).toEqual(expected)
    expect(replaced("gpt-5")).toBe(true)
  })

  test("reads the API id ignoring case", () => {
    for (const id of ["GPT-5", "Gpt-5-Codex", "GPT-5.2"]) expect(resolved(id).editTools).toBe("apply_patch")
    for (const id of ["GPT-OSS-120B", "GPT-4.1", "Claude-Sonnet-4"]) expect(resolved(id).editTools).toBe("edit")
  })

  test("needs only the API id: provider, npm and the rest of the input do not matter", () => {
    expect(shipped?.match({ providerID: "relay", apiID: "gpt-5" })).toBe(true)
    expect(shipped?.match({ providerID: "relay", apiID: "gpt-4.1" })).toBe(false)
    expect(resolved("gpt-5", { npm: "@ai-sdk/azure" }).editTools).toBe("apply_patch")
    expect(resolveProfile({ providerID: "azure", apiID: "gpt-5", npm: "@ai-sdk/openai-compatible" }).editTools).toBe(
      "apply_patch",
    )
  })

  test("records its name as the source, and a configured value wins", () => {
    const profile = resolved("gpt-5")
    expect(profile.sources.editTools).toBe("builtin:edit-tools-apply-patch")
    const configured = resolved("gpt-5", { config: { profile: { edit_tools: "edit" } } })
    expect(configured.editTools).toBe("edit")
    expect(configured.sources.editTools).toBe("config")
    const other = resolved("claude-sonnet-4")
    expect(other.editTools).toBe("edit")
    expect(other.sources.editTools).toBeUndefined()
  })
})

describe("shipped request shaping rules", () => {
  // The predicates and algorithms these rules replace, as they stood at 296a1a5d0 with the lookups lowercased (B1).
  const FAMILIES = ["mistral", "devstral", "codestral", "pixtral", "mixtral"]
  const isClaude = (apiID: string) => apiID.toLowerCase().includes("claude")
  const isMistral = (providerID: string, apiID: string) =>
    providerID === "mistral" || FAMILIES.some((family) => apiID.toLowerCase().includes(family))
  const isAnthropicCaching = (providerID: string, apiID: string, npm?: string) => {
    const id = apiID.toLowerCase()
    return (
      providerID === "anthropic" ||
      providerID === "google-vertex-anthropic" ||
      id.includes("anthropic") ||
      id.includes("claude") ||
      npm === "@ai-sdk/anthropic" ||
      npm === "@ai-sdk/alibaba"
    )
  }
  const GEMINI_SAMPLING = [
    /gemini-2[.-]5(?:[.-]|$)/,
    /gemini-3-(?:flash|pro)(?:[.-]|$)/,
    /gemini-3[.-]1(?:[.-]|$)/,
    /gemini-3[.-]5-flash(?!-lite)(?:[.-]|$)/,
  ]
  const temperature = (providerID: string, apiID: string) => {
    const id = apiID.toLowerCase()
    if (id.includes("north-mini-code")) return 1.0
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return GEMINI_SAMPLING.some((model) => model.test(id)) ? 1.0 : undefined
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) return 1.0
      return 0.6
    }
    return undefined
  }
  const topP = (providerID: string, apiID: string) => {
    const id = apiID.toLowerCase()
    if (id.includes("gemini")) return GEMINI_SAMPLING.some((model) => model.test(id)) ? 0.95 : undefined
    if (["minimax-m2", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) return 0.95
    if (
      ["deepseek-v4-flash-0731", "deepseek-v4-flash:0731"].some((name) => id.includes(name)) ||
      (id.includes("deepseek-v4-flash") && providerID === "deepseek")
    ) {
      return 0.95
    }
    return undefined
  }
  const topK = (providerID: string, apiID: string) => {
    const id = apiID.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
      return 20
    }
    if (id.includes("gemini")) return GEMINI_SAMPLING.some((model) => model.test(id)) ? 64 : undefined
    return undefined
  }
  const media = (npm: string | undefined, apiID: string, mime: string) => {
    if (npm === "@ai-sdk/anthropic") return true
    if (npm === "@ai-sdk/openai") return true
    if (npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (npm === "@ai-sdk/amazon-bedrock") return mime.startsWith("image/")
    if (npm === "@ai-sdk/xai") return mime.startsWith("image/")
    if (npm === "@ai-sdk/google-vertex/anthropic") return true
    if (npm === "@ai-sdk/google") {
      const id = apiID.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }
  /** What the profile says about one attachment: `all` sends everything inline, `image` only `image/*`. */
  const allows = (mode: ModelProfile["toolResultMedia"], mime: string) =>
    mode === "all" || (mode === "image" && mime.startsWith("image/"))

  const PROVIDERS = ["relay", "mistral", "anthropic", "google-vertex-anthropic", "deepseek", "openrouter", "google"]
  const NPMS = [
    undefined,
    "@ai-sdk/openai-compatible",
    "@ai-sdk/anthropic",
    "@ai-sdk/alibaba",
    "@ai-sdk/openai",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/amazon-bedrock/mantle",
    "@ai-sdk/xai",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex/anthropic",
    "@ai-sdk/gateway",
  ]
  const IDS = [
    "",
    "m",
    "gpt-5",
    "o3",
    "qwen3-max",
    "Qwen3.8-27B",
    "claude-sonnet-4",
    "Claude-Sonnet-4",
    "CLAUDE-OPUS-4-6",
    "anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-opus-4-6-v1",
    "arn:aws:bedrock:xxx:yyy:application-inference-profile/zzz",
    "anthropic/claude-sonnet-4",
    "claude-mistral-x",
    "mistral-large-latest",
    "Mistral-Large",
    "ministral-8b-latest",
    "devstral-small",
    "Codestral-Latest",
    "pixtral-large-latest",
    "open-mixtral-8x22b",
    "north-mini-code-1-0-latest",
    "North-Mini-Code-1-0-latest",
    "gemini-2.5-pro",
    "gemini-2-5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3-pro-image",
    "gemini-3.1-pro-preview",
    "gemini-3-1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3-5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-4-pro",
    "gemini-future",
    "Gemini-2.5-Pro",
    "google/gemini-2.5-flash",
    "glm-4.5",
    "glm-4.6",
    "GLM-4.6",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-5",
    "minimax-m2",
    "MiniMax-M2",
    "minimax-m2.1",
    "minimax-m21",
    "MiniMax-M2.5",
    "minimax-m25",
    "minimax-m3",
    "kimi-k2",
    "kimi-k2-0905-preview",
    "kimi-k2-thinking",
    "kimi-k2.5",
    "kimi-k2p5",
    "kimi-k2-5",
    "kimi-k2.6",
    "Kimi-K2.5",
    "kimi-k1.5",
    "moonshotai/kimi-k2.5",
    "deepseek-v4-flash",
    "deepseek-v4-flash-0731",
    "deepseek-v4-flash:0731",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash-0731",
    "deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-v4-pro",
  ]
  const resolved = (providerID: string, apiID: string, npm?: string) =>
    resolveProfile({ providerID, apiID, ...(npm === undefined ? {} : { npm }) })
  const shipped = (name: string) => BUILTIN_RULES.find((item) => item.name === name)

  test("each rule is shipped once, after edit-tools-apply-patch, and cites the code it replaces", () => {
    const names = BUILTIN_RULES.map((item) => item.name)
    expect(names).toEqual([
      "edit-tools-apply-patch",
      "tool-call-id-claude",
      "tool-call-id-mistral",
      "cache-marker-anthropic",
      "sampling-defaults",
      "tool-result-media",
    ])
    const transform = "296a1a5d0:packages/graphagent/src/provider/transform.ts"
    expect(shipped("tool-call-id-claude")?.source).toBe(`${transform}:101,238`)
    expect(shipped("tool-call-id-mistral")?.source).toBe(`${transform}:95,105,269`)
    expect(shipped("cache-marker-anthropic")?.source).toBe(`${transform}:748-751,754-755`)
    expect(shipped("sampling-defaults")?.source).toBe(`${transform}:794-845`)
    expect(shipped("tool-result-media")?.source).toBe("296a1a5d0:packages/graphagent/src/session/message-v2.ts:206-218")
  })

  test("a rule reads only the API id as a string; provider and npm are compared, never taken apart", () => {
    for (const name of [
      "tool-call-id-claude",
      "tool-call-id-mistral",
      "cache-marker-anthropic",
      "sampling-defaults",
      "tool-result-media",
    ]) {
      const rule = shipped(name)
      expect(rule).toBeDefined()
      // A fixture may lack the provider and the npm package; a rule must not throw on either.
      const noProvider: RuleInput = { providerID: "relay", apiID: "X" }
      Reflect.deleteProperty(noProvider, "providerID")
      expect(() => rule?.match(noProvider)).not.toThrow()
      expect(() => rule?.match({ providerID: "relay", apiID: "X" })).not.toThrow()
      expect(() => rule?.match({ providerID: "relay", apiID: "", npm: "" })).not.toThrow()
    }
  })

  test("tool-call-id-claude: alnum_dash for exactly the ids that name claude, ignoring case", () => {
    for (const id of IDS) {
      const profile = resolved("relay", id)
      expect(profile.toolCallId.charset === "alnum_dash").toBe(isClaude(id))
      if (isClaude(id)) {
        expect(profile.toolCallId).toEqual({ charset: "alnum_dash" })
        expect(profile.sources.toolCallId).toBe("builtin:tool-call-id-claude")
      }
    }
    expect(resolved("relay", "Claude-Sonnet-4").toolCallId).toEqual({ charset: "alnum_dash" })
    expect(resolved("relay", "gpt-5").toolCallId).toEqual({ charset: "any" })
  })

  test("tool-call-id-mistral: alnum of length 9 and a bridge for exactly the Mistral family", () => {
    for (const providerID of PROVIDERS) {
      for (const id of IDS) {
        const profile = resolved(providerID, id)
        expect(profile.userAfterToolResult).toBe(isMistral(providerID, id) ? "bridge" : "allow")
        if (isMistral(providerID, id) && !isClaude(id)) {
          expect(profile.toolCallId).toEqual({ charset: "alnum", length: 9 })
          expect(profile.sources.toolCallId).toBe("builtin:tool-call-id-mistral")
        }
        if (isMistral(providerID, id)) expect(profile.sources.userAfterToolResult).toBe("builtin:tool-call-id-mistral")
      }
    }
    // The first rule that names toolCallId wins, so a Claude id keeps alnum_dash while the bridge still applies.
    const both = resolved("relay", "claude-mistral-x")
    expect(both.toolCallId).toEqual({ charset: "alnum_dash" })
    expect(both.userAfterToolResult).toBe("bridge")
    expect(resolved("mistral", "anything").toolCallId).toEqual({ charset: "alnum", length: 9 })
    expect(resolved("relay", "Codestral-Latest").toolCallId).toEqual({ charset: "alnum", length: 9 })
  })

  test("cache-marker-anthropic: explicit for the union of the replaced provider, id and npm conditions", () => {
    for (const providerID of PROVIDERS) {
      for (const npm of NPMS) {
        for (const id of IDS) {
          const profile = resolved(providerID, id, npm)
          expect(profile.cacheMarker).toBe(isAnthropicCaching(providerID, id, npm) ? "explicit" : "none")
        }
      }
    }
    // The configuration keys the old code also read stay in the reader, not in the rule.
    expect(resolved("relay", "qwen3-max").sources.cacheMarker).toBeUndefined()
    expect(resolved("relay", "Claude-Sonnet-4", "@ai-sdk/openai-compatible").sources.cacheMarker).toBe(
      "builtin:cache-marker-anthropic",
    )
  })

  test("sampling-defaults: the values of the replaced temperature, topP and topK, for every provider and id", () => {
    for (const providerID of PROVIDERS) {
      for (const id of IDS) {
        const profile = resolved(providerID, id)
        const expected = {
          temperature: temperature(providerID, id),
          topP: topP(providerID, id),
          topK: topK(providerID, id),
        }
        expect({ ...profile.sampling }).toEqual(expected)
        const any = Object.values(expected).some((value) => value !== undefined)
        // No branch names the model: the rule does not match and leaves the field without a source.
        expect<string | undefined>(profile.sources.sampling).toBe(any ? "builtin:sampling-defaults" : undefined)
      }
    }
    // Keys with an undefined value are left out, so the profile never carries them.
    expect(resolved("relay", "kimi-k2").sampling).toEqual({ temperature: 0.6 })
    expect(Object.keys(resolved("relay", "kimi-k2").sampling)).toEqual(["temperature"])
    expect(resolved("relay", "gpt-5").sampling).toEqual({})
  })

  test("sampling-defaults: a configured block replaces the rule as a whole", () => {
    const config: ProfileConfig = { profile: { sampling: { top_p: 0.5 } } }
    const profile = resolveProfile({ providerID: "relay", apiID: "kimi-k2.5", config })
    expect(profile.sampling).toEqual({ topP: 0.5 })
    expect(profile.sources.sampling).toBe("config")
    expect(
      resolveProfile({ providerID: "relay", apiID: "gemini-2.5-pro", config: { profile: { sampling: {} } } }).sampling,
    ).toEqual({})
  })

  test("tool-result-media: all, image or none exactly as the replaced npm branches decided", () => {
    const mimes = ["image/png", "image/jpeg", "application/pdf", "audio/mpeg", "video/mp4"]
    for (const npm of NPMS) {
      for (const id of IDS) {
        const profile = resolved("relay", id, npm)
        for (const mime of mimes) expect(allows(profile.toolResultMedia, mime)).toBe(media(npm, id, mime))
        if (profile.toolResultMedia === "none") expect(profile.sources.toolResultMedia).toBeUndefined()
        else expect(profile.sources.toolResultMedia).toBe("builtin:tool-result-media")
      }
    }
    expect(resolved("relay", "x", "@ai-sdk/anthropic").toolResultMedia).toBe("all")
    expect(resolved("relay", "x", "@ai-sdk/openai").toolResultMedia).toBe("all")
    expect(resolved("relay", "x", "@ai-sdk/amazon-bedrock/mantle").toolResultMedia).toBe("all")
    expect(resolved("relay", "x", "@ai-sdk/google-vertex/anthropic").toolResultMedia).toBe("all")
    expect(resolved("relay", "x", "@ai-sdk/amazon-bedrock").toolResultMedia).toBe("image")
    expect(resolved("relay", "x", "@ai-sdk/xai").toolResultMedia).toBe("image")
    expect(resolved("relay", "x", "@ai-sdk/openai-compatible").toolResultMedia).toBe("none")
  })

  test("tool-result-media: google gives all only for gemini-3 ids that do not name gemini-2", () => {
    const google = (apiID: string) => resolved("google", apiID, "@ai-sdk/google").toolResultMedia
    expect(google("gemini-3-pro-preview")).toBe("all")
    expect(google("Gemini-3.1-Pro")).toBe("all")
    expect(google("gemini-2.5-pro")).toBe("none")
    expect(google("gemini-3-and-gemini-2")).toBe("none")
    expect(google("gemma-3")).toBe("none")
    expect(resolved("google", "gemini-3-pro-preview", "@ai-sdk/openai-compatible").toolResultMedia).toBe("none")
  })

  test("a configured value wins over each of these rules", () => {
    const profile = resolveProfile({
      providerID: "mistral",
      apiID: "Claude-Mistral",
      npm: "@ai-sdk/anthropic",
      config: {
        profile: {
          tool_call_id: { charset: "any" },
          user_after_tool_result: "allow",
          cache_marker: "none",
          tool_result_media: "none",
          sampling: { temperature: 0.3 },
        },
      },
    })
    expect(profile.toolCallId).toEqual({ charset: "any" })
    expect(profile.userAfterToolResult).toBe("allow")
    expect(profile.cacheMarker).toBe("none")
    expect(profile.toolResultMedia).toBe("none")
    expect(profile.sampling).toEqual({ temperature: 0.3 })
    for (const key of ["toolCallId", "userAfterToolResult", "cacheMarker", "toolResultMedia", "sampling"]) {
      expect(profile.sources[key]).toBe("config")
    }
  })
})

describe("resolveProfile isolation", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) deepFreeze(item)
      Object.freeze(value)
    }
    return value
  }

  test("does not modify its inputs and shares no array or object with them", () => {
    const catalog = deepFreeze(
      catalogOf({
        other: [entry("m", { canonical_model_id: "v/m", modalities: { input: ["text", "image"], output: ["text"] } })],
      }),
    )
    const base = deepFreeze({
      ...fromCatalogEntry(entry("m", { reasoning_options: [{ type: "effort", values: ["low"] }] })),
    })
    const config = deepFreeze<ProfileConfig>({
      modalities: { input: ["text", "pdf"] },
      profile: {
        sampling: { temperature: 0.5 },
        finish_reasons: { x: "stream_error" },
        reasoning_mode: { toggle: { on: { a: { b: 1 } }, off: { a: { b: 2 } } } },
        schema_fixes: ["openai"],
      },
    })
    const rules = [
      deepFreeze(rule("r", "m", { toolLimits: { maxTools: 3 }, reasoningMode: { controls: [{ type: "toggle" }] } })),
    ]
    const profile = resolveProfile({ ...same, base, config, catalog, rules })
    expect(profile.modalities.input).toEqual(["text", "pdf"])
    expect(profile.modalities.input).not.toBe(config.modalities?.input as unknown)
    expect(profile.reasoningMode.controls).toEqual([{ type: "effort", values: ["low"] }])
    expect(profile.reasoningMode.controls).not.toBe(base.reasoningMode?.controls as unknown)
    expect(profile.reasoningMode.toggle?.on).not.toBe(config.profile?.reasoning_mode?.toggle?.on as unknown)
    expect(profile.schemaFixes).not.toBe(config.profile?.schema_fixes as unknown)
    expect(profile.toolLimits).toStrictEqual({ maxTools: 3 })

    // Changing the result leaves the inputs, and a second resolution, alone.
    profile.modalities.input.push("audio")
    profile.reasoningMode.controls.push({ type: "toggle" })
    expect(resolveProfile({ ...same, base, config, catalog, rules }).modalities.input).toEqual(["text", "pdf"])
  })
})

describe("contextWindow", () => {
  test("returns the declared window with its source", () => {
    const profile = resolveProfile({ ...same, config: { limit: { context: 200_000 } } })
    expect(contextWindow(profile)).toEqual({ tokens: 200_000, source: "config" })
  })

  test("returns the default window and the source default when none is declared", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000)
    expect(contextWindow(resolveProfile(same))).toEqual({ tokens: 128_000, source: "default" })
    expect(contextWindow({ sources: {} })).toEqual({ tokens: 128_000, source: "default" })
  })

  test("treats a window that cannot be one as undeclared", () => {
    for (const context of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextWindow({ context, sources: { context: "config" } })).toEqual({ tokens: 128_000, source: "default" })
    }
  })

  test("names an unknown source when a hand-built profile has a window but no source", () => {
    expect(contextWindow({ context: 32_000, sources: {} })).toEqual({ tokens: 32_000, source: "unknown" })
  })
})

describe("module boundary", () => {
  const read = (name: string) => readFileSync(path.join(import.meta.dir, "../src", name), "utf8")

  test("the profile modules do not import the AI SDK, and import the catalog for types only", () => {
    for (const file of ["model-profile.ts", "model-profile-builtin.ts"]) {
      const source = read(file)
      expect(source).not.toMatch(/from "(ai|@ai-sdk\/[^"]*)"/)
      expect(source).not.toMatch(/^import (?!type\b)[^\n]*from "\.\/models-dev"/m)
    }
    expect(read("model-profile-builtin.ts")).not.toMatch(/^import (?!type\b)[^\n]*from "\.\/model-profile"/m)
  })
})
