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

type Redactor = (value: unknown) => unknown

function redactOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOptions)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactOption(name, item)]))
}

// A `headers` object is masked whole wherever it sits, as a header carries a credential under any name.
function redactOption(name: string, item: unknown): unknown {
  if (isSecretKey(name, item)) return REDACTED
  if (name.toLowerCase() === "headers" && isPlainObject(item)) return redactHeaders(item)
  return redactOptions(item)
}

function redactHeaders(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]))
}

// A string under a name that is a credential by itself, such as the `key` of a provider.
function redactCredential(value: unknown): unknown {
  return isSecretKey("key", value) ? REDACTED : value
}

// Applies `redact` to every plain-object entry of a record keyed by id; anything else (a boolean section) is kept.
function mapEntries(record: unknown, redact: (entry: Record<string, unknown>) => unknown): unknown {
  if (!isPlainObject(record)) return record
  return Object.fromEntries(
    Object.entries(record).map(([id, entry]) => [id, isPlainObject(entry) ? redact(entry) : entry]),
  )
}

// A copy of `entry` in which each field named in `fields` goes through its redactor; key order, the other fields and
// the absence of a field stay as they were.
function redactFields<T extends object>(entry: T, fields: Readonly<Record<string, Redactor>>): T {
  const copy = { ...entry }
  for (const [name, redact] of Object.entries(fields)) {
    if (Object.hasOwn(copy, name)) Reflect.set(copy, name, redact(Reflect.get(copy, name)))
  }
  return copy
}

const redactModels: Redactor = (models) => mapEntries(models, redactModel)

// Redacts every entry of a record keyed by id (the providers, LSP servers or formatters of a configuration).
const redactEntriesBy =
  (fields: Readonly<Record<string, Redactor>>): Redactor =>
  (record) =>
    mapEntries(record, (entry) => redactFields(entry, fields))

const MODEL_FIELDS = { headers: redactHeaders, options: redactOptions, variants: redactOptions }
const PROVIDER_FIELDS = { key: redactCredential, options: redactOptions, models: redactModels }

// The places of a configuration that hold a credential once its `{env:}` and `{file:}` references are resolved: the
// options and models of a provider, and the environment handed to an LSP server or a formatter.
const CONFIG_FIELDS = {
  provider: redactEntriesBy({ options: redactOptions, models: redactModels }),
  lsp: redactEntriesBy({ env: redactOptions, initialization: redactOptions }),
  formatter: redactEntriesBy({ environment: redactOptions }),
}

/**
 * A copy of a resolved model that is safe to print. Every header value is masked, since a header carries a
 * credential under any name, and so is every string under `options` and under each of the `variants` whose key
 * looks like a credential (objects and arrays are searched, numbers and booleans are kept). Names, key order and
 * every other field stay as they were, and the input is not modified.
 */
export function redactModel<T extends object>(model: T): T {
  return redactFields(model, MODEL_FIELDS)
}

/**
 * A copy of a provider as the server reports it that is safe to send to a client: the provider's own `key` (read
 * from the environment or the credential store), every credential under its `options` (a `headers` object is masked
 * whole), and each of its models as `redactModel` does. The other fields, the key order and the input stay as they
 * were.
 */
export function redactProvider<T extends object>(provider: T): T {
  return redactFields(provider, PROVIDER_FIELDS)
}

/**
 * A copy of a resolved configuration that is safe to send to a client. A credential written as an `{env:}` or
 * `{file:}` reference is a plain string by the time the configuration is read, so it is masked by where it sits: under
 * each provider's `options` (a `headers` object is masked whole) and in each of its models as `redactModel` does, and,
 * by credential-looking names, under the `env` and `initialization` of each LSP server and the `environment` of each
 * formatter. Everything else, such as the keys of a permission rule, is left alone. Key order is kept and the input is
 * not modified.
 */
export function redactConfig<T extends object>(config: T): T {
  return redactFields(config, CONFIG_FIELDS)
}

export * as ProviderRedact from "./redact"
