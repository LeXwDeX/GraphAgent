// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { compactionWindow } from "@graphagent/core/model-profile"

/**
 * What the share of the context window needs of a model: its profile, when the server sends one (every server since
 * the profile was added), and `limit.context` for one that does not, such as an older server or a test fixture.
 */
export type ContextModel = {
  readonly limit: { readonly context: number }
  readonly profile?: {
    readonly context?: number
    readonly effectiveContext?: number
    readonly sources: Readonly<Record<string, string>>
  }
}

export type ContextShare = {
  /** The window the context is measured against: the one the server compacts by, so `effective_context` counts. */
  readonly window: number
  /** The tokens as a share of `window`, rounded. */
  readonly percent: number
  /** The model declares no window, so `window` is the default one and `percent` is an estimate. */
  readonly estimated: boolean
}

/**
 * The share of the model's compaction window that `tokens` fill; undefined without a model, or without any window to
 * measure against. A model whose profile declares no window is measured against the default one and says so, so the
 * user sees how close compaction is.
 */
export function contextShare(tokens: number, model: ContextModel | undefined): ContextShare | undefined {
  if (!model) return undefined
  if (model.profile) {
    const window = compactionWindow(model.profile)
    return shareOf(tokens, window.tokens, window.source === "default")
  }
  const declared = model.limit.context
  return Number.isFinite(declared) && declared > 0 ? shareOf(tokens, declared, false) : undefined
}

function shareOf(tokens: number, window: number, estimated: boolean): ContextShare {
  return { window, percent: Math.round((tokens / window) * 100), estimated }
}

/** The mark before a figure that rests on the default window: `~`, for an estimate. Nothing for a declared window. */
export function estimateMark(share: { readonly estimated?: boolean }): string {
  return share.estimated ? "~" : ""
}
