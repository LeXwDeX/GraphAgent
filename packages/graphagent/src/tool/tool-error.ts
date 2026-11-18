// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Model-facing text for tool-call faults the engine detects before or around a
 * tool run. One module owns the wording so both runtime paths (AI SDK and
 * native) and the validation layer return the same text for the same fault.
 * Rendered text never includes argument values; names and value lists are
 * bounded, and the caller keeps `detail` short.
 */

export type Fault =
  | { readonly kind: "invalid_arguments"; readonly tool: string; readonly detail: string }
  | { readonly kind: "unknown_tool"; readonly requested: string; readonly available: readonly string[] }
  | { readonly kind: "invalid_json"; readonly tool: string; readonly length: number }
  | { readonly kind: "truncated_arguments"; readonly tool: string; readonly length: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "aborted" }

const NAME_CODE_POINTS = 64
const NAME_LIMIT = 30
const VALUE_LIMIT = 20
/** What the model must not assume about a call that never returned. */
const EFFECT_UNKNOWN = "Whether it changed anything is unknown: check the current state before repeating it."

const codePoints = (text: string, max: number) => Array.from(text).slice(0, max).join("")

/** A tool or agent name the model supplied, cut to 64 code points so an error never echoes unbounded text. */
export const clipName = (name: string) => codePoints(name, NAME_CODE_POINTS)

/** Tool names as a bounded, comma-separated list: first 30 names, each cut to 64 code points. */
export function nameList(names: readonly string[]): string {
  if (names.length === 0) return "(none)"
  const shown = names.slice(0, NAME_LIMIT).map((name) => codePoints(name, NAME_CODE_POINTS))
  const more = names.length > NAME_LIMIT ? `, ... (${names.length} in total)` : ""
  return `${shown.join(", ")}${more}`
}

/** Allowed values as `one of "a", "b"`; lists at most 20 and says how many exist. */
export function oneOf(values: ReadonlyArray<string | number | boolean>): string {
  const shown = values.slice(0, VALUE_LIMIT).map((value) => JSON.stringify(value))
  const more = values.length > VALUE_LIMIT ? `, ... (first ${VALUE_LIMIT} of ${values.length})` : ""
  return `one of ${shown.join(", ")}${more}`
}

export function render(fault: Fault): string {
  switch (fault.kind) {
    case "invalid_arguments":
      return `The ${fault.tool} tool was called with invalid arguments: ${fault.detail.endsWith(".") ? fault.detail : `${fault.detail}.`} Fix them and call ${fault.tool} again.`
    case "unknown_tool":
      return `Unknown tool "${clipName(fault.requested)}". Available tools: ${nameList(fault.available)}. Use one of them.`
    case "invalid_json":
      return `The arguments for ${fault.tool} are not valid JSON (${fault.length} characters). If the output limit cut the call off, split the work into smaller ${fault.tool} calls; otherwise resend one complete JSON object.`
    case "truncated_arguments":
      return `The arguments for ${fault.tool} were cut off at character ${fault.length} by the output limit, so the call did not run. Send smaller arguments or split the work into several ${fault.tool} calls.`
    case "interrupted":
      return `[Tool execution was interrupted before it returned. ${EFFECT_UNKNOWN}]`
    case "aborted":
      return `Tool execution aborted before it returned. ${EFFECT_UNKNOWN}`
    default: {
      const unhandled: never = fault
      return unhandled
    }
  }
}

export * as ToolError from "./tool-error"
