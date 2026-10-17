const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Programmatic answers for the question tool, supplied by a PreToolUse hook as
 * `permissionDecision:"allow"` plus `updatedInput.answers` (the Claude AskUserQuestion shape):
 * an object mapping each question's text to the chosen label. Multi-select answers are joined
 * with commas.
 *
 * Every question must be answered and nothing else may be present, so a partial or mismatched
 * object cannot silently stand in for the user. Free text is accepted because the tool allows
 * custom answers by default.
 */
export function hookQuestionAnswers(questions: unknown, answers: unknown): ReadonlyArray<ReadonlyArray<string>> {
  if (!Array.isArray(questions) || !isRecord(answers))
    throw new Error("Hook answers must be an object keyed by question")
  const prompts = questions.map((item) => (isRecord(item) ? item : {}))
  const texts = prompts.map((prompt) => prompt.question)
  const unknownKeys = Object.keys(answers).filter((key) => !texts.includes(key))
  if (unknownKeys.length > 0)
    throw new Error(
      `Hook answers do not match any question: ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`,
    )
  return prompts.map((prompt) => {
    const text = prompt.question
    const value = typeof text === "string" ? answers[text] : undefined
    if (typeof text !== "string" || typeof value !== "string" || value.trim() === "")
      throw new Error(`Hook answers are missing a non-empty answer for ${JSON.stringify(text)}`)
    return prompt.multiple === true
      ? value
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean)
      : [value]
  })
}
