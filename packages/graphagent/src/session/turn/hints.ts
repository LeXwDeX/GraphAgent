// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { detectToolCallEnvelope } from "@graphagent/core/session/reasoning-distillation/control-markup"
import { Injection } from "@graphagent/core/system-context/injection"
import type { SessionV1 } from "@graphagent/core/v1/session"

/**
 * Runtime hints (Issue #1465): short notices the turn loop writes as a
 * synthetic user message when the finished step shows a failure the model can
 * correct on its own. A hint never executes anything on the model's behalf.
 *
 * - `pseudo_tool_call`: the answer text contains a tool call written as text
 *   and the step made no real tool call.
 */
export type HintKind = "pseudo_tool_call"

/** How many hints of one kind a single turn may write; after that the turn ends as it would have. */
export const HINT_LIMIT: Record<HintKind, number> = { pseudo_tool_call: 1 }

export const HINT_TEXT: Record<HintKind, string> = {
  pseudo_tool_call:
    "Tool calls must use the function-calling interface. The text above looks like a tool call and was not executed. Call the tool through that interface.",
}

/** The only place a hint becomes message text: a block with source runtime. */
export function renderHint(kind: HintKind): string {
  return Injection.wrap("runtime", HINT_TEXT[kind])
}

const FENCED_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const TOOL_CALL_TAG = /<tool_call>\s*\{\s*"name"\s*:/
const FUNCTION_CALLS_TAG = /<function_calls>\s*<invoke\s+name\s*=\s*["']/i

/**
 * Whether the answer text of a finished step carries a tool call the model
 * wrote as text: the complete DSML envelope, a `<tool_call>` JSON object, or a
 * `<function_calls>` invoke. A step that made a real tool call never counts, and
 * neither do fenced code blocks (backtick or tilde fences), a mere mention of a
 * marker, or text the harness or the user marked synthetic or ignored.
 */
export function detectPseudoToolCall(parts: ReadonlyArray<SessionV1.Part>): boolean {
  if (parts.some((part) => part.type === "tool")) return false
  for (const part of parts) {
    if (part.type !== "text" || part.synthetic || part.ignored) continue
    const text = part.text.replace(FENCED_BLOCK, "")
    if (detectToolCallEnvelope(text) || TOOL_CALL_TAG.test(text) || FUNCTION_CALLS_TAG.test(text)) return true
  }
  return false
}

export * as Hints from "./hints"
