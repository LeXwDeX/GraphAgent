export * as ConfigReasoningDistillation from "./reasoning-distillation"

import { Schema } from "effect"

export class Compatibility extends Schema.Class<Compatibility>("ConfigV2.ReasoningDistillationCompatibility")({
  runtime: Schema.String,
  protocol: Schema.String,
  providerModelVariant: Schema.String,
  endpointIdentity: Schema.String,
  adapterVersion: Schema.String,
  optionsFingerprint: Schema.String,
  transportVerified: Schema.Boolean,
  upstreamVerified: Schema.Boolean,
}) {}

export const Language = Schema.Literals(["zh", "en"])
export type Language = typeof Language.Type

export class Model extends Schema.Class<Model>("ConfigV2.Model.ReasoningDistillation")({
  enabled: Schema.Boolean.pipe(Schema.optional),
}) {}

/**
 * Global reasoning-distillation switch (default-on for every model). When enabled, each settled part whose carrier is
 * plain or a plaintext mirror is organized by the small model as soon as it ends, and the result replaces the stored
 * text before the part is first resent. Signed, encrypted, referenced and unknown carriers are never rewritten; the
 * per-part carrier check, not the model family, decides eligibility. `compatibility` is accepted for older
 * configurations and ignored.
 */
export class Info extends Schema.Class<Info>("ConfigV2.ReasoningDistillation")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  /**
   * Organize editable reasoning synchronously before content continues in the same user turn. Defaults to `true`.
   * Set to `false` to organize after the turn and apply the result on the next request.
   */
  sync: Schema.Boolean.pipe(Schema.optional),
  /** Language of the organized prose; literals such as paths and commands stay verbatim. Defaults to `zh`. */
  language: Language.pipe(Schema.optional),
  /** @deprecated Ignored; retained so existing configurations still load. */
  compatibility: Compatibility.pipe(Schema.Array, Schema.optional),
}) {}

/** Organizer language; Chinese by default because it is shorter for the same content. */
export const resolveLanguage = (info: Pick<Info, "language"> | undefined): Language => info?.language ?? "zh"

/** Synchronous continuation defaults on; `false` restores the asynchronous next-request path. */
export const resolveSync = (info: Pick<Info, "sync"> | undefined): boolean => info?.sync !== false

export type EnableSource = "environment" | "model" | "config" | "default"

export type EnableResolution = Readonly<{
  enabled: boolean
  source: EnableSource
}>

export type EnableInput = Readonly<{
  /** An environment kill-switch (e.g. OPENCODE_DISABLE_REASONING_DISTILLATION) overrides everything. */
  disabledByEnvironment: boolean
  /** The user's config value, when present. */
  enabled?: boolean
  /** A per-model override, when present. */
  modelEnabled?: boolean
}>

/** Resolve the effective switch without mutating persisted config. Every model family defaults on. */
export function resolveEnabled(input: EnableInput): EnableResolution {
  if (input.disabledByEnvironment) return { enabled: false, source: "environment" }
  if (input.modelEnabled !== undefined) return { enabled: input.modelEnabled, source: "model" }
  if (input.enabled !== undefined) return { enabled: input.enabled, source: "config" }
  return { enabled: true, source: "default" }
}
