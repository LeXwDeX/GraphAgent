// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the loop's background analysis (#1328, rules V1-V8).
 *
 * Pure and structural. It guarantees that every change to the user's intent, and every
 * goal_changed / user_stop verdict, cites a human message that really is in the basis window;
 * it does not judge whether that message is enough to support the change. The caller supplies
 * the facts (the previous intent, the IDs of the human messages in the window) and feeds the
 * returned violations back to the model, which retries.
 */
import {
  LOOP_NEXT_PROMPT_MAX_CHARS,
  LOOP_REASON_MAX_CHARS,
  type LoopAnalysisResult,
  type LoopIntent,
  type LoopIntentChange,
} from "@graphagent/schema/loop"

export type Rule = "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8"

export interface Violation {
  readonly rule: Rule
  /** Written for the model: what is wrong and how to fix it. */
  readonly message: string
}

export type Input = {
  /** The analysis the model submitted. */
  readonly result: LoopAnalysisResult
  /**
   * IDs of the human messages in the basis window: the human messages after the last committed
   * analysis (every human message since the loop started, on the first analysis). The caller
   * assembles the set, and only genuine human input belongs in it, including a message typed
   * while an automatic turn was running. Loop continuation messages, wake-ups, DAG and hook
   * injections and human messages outside the window are not in it, so they cannot serve as a
   * basis; the validator trusts the set as given.
   */
  readonly basisMessageIDs: ReadonlySet<string>
} & (
  | {
      /** No analysis has been committed for this loop yet: V1 applies, V2 and V3 do not. */
      readonly first: true
      readonly previous?: undefined
    }
  | {
      readonly first: false
      /** The latest committed intent. V2 and V3 compare against this version, not the frozen first one. */
      readonly previous: LoopIntent
    }
)

type Add = (rule: Rule, message: string) => void

const CHANGE_REMEDY =
  "Restore the previous version verbatim, or set `intent_change.changed` to true and " +
  "`intent_change.basis_message_id` to the ID of a human message in the basis window that asks for the change."

/** Returns every violation of V1-V8, ordered by rule number. Empty means the analysis may be committed. */
export function check(input: Input): ReadonlyArray<Violation> {
  const { result, basisMessageIDs } = input
  const violations: Violation[] = []
  const add: Add = (rule, message) => violations.push({ rule, message })

  if (input.first) checkFirst(result.intent, add)
  else checkChange(input.previous, result, basisMessageIDs, add)

  switch (result.verdict) {
    case "done":
      checkDone(result.intent, add)
      break
    case "continue":
      checkContinue(result, add)
      break
    case "blocked":
      checkBlocked(result.intent, add)
      break
    case "goal_changed":
    case "user_stop":
      checkCited(result, basisMessageIDs, add)
      break
  }
  checkReason(result.reason, add)

  return violations
}

/** V1: the first analysis becomes the frozen anchor, so it needs a real objective and real acceptance items. */
function checkFirst(intent: LoopIntent, add: Add) {
  if (intent.objective.trim() === "")
    add("V1", "This is the first analysis: `intent.objective` must be a non-empty one-sentence goal.")
  if (!intent.acceptance.some((item) => item.text.trim() !== ""))
    add(
      "V1",
      "This is the first analysis: `intent.acceptance` must list at least one acceptance item with non-empty `text`.",
    )
  const repeated = duplicates(intent.acceptance.map((item) => item.id))
  if (repeated.length > 0) add("V1", `Acceptance ids must be unique; repeated: ${quote(repeated)}.`)
}

/**
 * V2 and V3: objective, constraints, non_goals and the id and text of every existing acceptance item
 * stay verbatim, and no acceptance item disappears, unless the change cites a human message in the window.
 * Adding acceptance items, and updating status or evidence, never needs a basis.
 */
function checkChange(
  previous: LoopIntent,
  result: LoopAnalysisResult,
  basisMessageIDs: ReadonlySet<string>,
  add: Add,
) {
  const next = result.intent
  const drift: string[] = []
  if (next.objective !== previous.objective) drift.push("`intent.objective` differs from the previous version.")
  if (!sameList(next.constraints, previous.constraints))
    drift.push("`intent.constraints` differs from the previous version (same entries, same order).")
  if (!sameList(next.non_goals, previous.non_goals))
    drift.push("`intent.non_goals` differs from the previous version (same entries, same order).")

  const rewritten: string[] = []
  const removed: string[] = []
  for (const item of previous.acceptance) {
    const current = next.acceptance.find((entry) => entry.id === item.id)
    if (current === undefined) removed.push(item.id)
    else if (current.text !== item.text) rewritten.push(item.id)
  }
  if (rewritten.length > 0) drift.push(`The text of existing acceptance item(s) ${quote(rewritten)} was rewritten.`)

  if (drift.length > 0 || removed.length > 0) {
    const unjustified = unjustifiedChange(result.intent_change, basisMessageIDs)
    if (unjustified !== undefined) {
      for (const what of drift) add("V2", `${what} ${CHANGE_REMEDY} ${unjustified}`)
      if (removed.length > 0)
        add(
          "V3",
          `Existing acceptance item(s) ${quote(removed)} are missing: acceptance items may be added but not deleted. ` +
            `${CHANGE_REMEDY} ${unjustified}`,
        )
    }
  }

  // Ids are what make an existing item identifiable, so they must not repeat.
  const repeated = duplicates(next.acceptance.map((item) => item.id))
  if (repeated.length > 0) add("V3", `Acceptance ids must be unique; repeated: ${quote(repeated)}.`)
}

/** V4: done means every item is met with evidence and nothing is left to ask. */
function checkDone(intent: LoopIntent, add: Add) {
  const unmet = intent.acceptance.filter((item) => item.status !== "met").map((item) => item.id)
  if (unmet.length > 0)
    add(
      "V4",
      `Verdict \`done\` needs every acceptance item met; still unmet: ${quote(unmet)}. ` +
        "Mark them met with evidence, or choose another verdict.",
    )
  const unproven = intent.acceptance.filter((item) => (item.evidence ?? "").trim() === "").map((item) => item.id)
  if (unproven.length > 0)
    add("V4", `Verdict \`done\` needs non-empty \`evidence\` on every acceptance item; missing on: ${quote(unproven)}.`)
  if (intent.open_questions.length > 0)
    add(
      "V4",
      `Verdict \`done\` needs \`intent.open_questions\` to be empty; ${intent.open_questions.length} remain. ` +
        "Resolve them, or choose `blocked` when only the user can answer.",
    )
}

/** V5: continue needs the next round's prompt, within the size limit. */
function checkContinue(result: LoopAnalysisResult, add: Add) {
  const prompt = result.next_prompt ?? ""
  if (prompt.trim() === "")
    add(
      "V5",
      "Verdict `continue` needs a non-empty `next_prompt`: what this round must achieve, where to pick up, " +
        "how to verify, and what the last round got wrong.",
    )
  else if (prompt.length > LOOP_NEXT_PROMPT_MAX_CHARS)
    add("V5", `\`next_prompt\` has ${prompt.length} characters; the limit is ${LOOP_NEXT_PROMPT_MAX_CHARS}. Shorten it.`)
}

/** V6: goal_changed and user_stop must name the human message that caused them. */
function checkCited(result: LoopAnalysisResult, basisMessageIDs: ReadonlySet<string>, add: Add) {
  const problem = basisProblem(result.intent_change.basis_message_id, basisMessageIDs)
  if (problem === undefined) return
  add(
    "V6",
    `Verdict \`${result.verdict}\` must cite the human message that caused it: ${problem}. ` +
      `${windowNote(basisMessageIDs)} If no human message supports it, choose another verdict.`,
  )
}

/** V7: blocked is only for what the user must answer, so it carries the questions. */
function checkBlocked(intent: LoopIntent, add: Add) {
  if (intent.open_questions.some((question) => question.trim() !== "")) return
  add(
    "V7",
    "Verdict `blocked` needs at least one non-empty entry in `intent.open_questions`: a question only the user can answer.",
  )
}

/** V8: every verdict carries a reason the user can read. */
function checkReason(reason: string, add: Add) {
  if (reason.trim() === "") add("V8", "`reason` must not be empty.")
  else if (reason.length > LOOP_REASON_MAX_CHARS)
    add("V8", `\`reason\` has ${reason.length} characters; the limit is ${LOOP_REASON_MAX_CHARS}. Shorten it.`)
}

/** Why the intent change is not backed by a human message in the window, or undefined when it is. */
function unjustifiedChange(change: LoopIntentChange, basisMessageIDs: ReadonlySet<string>): string | undefined {
  const problems: string[] = []
  if (!change.changed) problems.push("`intent_change.changed` is not true")
  const basis = basisProblem(change.basis_message_id, basisMessageIDs)
  if (basis !== undefined) problems.push(basis)
  if (problems.length === 0) return undefined
  return `Not allowed as submitted: ${problems.join("; ")}. ${windowNote(basisMessageIDs)}`
}

/** Why `id` cannot serve as a basis, or undefined when it names a human message in the window. */
function basisProblem(id: string | undefined, basisMessageIDs: ReadonlySet<string>): string | undefined {
  if (id === undefined || id.trim() === "") return "`intent_change.basis_message_id` is missing"
  if (!basisMessageIDs.has(id))
    return `\`intent_change.basis_message_id\` "${id}" is not a human message in the basis window`
  return undefined
}

function windowNote(basisMessageIDs: ReadonlySet<string>) {
  if (basisMessageIDs.size === 0) return "The basis window is empty: there is no human message to cite."
  return `The basis window holds ${basisMessageIDs.size} human message(s); cite one of those IDs exactly.`
}

function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function duplicates(ids: ReadonlyArray<string>) {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
}

function quote(ids: ReadonlyArray<string>) {
  return ids.map((id) => `"${id}"`).join(", ")
}

export * as LoopValidate from "./validate"
