// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { resolveProfile, type BuiltinRule, type Modality, type ModelProfile } from "@graphagent/core/model-profile"
import type { Types } from "effect"
// Type-only: a runtime import would close a cycle with transform.ts through provider.ts.
import type { Model } from "./provider"

type Flags = Model["capabilities"]["input"]
/** The profile fields as they are filled in, one by one. */
type Draft = Types.Mutable<Partial<ModelProfile>>

const MODALITIES: ReadonlyArray<Modality> = ["text", "audio", "image", "video", "pdf"]

/** The five booleans of `capabilities.input` and `capabilities.output` for a list of modalities. */
export function modalityFlags(list: Modality[]): Flags {
  return {
    text: list.includes("text"),
    audio: list.includes("audio"),
    image: list.includes("image"),
    video: list.includes("video"),
    pdf: list.includes("pdf"),
  }
}

function modalityList(flags: Partial<Flags> | undefined): Modality[] | undefined {
  if (!flags) return undefined
  return MODALITIES.filter((name) => flags[name] === true)
}

/**
 * What a model without a profile tells through its own fields, with the source `adapter`: `limit.context`,
 * `limit.output` (resolveProfile drops a value that is not positive), `capabilities.input`, `.output` and
 * `.reasoning`. A fixture that lacks a field says nothing about it, so the field stays without a source.
 */
function adapterProfile(model: Partial<Model>): Partial<ModelProfile> {
  const sources: Record<string, string> = {}
  const base: Draft = { sources }
  if (model.limit?.context !== undefined) {
    base.context = model.limit.context
    sources.context = "adapter"
  }
  if (model.limit?.output !== undefined) {
    base.output = model.limit.output
    sources.output = "adapter"
  }
  const input = modalityList(model.capabilities?.input)
  const output = modalityList(model.capabilities?.output)
  if (input || output) base.modalities = { input: input ?? ["text"], output: output ?? ["text"] }
  if (input) sources["modalities.input"] = "adapter"
  if (output) sources["modalities.output"] = "adapter"
  if (typeof model.capabilities?.reasoning === "boolean") {
    base.reasoning = model.capabilities.reasoning
    sources.reasoning = "adapter"
  }
  return base
}

function sameModalities(a: ReadonlyArray<Modality>, b: ReadonlyArray<Modality>) {
  return MODALITIES.every((name) => a.includes(name) === b.includes(name))
}

/** `profile` with the fields the model's own `limit` and `capabilities` contradict taken from the model; undefined when none. */
function syncedBase(profile: ModelProfile, own: Partial<ModelProfile>): Partial<ModelProfile> | undefined {
  const base: Draft = { ...profile }
  const sources = { ...profile.sources }
  let changed = false
  if (own.context !== undefined && Number.isFinite(own.context) && own.context > 0 && own.context !== profile.context) {
    base.context = own.context
    sources.context = "adapter"
    changed = true
  }
  if (own.output !== undefined && Number.isFinite(own.output) && own.output > 0 && own.output !== profile.output) {
    base.output = own.output
    sources.output = "adapter"
    changed = true
  }
  if (own.reasoning !== undefined && own.reasoning !== profile.reasoning) {
    base.reasoning = own.reasoning
    sources.reasoning = "adapter"
    changed = true
  }
  const modalities = { input: profile.modalities.input, output: profile.modalities.output }
  for (const direction of ["input", "output"] as const) {
    const list = own.sources?.[`modalities.${direction}`] ? own.modalities?.[direction] : undefined
    if (!list || sameModalities(list, modalities[direction])) continue
    modalities[direction] = list
    sources[`modalities.${direction}`] = "adapter"
    changed = true
  }
  base.modalities = modalities
  base.sources = sources
  return changed ? base : undefined
}

/**
 * An adapter often returns a copy of a catalog model that still carries the catalog's profile while it changes the
 * model's own `limit` or `capabilities` (the Codex adapter narrows a window). The copied profile is then out of date,
 * and whoever reads the profile would see the catalog's window instead of the adapter's. Where the model's own
 * value differs from what its profile says, the profile takes the model's value with the source `adapter`; the
 * rest of the profile stays. A model without a profile is returned as it is, `profileOf` derives one for it.
 */
export function syncProfile(model: Model): Model {
  if (!model.profile) return model
  const base = syncedBase(model.profile, adapterProfile(model))
  if (!base) return model
  return {
    ...model,
    profile: resolveProfile({
      providerID: model.providerID,
      apiID: model.api?.id ?? model.id,
      npm: model.api?.npm,
      releaseDate: model.release_date,
      base,
    }),
  }
}

/**
 * The profile of a model. A model that carries one returns it as it is; any other is resolved from its own
 * `limit` and `capabilities` (source `adapter`). It accepts a partial model, so a fixture without `api`,
 * `capabilities` or `release_date` does not throw.
 */
export function profileOf(model: Pick<Model, "id" | "providerID"> & Partial<Model>): ModelProfile {
  if (model.profile) return model.profile
  return resolveProfile({
    providerID: model.providerID,
    apiID: model.api?.id ?? model.id,
    npm: model.api?.npm,
    releaseDate: model.release_date,
    base: adapterProfile(model),
  })
}

/**
 * The profile known from the id alone, for a model that may not be registered: only built-in rules apply, there is
 * neither catalog nor configuration data, and every other field takes the missing value.
 */
export function builtinProfileOf(
  providerID: string,
  modelID: string,
  rules?: ReadonlyArray<BuiltinRule>,
): ModelProfile {
  return resolveProfile({ providerID, apiID: modelID, rules })
}

export * as ProviderProfile from "./profile"
