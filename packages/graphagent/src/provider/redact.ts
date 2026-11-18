// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"

/** What a masked secret is replaced by. */
export const REDACTED = "[redacted]"

// A name that holds a credential: apiKey, x-api-key, accessToken, client_secret, Authorization, password.
// Anchored at the end so counters such as max_tokens and maxTokens keep their numbers.
const SECRET_NAME = /(key|token|secret|authorization|password)$/i

/** Whether a value under this name is a credential: a string under a credential-looking name. */
export function isSecretKey(name: string, value: unknown): value is string {
  return typeof value === "string" && SECRET_NAME.test(name)
}

// Configuration is JSON: only plain objects are searched, so a Date or any other instance prints as it always did.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function redactOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOptions)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, isSecretKey(name, item) ? REDACTED : redactOptions(item)]),
  )
}

function redactHeaders(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]))
}

/**
 * A copy of a resolved model that is safe to print. Every header value is masked, since a header carries a
 * credential under any name, and so is every string under `options` whose key looks like a credential (objects
 * and arrays are searched, numbers and booleans are kept). Names, key order and every other field stay as they
 * were, and the input is not modified.
 */
export function redactModel<T extends object>(model: T): T {
  const headers = "headers" in model ? { headers: redactHeaders(model.headers) } : {}
  const options = "options" in model ? { options: redactOptions(model.options) } : {}
  return { ...model, ...headers, ...options }
}

export * as ProviderRedact from "./redact"
