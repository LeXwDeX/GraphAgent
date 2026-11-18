// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { APP_NAME } from "@graphagent/core/brand"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { isRecord } from "@/util/record"

/**
 * What a provider failure means, as far as a retry or a user is concerned (#1466).
 * The status code alone does not say: a 429 can be a rate limit that clears in
 * seconds or a spent plan that never will, and a 400 can be a refused prompt or
 * a request the model can fix.
 *
 * - `quota_exhausted`: quota or balance used up; resending the same request fails.
 * - `rate_limited`: the server is throttling; waiting recovers.
 * - `auth`: the credentials were rejected.
 * - `content_refused`: the provider's content filter rejected the conversation.
 * - `context_overflow`: the request exceeds the context window; compaction is the way out.
 * - `invalid_request`: any other failure a resend cannot fix: a user abort, output over the
 *   limit, missing structured output, rejected reasoning state, a request the table names invalid.
 * - `transient`: time can fix it: 5xx, network, protocol failures, and anything unrecognised.
 */
export type ErrorClass =
  "quota_exhausted" | "rate_limited" | "auth" | "content_refused" | "context_overflow" | "invalid_request" | "transient"

/** What `factsOf` reads from an API error; `names` are lower-cased error codes and types. */
export type ErrorFacts = { status?: number; names: readonly string[]; text: string }

/** One row of the table: a class and the facts that put an error in it. */
export interface Row {
  readonly cls: ErrorClass
  /** The error's status must be one of these. */
  readonly status?: readonly number[]
  /** The error must carry at least one of these names. */
  readonly names?: readonly string[]
  /** The error text must match. */
  readonly message?: RegExp
}

/**
 * Provider error table, matched top to bottom; the first row whose written
 * fields all hit wins. Codes and wording come from the vendors' public error
 * documentation (Zhipu, Alibaba Bailian, Moonshot, Anthropic, OpenAI); none was
 * measured against a live endpoint. Never branch on a provider ID: the same
 * codes show up behind gateways and compatible endpoints.
 */
export const ROWS: readonly Row[] = [
  // Bailian files its per-minute allocation under the balance names. The phrase
  // tells it apart, so this row has to stay ahead of the balance row below.
  {
    cls: "rate_limited",
    names: ["throttling.allocationquota", "insufficient_quota"],
    message: /please increase your quota limit/i,
  },
  {
    cls: "quota_exhausted",
    names: [
      "insufficient_quota",
      "credit_balance_exhausted",
      "exceeded_current_quota_error",
      "enforced_spend_limit_reached",
      "arrearage",
      "allocationquota.freetieronly",
      // The native runtime's own `QuotaExceeded` tag, kept in the error metadata.
      "quotaexceeded",
    ],
  },
  { cls: "quota_exhausted", status: [402] },
  { cls: "quota_exhausted", message: /free allocated quota exceeded/i },
  { cls: "quota_exhausted", names: ["1113"], message: /欠费/ },
  { cls: "quota_exhausted", names: ["1308", "1309", "1310", "1316", "1317"], message: /使用上限|套餐已到期/ },
  {
    cls: "content_refused",
    // `contentpolicy` is the native runtime's tag.
    names: ["content_filter", "data_inspection_failed", "datainspectionfailed", "contentpolicy"],
  },
  {
    cls: "invalid_request",
    status: [400, 422],
    names: [
      "invalid_request_error",
      "invalid_parameter_error",
      "invalid_parameter",
      "invalidparameter",
      "invalid_argument",
    ],
  },
  { cls: "invalid_request", names: ["invalid_prompt"] },
]

const TEXT_LIMIT = 4000

function parseBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function namesOf(values: readonly unknown[]): string[] {
  const names = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue
    const name = String(value).toLowerCase()
    if (name) names.add(name)
  }
  return [...names]
}

/**
 * The facts the table reads from an `APIError`'s `data`. Metadata only carries
 * strings, so a numeric code such as Zhipu's `1308` has to come from the body.
 * The text is bounded: provider-controlled input goes through regular expressions.
 */
export function factsOf(data: SessionV1.APIError["data"]): ErrorFacts {
  const body = parseBody(data.responseBody)
  const error = isRecord(body?.error) ? body.error : undefined
  const details = isRecord(error?.details) ? error.details : undefined
  return {
    ...(data.statusCode === undefined ? {} : { status: data.statusCode }),
    names: namesOf([
      data.metadata?.code,
      data.metadata?.type,
      error?.code,
      error?.type,
      error?.status,
      details?.error_code,
      body?.code,
      body?.type,
    ]),
    text: `${data.message}\n${data.responseBody ?? ""}`.slice(0, TEXT_LIMIT),
  }
}

/** True when every field the row writes hits the facts. */
export function rowMatches(row: Row, facts: ErrorFacts): boolean {
  if (row.status && (facts.status === undefined || !row.status.includes(facts.status))) return false
  if (row.names && !row.names.some((name) => facts.names.includes(name))) return false
  return !row.message || row.message.test(facts.text)
}

/**
 * The class of the first row the facts hit. A transient signal on the error (a
 * retry flag, or wording that names a timeout, an overload, a gateway breaker)
 * skips the `invalid_request` rows: gateways answer a failing upstream with a 400,
 * and that has to stay retryable.
 */
export function match(facts: ErrorFacts, transient: boolean): ErrorClass | undefined {
  return ROWS.find((row) => !(transient && row.cls === "invalid_request") && rowMatches(row, facts))?.cls
}

/** One line telling the user what to do about a failure of this class; none for the classes that need no advice. */
export function hintOf(cls: ErrorClass, id: string): string | undefined {
  switch (cls) {
    case "quota_exhausted":
      return `Provider "${id}": quota or balance used up, so resending cannot succeed. Top up or switch model.`
    case "auth":
      return `Provider "${id}" rejected the credentials. Run \`${APP_NAME} providers login --provider ${id}\`.`
    case "content_refused":
      return "The provider's content filter rejected this conversation. Rephrase the last message or start a new session."
    default:
      return undefined
  }
}

export * as ProviderErrorClass from "./error-class"
