// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"

/**
 * The model a tool call runs under. The engine passes it in `ctx.extra.model`; a tool that asks what the model accepts
 * reads it here, and gets nothing when the call came without one (a hook, a test) or with something else.
 */

/** Whether `value` has the fields tools read from a model: its provider, its API id, its input types and its context size. */
function isModel(value: unknown): value is Provider.Model {
  if (!isRecord(value)) return false
  const { api, capabilities, limit } = value
  return (
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

export * as ModelContext from "./model-context"
