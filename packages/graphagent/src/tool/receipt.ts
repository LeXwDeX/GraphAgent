// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { addCorrections } from "@graphagent/core/session/outcome"
import { Effect } from "effect"

/**
 * What the harness tells the model about a call it corrected (#1451). Each note is one bounded sentence appended to
 * the result after truncation, so a dropped argument, a capped number or a corrected tool name is never a silent
 * success. One module owns the wording; the kinds the notes are recorded under go to `metadata.corrections`.
 */

const MAX_NAMES = 5
const MAX_NAME_CODE_POINTS = 40

/** The names, at most five, each cut to 40 code points with control characters shown as spaces, and how many there are. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).map((name) =>
    Array.from(name.replace(/[\p{Cc}\u2028\u2029]/gu, " "))
      .slice(0, MAX_NAME_CODE_POINTS)
      .join(""),
  )
  const more = names.length > MAX_NAMES ? `, ... (${names.length} in total)` : ""
  return `${shown.join(", ")}${more}`
}

/** Keys the call carried that the tool does not take; the decoder ignored them. */
export function excessKeyNote(tool: string, names: readonly string[]): string {
  return `Note: ${tool} does not take these arguments, so they were ignored: ${nameList(names)}. Send only the documented parameters.`
}

/** The arguments failed the schema and were repaired: `set` are the parameters the repair changed, `notUsed` the keys it dropped. */
export function repairedNote(set: readonly string[], notUsed: readonly string[]): string {
  const parts = [
    ...(set.length > 0 ? [`set: ${nameList(set)}`] : []),
    ...(notUsed.length > 0 ? [`not used as sent: ${nameList(notUsed)}`] : []),
  ]
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : ""
  return `Note: your arguments did not match the schema and were repaired before the call ran${detail}. Send the documented parameters.`
}

/** A number the tool caps: what was asked for, and the maximum that was used instead. */
export function clampNote(param: string, requested: number, max: number): string {
  return `Note: ${param} ${requested} is above the maximum ${max}; ${max} was used.`
}

export function nameCaseNote(from: string, to: string): string {
  return `Note: the tool name "${from}" was corrected to "${to}". Use the exact tool name.`
}

/** The log line of a correction: the tool and the kind only, never a key name or an argument value. */
export const logCorrection = (tool: string, kind: string, detail?: Record<string, unknown>): Effect.Effect<void> =>
  Effect.logInfo("tool call corrected", { "tool.name": tool, "correction.kind": kind, ...detail })

/**
 * A finished call whose part the model opened under `rawName` and the harness then renamed to `tool`. Only a name
 * that differs in case counts, and then the result says so and `name_case` is recorded. A result that is JSON
 * (clients parse it) is left as text and only the metadata changes. Anything else comes back as it was.
 */
export function nameCase<M extends Record<string, unknown>>(
  text: string,
  metadata: M,
  rawName: string | undefined,
  tool: string,
): { text: string; metadata: M; corrected: boolean } {
  if (rawName === undefined || rawName === tool || rawName.toLowerCase() !== tool) {
    return { text, metadata, corrected: false }
  }
  const structured = /^\s*[{[]/.test(text)
  return {
    text: structured ? text : `${text}\n\n${nameCaseNote(rawName, tool)}`,
    metadata: addCorrections(metadata, "name_case"),
    corrected: true,
  }
}

export * as Receipt from "./receipt"
