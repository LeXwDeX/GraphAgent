// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Request shape for the last step of a turn (Issue #1028, H6 PR2).
 *
 * The final step keeps the tool set and `tool_choice` of the previous request
 * so the cached prefix stays intact; tools are refused at execution time
 * instead of being removed from the request.
 *
 * - `normal`: an ordinary step.
 * - `terminal`: the last step for a text turn. Tools and `tool_choice` stay as
 *   they were; the fixed instruction below is appended to the messages.
 * - `closing`: the extra `tool_choice: "none"` step that runs only when the
 *   terminal step still called a local tool. This is the only path allowed to
 *   change `tool_choice` (one accepted cache miss).
 * - `structuredTerminal`: the last step of a `json_schema` turn. It keeps the
 *   pre-existing behavior (empty tools, `tool_choice: "none"`, and the
 *   structured-output error) because forced-tool-choice compatibility is
 *   owned by C2 (#1014).
 */
export type FinalPolicy = "normal" | "terminal" | "closing" | "structuredTerminal"

/**
 * Appended as the last assistant message for a terminal or closing request. It
 * must stay in the message tail, never in `system`: changing the system text
 * would invalidate the cached prefix this policy is designed to preserve.
 */
export const FINAL_STEP_INSTRUCTION = "Final step: reply in text only; tool calls will be refused."

export const FINAL_STEP_REFUSAL_MESSAGE = "Tool calls are refused on the final step"

export * as FinalPolicy from "./final-policy"
