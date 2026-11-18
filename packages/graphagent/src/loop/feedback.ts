// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the analysis model reads back when its submission is not accepted (#1328).
 *
 * Plain text written for the model, one function per way a submission can fail: the arguments do not
 * decode, the result breaks rules V1-V8, or the model stopped without submitting. Every text names the
 * attempt and how many remain, because the number of attempts is fixed and the model should spend the
 * last ones deliberately.
 */
import type { LoopValidate } from "./validate"

/** Attempts per analysis: submissions that are not accepted, plus stops without a submission. */
export const MAX_ATTEMPTS = 3

function lead(attempt: number) {
  const left = Math.max(0, MAX_ATTEMPTS - attempt)
  return `Attempt ${attempt} of ${MAX_ATTEMPTS}; ${left === 0 ? "no attempts are left" : `${left} left`}.`
}

/** The result decoded, but breaks the content rules. */
export function violations(attempt: number, list: ReadonlyArray<LoopValidate.Violation>): string {
  return [
    `submit_analysis was NOT accepted and nothing was recorded. ${lead(attempt)}`,
    "Fix every item below, then call submit_analysis again with the complete corrected result:",
    ...list.map((item) => `- [${item.rule}] ${item.message}`),
  ].join("\n")
}

/** The arguments do not match the result schema. `detail` lists the failing paths, never their values. */
export function malformed(attempt: number, detail: string): string {
  return [
    `submit_analysis was NOT accepted and nothing was recorded: the arguments do not match the schema. ${lead(attempt)}`,
    `Problems: ${detail || "the arguments are not an object of the expected shape"}.`,
    "Call submit_analysis again with every required field, correctly typed. Omit optional fields instead of sending null.",
  ].join("\n")
}

/** The model ended its turn without calling submit_analysis. */
export function unsubmitted(attempt: number): string {
  return [
    `You ended your turn without calling submit_analysis, so no analysis was recorded. ${lead(attempt)}`,
    "Call submit_analysis now with the complete result. Do not reply in plain text.",
  ].join("\n")
}

/** The tool result for a submit_analysis call that arrives after an analysis was already accepted. */
export const ALREADY_ACCEPTED = "An analysis was already accepted. Stop now and do not call any more tools."
/** The tool result for a submit_analysis call that arrives after the last attempt was used, in the same response. */
export const EXHAUSTED = `Attempts exhausted: all ${MAX_ATTEMPTS} attempts were used, so this submission was not checked and nothing was recorded. The analysis has failed; stop now and do not call any more tools.`
export const ACCEPTED = "Analysis accepted. Stop now and do not call any more tools."

export * as LoopFeedback from "./feedback"
