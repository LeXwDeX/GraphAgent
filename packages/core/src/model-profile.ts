// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema } from "effect"
import { BUILTIN_RULES } from "./model-profile-builtin"
import type { Model as CatalogModel, Provider as CatalogProvider } from "./models-dev"
import { optionalOmitUndefined, PositiveInt } from "./schema"

/**
 * Model capability profile: the single source of truth for what a model can do.
 *
 * `resolveProfile` merges the sources in a fixed order (config, an existing entry, a catalog alias, built-in
 * rules, defaults) and records where each field came from in `sources`. A capability no source declares is
 * reported in `missing` instead of being recorded as 0 or false. Nothing here guesses: an absent value stays
 * absent until a source declares it.
 *
 * This module must stay free of `ai` and `@ai-sdk/*`, and imports `models-dev.ts` for types only.
 */

/** Window assumed when no source declares one. Read it through `contextWindow`, never directly. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

export const Modality = Schema.Literals(["text", "audio", "image", "video", "pdf"])
export type Modality = typeof Modality.Type

/** A reasoning control published by the catalog (`reasoning_options`) or declared in the configuration. */
export const ReasoningControl = Schema.Union([
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.mutable(Schema.Array(Schema.String)) }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
]).annotate({ identifier: "ReasoningControl" })
export type ReasoningControl = typeof ReasoningControl.Type

const ToolCallCharset = Schema.Literals(["any", "alnum_dash", "alnum"])
const UserAfterToolResult = Schema.Literals(["allow", "bridge"])
const ToolResultMedia = Schema.Literals(["all", "image", "none"])
const CacheMarker = Schema.Literals(["explicit", "none"])
const ReasoningReplay = Schema.Literals(["none", "field", "signed", "encrypted"])
const FinishReason = Schema.Literals(["content-filter", "stream_error", "context_overflow"])
const EditTools = Schema.Literals(["edit", "apply_patch"])
const SchemaFix = Schema.Literals(["openai", "moonshot", "gemini"])
const MissingField = Schema.Literals(["context", "output", "modalities", "reasoning"])

/** The resolved profile of one model. Fields without any source hold the missing value stated per field. */
export const ModelProfile = Schema.Struct({
  /** Context window in tokens. Read it through `contextWindow`. */
  context: optionalOmitUndefined(Schema.Finite),
  /** Output limit in tokens. */
  output: optionalOmitUndefined(Schema.Finite),
  modalities: Schema.Struct({
    input: Schema.mutable(Schema.Array(Modality)),
    output: Schema.mutable(Schema.Array(Modality)),
  }),
  reasoning: Schema.Boolean,
  /** Lowercase vendor name, for example `zhipuai`. */
  vendor: optionalOmitUndefined(Schema.String),
  /** Effective window for compaction; readers use the smaller of this and the window. */
  effectiveContext: optionalOmitUndefined(Schema.Finite),
  toolCallId: Schema.Struct({
    charset: ToolCallCharset,
    length: optionalOmitUndefined(Schema.Finite),
  }),
  userAfterToolResult: UserAfterToolResult,
  toolResultMedia: ToolResultMedia,
  cacheMarker: CacheMarker,
  reasoningMode: Schema.Struct({
    /** `sources` without this key means unknown; the key with an empty list means known to have no control. */
    controls: Schema.mutable(Schema.Array(ReasoningControl)),
    // `any`, not `unknown`: Types.DeepMutable widens an unknown value to `{}`, which a profile held by
    // the provider's Model type could then not be assigned to.
    toggle: optionalOmitUndefined(
      Schema.Struct({
        on: Schema.Record(Schema.String, Schema.Any),
        off: Schema.Record(Schema.String, Schema.Any),
      }),
    ),
    placeholder: Schema.Boolean,
    replay: ReasoningReplay,
    inlineTag: optionalOmitUndefined(Schema.String),
  }),
  sampling: Schema.Struct({
    temperature: optionalOmitUndefined(Schema.Finite),
    topP: optionalOmitUndefined(Schema.Finite),
    topK: optionalOmitUndefined(Schema.Finite),
  }),
  finishReasons: Schema.Record(Schema.String, FinishReason),
  editTools: EditTools,
  toolLimits: Schema.Struct({
    maxTools: optionalOmitUndefined(Schema.Finite),
    nameMaxLength: optionalOmitUndefined(Schema.Finite),
    namePattern: optionalOmitUndefined(Schema.String),
  }),
  schemaFixes: Schema.mutable(Schema.Array(SchemaFix)),
  /** Field name to origin, only for fields with one. Sub-fields use a dotted path, such as `modalities.input`. */
  sources: Schema.Record(Schema.String, Schema.String),
  /** The listed capabilities have no source at all. `modalities` only looks at `modalities.input`. */
  missing: Schema.mutable(Schema.Array(MissingField)),
}).annotate({ identifier: "ModelProfile" })
export type ModelProfile = typeof ModelProfile.Type

/**
 * Configuration side of the profile: `provider.<id>.models.<id>.profile`.
 * `limit`, `modalities` and `reasoning` keep their existing place beside it.
 */
export const ModelProfileOverride = Schema.Struct({
  vendor: Schema.optional(Schema.String).annotate({
    description:
      "Lowercase vendor of the model, for example zhipuai. Defaults to the vendor of the matching catalog entry, then to the part of the API model id before the first slash.",
  }),
  effective_context: Schema.optional(PositiveInt).annotate({
    description:
      "Effective context window in tokens used for compaction. Compaction uses the smaller of this value and the context window.",
  }),
  tool_call_id: Schema.optional(
    Schema.Struct({
      charset: ToolCallCharset.annotate({
        description: "Characters a tool call id may contain: any, alnum_dash ([A-Za-z0-9_-]) or alnum ([A-Za-z0-9]).",
      }),
      length: Schema.optional(PositiveInt).annotate({
        description: "Fixed length of a tool call id. Only meaningful with the alnum charset.",
      }),
    }),
  ).annotate({
    description:
      "Constraint on the tool call ids the provider accepts. Default: any; built-in rules give alnum_dash to Claude models and alnum of length 9 to Mistral models.",
  }),
  user_after_tool_result: Schema.optional(UserAfterToolResult).annotate({
    description:
      "Whether a user message may follow a tool result directly. bridge inserts a short assistant message first. Default: allow; a built-in rule gives bridge to Mistral models.",
  }),
  tool_result_media: Schema.optional(ToolResultMedia).annotate({
    description:
      "Which tool result attachments are sent inside the tool result: all, image (only image/*) or none (sent as a synthetic user message). Default: none; built-in rules give all or image to models served through some provider SDK packages, such as Anthropic and OpenAI.",
  }),
  cache_marker: Schema.optional(CacheMarker).annotate({
    description:
      "Whether to place explicit cache breakpoints in the request: explicit or none. Default: none; built-in rules give explicit to Anthropic and Claude models and to models served through the Anthropic or Alibaba SDK packages.",
  }),
  reasoning_mode: Schema.optional(
    Schema.Struct({
      controls: Schema.optional(Schema.mutable(Schema.Array(ReasoningControl))).annotate({
        description:
          "Reasoning controls the model exposes: toggle, effort levels or a token budget. An empty list declares that the model has none.",
      }),
      toggle: Schema.optional(
        Schema.Struct({
          on: Schema.Record(Schema.String, Schema.Unknown),
          off: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ).annotate({
        description: "Request body fragments merged into the request to turn thinking on and off.",
      }),
      placeholder: Schema.optional(Schema.Boolean).annotate({
        description:
          "Add an empty reasoning string to assistant messages that carry none. Default: false; a built-in rule gives true to DeepSeek models.",
      }),
      replay: Schema.optional(ReasoningReplay).annotate({
        description:
          "How earlier reasoning is sent back: none, field (the field named by interleaved), signed (signed blocks as received) or encrypted (encrypted content as received). Default: none.",
      }),
      inline_tag: Schema.optional(Schema.String).annotate({
        description:
          "Tag name that wraps reasoning inside the message text, for example think. Default: none, unless a built-in rule names one for the model; an empty string turns it off even then.",
      }),
    }),
  ).annotate({
    description: "How the model's reasoning is controlled and replayed. Each key replaces its own source.",
  }),
  sampling: Schema.optional(
    Schema.Struct({
      temperature: Schema.optional(Schema.Finite),
      top_p: Schema.optional(Schema.Finite),
      top_k: Schema.optional(Schema.Finite),
    }),
  ).annotate({
    description:
      "Default sampling values for the model. This block replaces the built-in values as a whole, so a value left out of it is not sent. Without the block, built-in rules give some models the values their vendor recommends; the others have no default.",
  }),
  finish_reasons: Schema.optional(Schema.Record(Schema.String, FinishReason)).annotate({
    description:
      "Maps a vendor finish_reason to how it is handled: content-filter, stream_error (retry as a broken stream) or context_overflow.",
  }),
  edit_tools: Schema.optional(EditTools).annotate({
    description:
      "Edit tool family offered to the model: edit or apply_patch. Default: edit; a built-in rule gives apply_patch to GPT models other than gpt-4 and gpt-oss.",
  }),
  tool_limits: Schema.optional(
    Schema.Struct({
      max_tools: Schema.optional(PositiveInt),
      name_max_length: Schema.optional(PositiveInt),
      name_pattern: Schema.optional(Schema.String),
    }),
  ).annotate({
    description:
      "Limits on the tools sent to the model: maximum tool count, maximum function name length and the regular expression source a function name must match. Default: no limit.",
  }),
  schema_fixes: Schema.optional(Schema.mutable(Schema.Array(SchemaFix))).annotate({
    description:
      "Downgrade schemes applied to tool schemas: openai, moonshot or gemini. Default: none; built-in rules give openai to the OpenAI and Azure SDK packages, moonshot to Moonshot and Kimi models and gemini to Google and Gemini models. An empty list switches them all off.",
  }),
}).annotate({ identifier: "ModelProfileOverride" })
export type ModelProfileOverride = typeof ModelProfileOverride.Type

/** What a rule matches on. `npm`, `releaseDate` and `vendor` may be missing. */
export type RuleInput = { providerID: string; apiID: string; npm?: string; releaseDate?: string; vendor?: string }

/** The fields a rule fills. It never carries `sources` or `missing`, and `reasoningMode` may be partial. */
export type ProfilePatch = Partial<Omit<ModelProfile, "sources" | "missing" | "reasoningMode">> & {
  reasoningMode?: Partial<ModelProfile["reasoningMode"]>
}

export type BuiltinRule = {
  /** Unique across the table; recorded as `builtin:<name>` in `sources`. */
  name: string
  /** Documentation link, or `<commit>:<file>:<line>` of the code the rule replaces. */
  source: string
  match(input: RuleInput): boolean
  set(input: RuleInput): ProfilePatch
}

/** The configuration entry of one model, as far as the profile reads it. */
export type ProfileConfig = {
  limit?: { context?: number; output?: number }
  modalities?: { input?: ReadonlyArray<Modality>; output?: ReadonlyArray<Modality> }
  reasoning?: boolean
  profile?: ModelProfileOverride
}

export type ResolveInput = {
  providerID: string
  /** The id sent to the provider. */
  apiID: string
  npm?: string
  releaseDate?: string
  /** Profile of an existing entry of the same provider. Only its fields that have a source are taken. */
  base?: Partial<ModelProfile>
  config?: ProfileConfig
  /** The catalog to look aliases up in. Without it no alias applies. */
  catalog?: Record<string, CatalogProvider>
  /** Defaults to `BUILTIN_RULES`. */
  rules?: ReadonlyArray<BuiltinRule>
}

/**
 * The context window to read, with where it came from. A profile without a usable `context` yields the default
 * window and the source `default`, so callers never see a 0.
 */
export function contextWindow(profile: Pick<ModelProfile, "context" | "sources">): { tokens: number; source: string } {
  const tokens = positive(profile.context)
  if (tokens === undefined) return { tokens: DEFAULT_CONTEXT_WINDOW, source: "default" }
  return { tokens, source: profile.sources.context ?? "unknown" }
}

/**
 * The window compaction is judged against, with where it came from: `contextWindow`, narrowed to `effectiveContext`
 * when that is positive and smaller. A larger or absent effective window changes nothing, so the source stays that of
 * the window itself, `default` included.
 */
export function compactionWindow(profile: Pick<ModelProfile, "context" | "sources" | "effectiveContext">): {
  tokens: number
  source: string
} {
  const window = contextWindow(profile)
  const effective = positive(profile.effectiveContext)
  if (effective !== undefined && effective < window.tokens) return { tokens: effective, source: "config" }
  return window
}

type Values = {
  context: number
  output: number
  "modalities.input": Modality[]
  "modalities.output": Modality[]
  reasoning: boolean
  vendor: string
  effectiveContext: number
  toolCallId: ModelProfile["toolCallId"]
  userAfterToolResult: ModelProfile["userAfterToolResult"]
  toolResultMedia: ModelProfile["toolResultMedia"]
  cacheMarker: ModelProfile["cacheMarker"]
  "reasoningMode.controls": ReasoningControl[]
  "reasoningMode.toggle": NonNullable<ModelProfile["reasoningMode"]["toggle"]>
  "reasoningMode.placeholder": boolean
  "reasoningMode.replay": ModelProfile["reasoningMode"]["replay"]
  "reasoningMode.inlineTag": string
  sampling: ModelProfile["sampling"]
  finishReasons: ModelProfile["finishReasons"]
  editTools: ModelProfile["editTools"]
  toolLimits: ModelProfile["toolLimits"]
  schemaFixes: ModelProfile["schemaFixes"]
}
type Key = keyof Values
/** The unit that sources compete on: one field, or one direction of the modalities. */
type Entries = { [K in Key]?: { value: Values[K]; source: string } }
type Patch = Omit<ProfilePatch, "modalities"> & {
  modalities?: { input?: ReadonlyArray<Modality>; output?: ReadonlyArray<Modality> }
}

const KEYS: ReadonlyArray<Key> = [
  "context",
  "output",
  "modalities.input",
  "modalities.output",
  "reasoning",
  "vendor",
  "effectiveContext",
  "toolCallId",
  "userAfterToolResult",
  "toolResultMedia",
  "cacheMarker",
  "reasoningMode.controls",
  "reasoningMode.toggle",
  "reasoningMode.placeholder",
  "reasoningMode.replay",
  "reasoningMode.inlineTag",
  "sampling",
  "finishReasons",
  "editTools",
  "toolLimits",
  "schemaFixes",
]

/** What a catalog entry of another provider may lend. It never lends `reasoning_options`. */
const ALIAS_KEYS: ReadonlyArray<Key> = [
  "context",
  "output",
  "modalities.input",
  "modalities.output",
  "reasoning",
  "vendor",
]

const MISSING_CHECKS = [
  ["context", "context"],
  ["output", "output"],
  ["modalities", "modalities.input"],
  ["reasoning", "reasoning"],
] as const

const MODALITIES: ReadonlySet<string> = new Set(["text", "audio", "image", "video", "pdf"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * A deep copy of plain data, so a profile never shares an array or object with the source it came from.
 * A key whose value is undefined is left out, as it would be in JSON.
 */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => clone(item))
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return Object.fromEntries(entries.map(([key, item]) => [key, clone(item)]))
  }
  return value
}

/** The part before the first `/`, lowercased. */
function vendorOf(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined
  const slash = id.indexOf("/")
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined
}

function modalityList(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const known = value.filter((item): item is Modality => typeof item === "string" && MODALITIES.has(item))
  return [...new Set(known)]
}

function reasoningControl(item: unknown): ReasoningControl | undefined {
  if (!isRecord(item)) return undefined
  if (item.type === "toggle") return { type: "toggle" }
  if (item.type === "effort") {
    const values = item.values
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return undefined
    return { type: "effort", values: [...values] }
  }
  if (item.type === "budget_tokens") {
    const min = typeof item.min === "number" && Number.isFinite(item.min) ? item.min : undefined
    const max = typeof item.max === "number" && Number.isFinite(item.max) ? item.max : undefined
    return { type: "budget_tokens", ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
  }
  return undefined
}

function reasoningControls(value: unknown): ReasoningControl[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    const control = reasoningControl(item)
    return control ? [control] : []
  })
}

/** The profile fields a catalog entry declares. The catalog is not decoded at runtime, so every read is defensive. */
function catalogPatch(entry: CatalogModel): Patch {
  const raw: Record<string, unknown> = isRecord(entry) ? entry : {}
  const limit = isRecord(raw.limit) ? raw.limit : {}
  const modalities = isRecord(raw.modalities) ? raw.modalities : {}
  return {
    context: positive(limit.context),
    output: positive(limit.output),
    modalities: { input: modalityList(modalities.input), output: modalityList(modalities.output) },
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
    vendor: vendorOf(raw.canonical_model_id),
    reasoningMode: { controls: reasoningControls(raw.reasoning_options) },
  }
}

function configPatch(config: ProfileConfig): Patch {
  const profile = config.profile
  const mode = profile?.reasoning_mode
  const sampling = profile?.sampling
  const limits = profile?.tool_limits
  return {
    context: config.limit?.context,
    output: config.limit?.output,
    modalities: config.modalities,
    reasoning: config.reasoning,
    vendor: profile?.vendor,
    effectiveContext: profile?.effective_context,
    toolCallId: profile?.tool_call_id,
    userAfterToolResult: profile?.user_after_tool_result,
    toolResultMedia: profile?.tool_result_media,
    cacheMarker: profile?.cache_marker,
    reasoningMode: mode && {
      controls: mode.controls,
      toggle: mode.toggle,
      placeholder: mode.placeholder,
      replay: mode.replay,
      inlineTag: mode.inline_tag,
    },
    sampling: sampling && { temperature: sampling.temperature, topP: sampling.top_p, topK: sampling.top_k },
    finishReasons: profile?.finish_reasons,
    editTools: profile?.edit_tools,
    toolLimits: limits && {
      maxTools: limits.max_tools,
      nameMaxLength: limits.name_max_length,
      namePattern: limits.name_pattern,
    },
    schemaFixes: profile?.schema_fixes,
  }
}

/** A number that cannot be a window, or an empty vendor, counts as no value; the rest is copied. */
function clean(key: Key, value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (key === "context" || key === "output") return positive(value)
  if (key === "effectiveContext") return Number.isInteger(value) ? positive(value) : undefined
  if (key === "vendor") return typeof value === "string" && value !== "" ? value.toLowerCase() : undefined
  return clone(value)
}

/** Turns a patch into entries. A key without a source (`sourceOf` returns undefined) or without a value is left out. */
function flatten(patch: Patch, sourceOf: (key: Key) => string | undefined): Entries {
  const raw: Record<Key, unknown> = {
    context: patch.context,
    output: patch.output,
    "modalities.input": patch.modalities?.input,
    "modalities.output": patch.modalities?.output,
    reasoning: patch.reasoning,
    vendor: patch.vendor,
    effectiveContext: patch.effectiveContext,
    toolCallId: patch.toolCallId,
    userAfterToolResult: patch.userAfterToolResult,
    toolResultMedia: patch.toolResultMedia,
    cacheMarker: patch.cacheMarker,
    "reasoningMode.controls": patch.reasoningMode?.controls,
    "reasoningMode.toggle": patch.reasoningMode?.toggle,
    "reasoningMode.placeholder": patch.reasoningMode?.placeholder,
    "reasoningMode.replay": patch.reasoningMode?.replay,
    "reasoningMode.inlineTag": patch.reasoningMode?.inlineTag,
    sampling: patch.sampling,
    finishReasons: patch.finishReasons,
    editTools: patch.editTools,
    toolLimits: patch.toolLimits,
    schemaFixes: patch.schemaFixes,
  }
  const entries: Record<string, unknown> = {}
  for (const key of KEYS) {
    const source = sourceOf(key)
    if (source === undefined) continue
    const value = clean(key, raw[key])
    if (value !== undefined) entries[key] = { value, source }
  }
  return entries as Entries
}

/** Adds the entries of `from` for the keys `into` does not have yet, so earlier sources win. */
function fill(into: Entries, from: Entries) {
  const target: Record<string, unknown> = into
  for (const key of KEYS) {
    if (target[key] === undefined && from[key] !== undefined) target[key] = from[key]
  }
}

/** The origin a base field is inherited with; a built-in rule result is dropped and evaluated again. */
function inherited(source: string | undefined) {
  return source !== undefined && !source.startsWith("builtin:") ? source : undefined
}

/** The catalog entry of any provider that names the same model: by id first, then by canonical name. */
function findAlias(catalog: Record<string, CatalogProvider>, apiID: string): CatalogModel | undefined {
  const wanted = apiID.toLowerCase()
  if (wanted === "") return undefined
  const suffix = `/${wanted}`
  type Hit = { provider: string; key: string; entry: CatalogModel }
  const earlier = (current: Hit | undefined, next: Hit) =>
    !current || next.provider < current.provider || (next.provider === current.provider && next.key < current.key)
      ? next
      : current
  let byId: Hit | undefined
  let byCanonical: Hit | undefined
  for (const [provider, item] of Object.entries(catalog)) {
    for (const [key, entry] of Object.entries(item?.models ?? {})) {
      if (typeof entry?.id === "string" && entry.id.toLowerCase() === wanted) {
        byId = earlier(byId, { provider, key, entry })
        continue
      }
      const canonical = typeof entry?.canonical_model_id === "string" ? entry.canonical_model_id.toLowerCase() : ""
      if (canonical === wanted || canonical.endsWith(suffix))
        byCanonical = earlier(byCanonical, { provider, key, entry })
    }
  }
  return (byId ?? byCanonical)?.entry
}

function applyRules(entries: Entries, rules: ReadonlyArray<BuiltinRule>, input: RuleInput) {
  for (const rule of rules) {
    if (!rule.match(input)) continue
    const source = `builtin:${rule.name}`
    fill(
      entries,
      flatten(rule.set(input), () => source),
    )
  }
}

function sourcesOf(entries: Entries): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const key of KEYS) {
    const entry = entries[key]
    if (entry) sources[key] = entry.source
  }
  return sources
}

/** Builds the profile from the winning entries; whatever has no entry takes the missing value. */
function build(entries: Entries, apiID: string): ModelProfile {
  const read = <K extends Key>(key: K): Values[K] | undefined => entries[key]?.value
  const context = read("context")
  const output = read("output")
  const vendor = read("vendor") ?? vendorOf(apiID)
  const effectiveContext = read("effectiveContext")
  const toggle = read("reasoningMode.toggle")
  const inlineTag = read("reasoningMode.inlineTag")
  return {
    ...(context === undefined ? {} : { context }),
    ...(output === undefined ? {} : { output }),
    modalities: { input: read("modalities.input") ?? ["text"], output: read("modalities.output") ?? ["text"] },
    reasoning: read("reasoning") ?? false,
    ...(vendor === undefined ? {} : { vendor }),
    ...(effectiveContext === undefined ? {} : { effectiveContext }),
    toolCallId: read("toolCallId") ?? { charset: "any" },
    userAfterToolResult: read("userAfterToolResult") ?? "allow",
    toolResultMedia: read("toolResultMedia") ?? "none",
    cacheMarker: read("cacheMarker") ?? "none",
    reasoningMode: {
      controls: read("reasoningMode.controls") ?? [],
      ...(toggle === undefined ? {} : { toggle }),
      placeholder: read("reasoningMode.placeholder") ?? false,
      replay: read("reasoningMode.replay") ?? "none",
      ...(inlineTag === undefined ? {} : { inlineTag }),
    },
    sampling: read("sampling") ?? {},
    finishReasons: read("finishReasons") ?? {},
    editTools: read("editTools") ?? "edit",
    toolLimits: read("toolLimits") ?? {},
    schemaFixes: read("schemaFixes") ?? [],
    sources: sourcesOf(entries),
    missing: MISSING_CHECKS.filter(([, key]) => entries[key] === undefined).map(([name]) => name),
  }
}

/**
 * The profile data of one catalog entry, with `sources` pointing at `catalog`. Only fields the entry declares are
 * present. A malformed entry is read defensively: a `reasoning` that is not a boolean or `reasoning_options` that
 * is not an array count as absent, and a control with an unknown `type`, or an `effort` without a string array
 * `values`, is dropped. An empty `reasoning_options` is kept, because it says the model has no control.
 */
export function fromCatalogEntry(entry: CatalogModel): Partial<ModelProfile> {
  const entries = flatten(catalogPatch(entry), () => "catalog")
  const input = entries["modalities.input"]
  const output = entries["modalities.output"]
  const controls = entries["reasoningMode.controls"]
  return {
    ...(entries.context && { context: entries.context.value }),
    ...(entries.output && { output: entries.output.value }),
    ...((input || output) && {
      modalities: { input: input?.value ?? ["text"], output: output?.value ?? ["text"] },
    }),
    ...(entries.reasoning && { reasoning: entries.reasoning.value }),
    ...(entries.vendor && { vendor: entries.vendor.value }),
    ...(controls && { reasoningMode: { controls: controls.value, placeholder: false, replay: "none" as const } }),
    sources: sourcesOf(entries),
  }
}

/** The config entry always wins, so it is the first source; its blocks replace as a whole. */
function configEntries(config: ProfileConfig): Entries {
  return flatten(configPatch(config), () => "config")
}

/** The fields of an existing entry that have a source. A built-in rule result is dropped, to be evaluated again. */
function baseEntries(base: Partial<ModelProfile>): Entries {
  const sources = base.sources ?? {}
  return flatten(base, (key) => inherited(sources[key]))
}

/** What a same-named catalog entry lends. The catalog is not searched while nothing it could lend is still missing. */
function aliasEntries(catalog: Record<string, CatalogProvider>, apiID: string, known: Entries): Entries {
  if (ALIAS_KEYS.every((key) => known[key] !== undefined)) return {}
  const alias = findAlias(catalog, apiID)
  if (!alias) return {}
  return flatten(catalogPatch(alias), (key) => (ALIAS_KEYS.includes(key) ? "catalog-alias" : undefined))
}

function ruleInput(input: ResolveInput, known: Entries): RuleInput {
  const vendor = known.vendor?.value ?? vendorOf(input.apiID)
  return {
    providerID: input.providerID,
    apiID: input.apiID,
    ...(input.npm ? { npm: input.npm } : {}),
    ...(input.releaseDate ? { releaseDate: input.releaseDate } : {}),
    ...(vendor === undefined ? {} : { vendor }),
  }
}

/**
 * Resolves one model's profile. Pure: the inputs are never modified and the result shares nothing with them.
 *
 * Each field takes the first value found in this order, and records its origin in `sources`:
 * 1. `config`: the model entry in the configuration (a block replaces as a whole; `reasoning_mode` goes per key and
 *    `modalities` per direction).
 * 2. `base`: the fields of an existing entry that have a source, except those a built-in rule produced.
 * 3. alias: for `context`, `output`, `modalities`, `reasoning` and `vendor` only, the catalog entry of any provider
 *    whose `id` equals `apiID` ignoring case, else whose `canonical_model_id` equals `apiID` or ends with `/apiID`;
 *    among several the first by provider id, then entry key.
 * 4. `rules`: in order, each filling only fields still without a source.
 * 5. defaults. A `vendor` still missing is the part of `apiID` before the first `/`, without a source.
 *
 * A `context` or `output` that is not a positive finite number counts as absent.
 */
export function resolveProfile(input: ResolveInput): ModelProfile {
  const entries: Entries = {}
  if (input.config) fill(entries, configEntries(input.config))
  if (input.base) fill(entries, baseEntries(input.base))
  if (input.catalog) fill(entries, aliasEntries(input.catalog, input.apiID, entries))
  const rules = input.rules ?? BUILTIN_RULES
  if (rules.length > 0) applyRules(entries, rules, ruleInput(input, entries))
  return build(entries, input.apiID)
}
