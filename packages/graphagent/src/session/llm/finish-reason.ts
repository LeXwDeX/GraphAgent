// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendor `finish_reason` values the AI SDK folds into `other`.
 *
 * The SDK keeps the original string in `rawFinishReason`; the adapter reads it
 * first and acts on the target below. A raw value without a rule stays
 * `unknown` and travels with the attempt so an error message can name it.
 *
 * - `content-filter`: the vendor blocked this response; same as the standard
 *   `content-filter` finish, so the turn ends with a `ContentFilterError`.
 * - `stream_error`: the vendor cut generation short for resource shortage or an
 *   internal fault; handled as a retryable broken stream.
 * - `context_overflow`: the request exceeded the context window; handed to
 *   compaction.
 */
export type FinishTarget = "content-filter" | "stream_error" | "context_overflow"

/** Taken from the vendors' documentation; the endpoints were not probed for these values. */
export const FINISH_RULES: Readonly<Record<string, FinishTarget>> = {
  sensitive: "content-filter",
  insufficient_system_resource: "stream_error",
  aborted: "stream_error",
  network_error: "stream_error",
  model_context_window_exceeded: "context_overflow",
}

/**
 * Exact match on the raw value. `overrides` is the table of the model's profile (`finishReasons`): it is read first,
 * then `FINISH_RULES`, which holds for every provider.
 */
export function ruleOf(
  raw: string | undefined,
  overrides?: Readonly<Record<string, FinishTarget>>,
): FinishTarget | undefined {
  if (raw === undefined) return undefined
  if (overrides !== undefined && Object.hasOwn(overrides, raw)) return overrides[raw]
  if (!Object.hasOwn(FINISH_RULES, raw)) return undefined
  return FINISH_RULES[raw]
}

export * as FinishReasonRules from "./finish-reason"
