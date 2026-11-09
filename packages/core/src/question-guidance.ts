// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Shared model-facing question contract for the V1 and V2 tool paths. */
export interface Prompt {
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string }>
  readonly multiple?: boolean
}

export const description = `Use this tool when a decision changes scope, authorization, acceptance criteria, or an irreversible outcome and existing instructions do not resolve it. For an ordinary preference with a reasonable default, choose that default, state the assumption, and continue.

A question blocks until answered or until \`question_timeout\` seconds pass (default 60). After the user starts answering, inactivity times out after \`question_timeout\` seconds and the response phase ends after five minutes. If a question times out, the user may be away from the computer. Choose the best solution yourself based on the task, existing instructions, and available evidence. State assumptions without claiming the user answered. Every question with \`options\` SHOULD put exactly one "(Recommended)" option first as an unanswered fallback. A fallback is a recommendation, not a restriction; choose a better solution when the task, instructions, and evidence support it. Silence never grants new scope or permission for an irreversible action. Defer a dependent step only when it requires missing authorization or a key fact that cannot be reasonably inferred, and continue other authorized work. A dismissed question means the user declined to answer: do not ask it again in the same turn; continue independent authorized work and report the blocked step.

Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- Even with \`multiple: true\`, timeout lists only one suggested candidate and records no user selections
- If several options carry "(Recommended)", the first marked option is the suggested fallback. If none is marked, the first option is suggested. A free-form question has no suggested candidate; that alone does not block work.
- A candidate is never automatic permission. Do not repeat the same question after timeout or dismissal in the same turn.`

export const rejectedOutput =
  "The user dismissed the question without answering. Do not repeat this question in this turn or treat dismissal as consent. Defer its dependent step, continue independent authorized work, and report what requires an explicit answer."

export function timeoutOutput(questions: ReadonlyArray<Prompt>) {
  const choices = questions.map((question, index) => {
    const candidate =
      question.options.find((option) => option.label.trimEnd().endsWith("(Recommended)")) ?? question.options[0]
    return candidate
      ? `Question ${index + 1} fallback candidate: ${JSON.stringify(candidate.label)}${question.multiple ? " (one suggested candidate)" : ""}.`
      : `Question ${index + 1} has no option fallback candidate.`
  })
  return [
    "The user is temporarily away from the computer and did not answer.",
    "Choose the best solution yourself based on the task, existing instructions, and available evidence.",
    "Do not repeat this question in this turn.",
    ...choices,
    "Continue authorized work now. Treat each listed candidate as a recommendation, not a restriction; choose a better solution when task, instructions, and evidence support it. Silence never grants new scope or permission for an irreversible action. Defer only a dependent step that requires missing authorization or a key fact that cannot be reasonably inferred. A free-form question with no candidate does not by itself block work. State assumptions without claiming the user answered.",
  ].join(" ")
}

export function answeredOutput(questions: ReadonlyArray<Prompt>, answers: ReadonlyArray<ReadonlyArray<string>>) {
  const formatted = questions
    .map(
      (question, index) =>
        `${JSON.stringify(question.question)}=${JSON.stringify(answers[index]?.length ? answers[index].join(", ") : "Unanswered")}`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}
