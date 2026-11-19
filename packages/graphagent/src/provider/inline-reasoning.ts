// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { LanguageModelV3 } from "@ai-sdk/provider"
import { extractReasoningMiddleware, wrapLanguageModel } from "ai"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderProfile } from "./profile"
import type { Model } from "./provider"

/**
 * Endpoints known one by one to write their reasoning into the answer text between a pair of tags
 * (`<think>…</think>`) instead of a separate reasoning field, matched by provider and API id exactly. The table is
 * empty by default: a model's tag comes from its profile (`reasoningMode.inlineTag`), where a built-in rule names the
 * families whose own documentation says so (Qwen, DeepSeek and GLM behind an OpenAI-compatible endpoint) and a
 * configuration declares a tag, or switches it off with an empty `inline_tag`. Text from any other model must reach the
 * session untouched, so a name matches only through a rule that cites the documentation of its family, never by a guess.
 */
export const INLINE_REASONING_TAGS: ReadonlyArray<{ providerID: string; apiID: string; tag: string }> = []

/**
 * The tag name (`think` for `<think>…</think>`) this model uses, or undefined when it has none. The tag the model's
 * profile declares (`reasoningMode.inlineTag`) comes first; the table is the fallback.
 */
export function inlineReasoningTag(
  model: Pick<Model, "providerID" | "api"> & Partial<Model>,
  table: typeof INLINE_REASONING_TAGS = INLINE_REASONING_TAGS,
): string | undefined {
  // profileOf reads the API id of `api`; the id it asks for is only what a model without `api` falls back to.
  const declared = ProviderProfile.profileOf({ id: ModelV2.ID.make(model.api.id), ...model }).reasoningMode.inlineTag
  if (declared) return declared
  return table.find((rule) => rule.providerID === model.providerID && rule.apiID === model.api.id)?.tag
}

/**
 * Splits `<tag>…</tag>` out of the text stream as reasoning; a model without a tag is returned as is. This wraps the
 * AI SDK path; the native runtime splits its `LLMEvent` stream in `session/llm/inline-reasoning.ts`.
 */
export function wrapInlineReasoning(language: LanguageModelV3, tag: string | undefined): LanguageModelV3 {
  if (tag === undefined) return language
  return wrapLanguageModel({ model: language, middleware: extractReasoningMiddleware({ tagName: tag }) })
}

export * as InlineReasoning from "./inline-reasoning"
