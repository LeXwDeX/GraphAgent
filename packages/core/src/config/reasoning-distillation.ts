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

/**
 * Reasoning-distillation switch (default-on). When enabled, each settled reasoning part whose provider carrier is
 * plain or a plaintext mirror is organized by the small model as soon as it ends, and the result replaces the stored
 * text before the part is first resent. `compatibility` is accepted for older configurations and ignored.
 */
export class Info extends Schema.Class<Info>("ConfigV2.ReasoningDistillation")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  /** Language of the organized prose; literals such as paths and commands stay verbatim. Defaults to `zh`. */
  language: Language.pipe(Schema.optional),
  /** @deprecated Ignored; retained so existing configurations still load. */
  compatibility: Compatibility.pipe(Schema.Array, Schema.optional),
}) {}

/** Organizer language; Chinese by default because it is shorter for the same content. */
export const resolveLanguage = (info: Pick<Info, "language"> | undefined): Language => info?.language ?? "zh"

export type EnableSource = "environment" | "config" | "default"

export type EnableResolution = Readonly<{
  enabled: boolean
  source: EnableSource
}>

export type EnableInput = Readonly<{
  /** An environment kill-switch (e.g. OPENCODE_DISABLE_REASONING_DISTILLATION) overrides everything. */
  disabledByEnvironment: boolean
  /** The user's config value, when present. */
  enabled?: boolean
}>

/** Resolve the effective switch without mutating persisted config. Enabled unless explicitly disabled. */
export function resolveEnabled(input: EnableInput): EnableResolution {
  if (input.disabledByEnvironment) return { enabled: false, source: "environment" }
  if (input.enabled !== undefined) return { enabled: input.enabled, source: "config" }
  return { enabled: true, source: "default" }
}
