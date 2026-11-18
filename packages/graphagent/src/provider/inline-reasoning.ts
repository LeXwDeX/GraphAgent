// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { LanguageModelV3 } from "@ai-sdk/provider"
import { extractReasoningMiddleware, wrapLanguageModel } from "ai"
import type { Model } from "./provider"

/**
 * Models that write their reasoning into the answer text between a pair of
 * tags (`<think>…</think>`) instead of a separate reasoning field. Only an
 * endpoint known to do this belongs here: text from any other model must reach
 * the session untouched, so the table is empty by default and a model is never
 * matched by a guess from its name.
 */
export const INLINE_REASONING_TAGS: ReadonlyArray<{ providerID: string; apiID: string; tag: string }> = []

/** The tag name (`think` for `<think>…</think>`) this model uses, or undefined when it has none. */
export function inlineReasoningTag(
  model: Pick<Model, "providerID" | "api">,
  table: typeof INLINE_REASONING_TAGS = INLINE_REASONING_TAGS,
): string | undefined {
  return table.find((rule) => rule.providerID === model.providerID && rule.apiID === model.api.id)?.tag
}

/** Splits `<tag>…</tag>` out of the text stream as reasoning; a model without a tag is returned as is. */
export function wrapInlineReasoning(language: LanguageModelV3, tag: string | undefined): LanguageModelV3 {
  if (tag === undefined) return language
  return wrapLanguageModel({ model: language, middleware: extractReasoningMiddleware({ tagName: tag }) })
}

export * as InlineReasoning from "./inline-reasoning"
