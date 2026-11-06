export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  dynamic: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
}) {}

export type DynamicSource = "environment" | "dynamic" | "prune" | "default"
export type DynamicSkipReason = "disabled"

export type DynamicInput = {
  readonly disabledByEnvironment: boolean
  readonly dynamic?: boolean
  readonly prune?: boolean
}

export type DynamicResolution = {
  readonly configured: boolean
  readonly enabled: boolean
  readonly source: DynamicSource
  readonly deprecatedPrune: boolean
  readonly skipped?: DynamicSkipReason
}

/** Resolve the merged configuration without inferring plugin presence or mutating persisted config. */
export function resolveDynamic(input: DynamicInput): DynamicResolution {
  let configured: boolean
  let source: DynamicSource
  let deprecatedPrune = false

  if (input.disabledByEnvironment) {
    configured = false
    source = "environment"
  } else if (input.dynamic !== undefined) {
    configured = input.dynamic
    source = "dynamic"
  } else if (input.prune !== undefined) {
    // Deprecated alias: recorded for diagnostics but retired as an enabler in v1.0.93.
    configured = false
    source = "prune"
    deprecatedPrune = true
  } else {
    configured = false
    source = "default"
  }

  return {
    configured,
    enabled: configured,
    source,
    deprecatedPrune,
    skipped: configured ? undefined : "disabled",
  }
}
