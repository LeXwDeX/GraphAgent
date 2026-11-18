// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { contextWindow } from "@graphagent/core/model-profile"
import { profileOf } from "@/provider/profile"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import type * as Tool from "./tool"

/**
 * The model a tool call runs under. The engine passes it in `ctx.extra.model`; a tool that asks what the model accepts,
 * or how large a result its window takes, reads it here, and gets nothing when the call came without one (a hook, a
 * test) or with something else.
 */

/** Whether `value` has the fields tools read from a model: its ids, its input types and its context size. */
function isModel(value: unknown): value is Provider.Model {
  if (!isRecord(value)) return false
  const { api, capabilities, limit } = value
  return (
    typeof value.id === "string" &&
    typeof value.providerID === "string" &&
    isRecord(api) &&
    typeof api.id === "string" &&
    isRecord(capabilities) &&
    isRecord(capabilities.input) &&
    isRecord(limit) &&
    typeof limit.context === "number"
  )
}

export function modelOf(extra: { [key: string]: unknown } | undefined): Provider.Model | undefined {
  const model = extra?.model
  return isModel(model) ? model : undefined
}

/**
 * The context window in tokens of `model`, read through its profile: the default window when no source declares
 * one, never 0. `undefined` when there is no model, so the caller keeps the budget it has without one.
 */
export function contextOfModel(model: Parameters<typeof profileOf>[0] | undefined): number | undefined {
  return model === undefined ? undefined : contextWindow(profileOf(model)).tokens
}

/** The context window of the model a call runs under (`contextOfModel` of `modelOf`); `undefined` without one. */
export function contextOf(extra: Tool.Context["extra"]): number | undefined {
  return contextOfModel(modelOf(extra))
}

export * as ModelContext from "./model-context"
