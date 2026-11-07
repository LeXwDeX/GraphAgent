export * as GoalJudge from "./judge"

import { Cause, Effect } from "effect"
import { GoalPrompts } from "./prompts"

/** Privacy-safe failure category: error tag or class name only, never the message (may echo wire content). */
const errorCategory = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const tag = (cause as { _tag?: unknown })._tag
    if (typeof tag === "string") return tag
    const name = (cause as { name?: unknown }).name
    if (typeof name === "string") return name
  }
  return "unknown"
}

export interface JudgeResult {
  readonly verdict: "done" | "continue" | "blocked"
  readonly reason: string
  readonly parseFailed: boolean
  readonly failureCategory?: JudgeFailureCategory
}

export interface Request {
  system: string
  user: string
  temperature: number
  maxTokens: number
  timeout: number
  attempt: number
}

export interface Completion {
  text: string
  finishReason: string
  outputTokens?: number
  reasoningTokens?: number
  sessionID?: string
  providerID?: string
  modelID?: string
}

export type CallLLM = (opts: Request) => Effect.Effect<string | Completion, Error>

export type JudgeFailureCategory =
  | "empty"
  | "truncated-json"
  | "malformed-json"
  | "invalid-shape"
  | "non-json"
  | "transport-error"

function verdict(value: unknown): JudgeResult | undefined {
  let result: JudgeResult | undefined
  if (value && typeof value === "object") {
    if (
      "verdict" in value &&
      (value.verdict === "done" || value.verdict === "continue" || value.verdict === "blocked") &&
      "reason" in value &&
      typeof value.reason === "string"
    )
      result = { verdict: value.verdict, reason: value.reason, parseFailed: false }
    else if (
      "done" in value &&
      typeof value.done === "boolean" &&
      "reason" in value &&
      typeof value.reason === "string"
    )
      result = { verdict: value.done ? "done" : "continue", reason: value.reason, parseFailed: false }
  }
  return result
}

function objectCandidates(input: string) {
  const values: string[] = []
  let unclosed = false
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (start < 0) {
      if (char === "{") {
        start = index
        depth = 1
        quoted = false
        escaped = false
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      values.push(input.slice(start, index + 1))
      start = -1
    }
    // A candidate still open at the end of the text may be a stray `{` in
    // prose (e.g. quoted code) rather than truncated JSON: record it, then
    // rescan from just after that brace so a complete object behind it is
    // still found. The truncated-json category is kept for the caller.
    if (start >= 0 && index === input.length - 1) {
      unclosed = true
      index = start
      start = -1
    }
  }
  // A `{` as the very last character opens a candidate the loop never scans.
  return { values, unclosed: unclosed || start >= 0 }
}

function failed(category: JudgeFailureCategory, chars: number): JudgeResult {
  const detail =
    category === "empty"
      ? "返回空响应"
      : category === "truncated-json"
        ? "返回疑似截断的 JSON"
        : category === "malformed-json"
          ? "返回格式错误的 JSON"
          : category === "invalid-shape"
            ? "返回 JSON，但缺少有效 verdict/reason"
            : category === "non-json"
              ? "返回非 JSON 内容"
              : "调用失败（transport-error）"
  return {
    verdict: "continue",
    reason: `judge ${detail}（${chars} 字符）`,
    parseFailed: true,
    failureCategory: category,
  }
}

export function parseJudgeResponse(raw: string): JudgeResult {
  // Parse before removing fences: a reason can contain literal markdown.
  try {
    return verdict(JSON.parse(raw)) ?? failed("invalid-shape", raw.trim().length)
  } catch {}
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim()
  if (!stripped) return failed("empty", 0)

  try {
    return verdict(JSON.parse(stripped)) ?? failed("invalid-shape", stripped.length)
  } catch {}

  const candidates = objectCandidates(stripped)
  let malformed = false
  let invalidShape = false
  for (const candidate of candidates.values) {
    try {
      const parsed = verdict(JSON.parse(candidate))
      if (parsed) return parsed
      invalidShape = true
    } catch {
      malformed = true
    }
  }

  if (candidates.unclosed) return failed("truncated-json", stripped.length)
  if (invalidShape) return failed("invalid-shape", stripped.length)
  if (malformed || stripped.includes("{") || stripped.includes("}")) return failed("malformed-json", stripped.length)
  return failed("non-json", stripped.length)
}

export const run = Effect.fn("Goal.Judge.run")(function* (
  goal: string,
  response: string,
  subgoals: ReadonlyArray<string>,
  callLLM: CallLLM,
) {
  const userPrompt = GoalPrompts.renderJudgeUserPrompt(goal, response, subgoals)

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = yield* Effect.suspend(() =>
      callLLM({
        system: GoalPrompts.JUDGE_SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0,
        maxTokens: attempt === 1 ? 1024 : 2048,
        timeout: GoalPrompts.DEFAULT_JUDGE_TIMEOUT_SECONDS,
        attempt,
      }),
    ).pipe(
      Effect.timeout(`${GoalPrompts.DEFAULT_JUDGE_TIMEOUT_SECONDS} seconds`),
      Effect.flatMap((completion) => {
        const text = typeof completion === "string" ? completion : completion.text
        const parsed = parseJudgeResponse(text)
        return Effect.logInfo("goal judge response", {
          "goal.judge.attempt": attempt,
          "goal.judge.output_characters": text.length,
          "goal.judge.failure_category": parsed.failureCategory,
          ...(typeof completion === "string"
            ? {}
            : {
                "goal.judge.finish_reason": completion.finishReason,
                "goal.judge.output_tokens": completion.outputTokens,
                "goal.judge.reasoning_tokens": completion.reasoningTokens,
                "goal.judge.session_id": completion.sessionID,
                "goal.judge.provider_id": completion.providerID,
                "goal.judge.model_id": completion.modelID,
              }),
        }).pipe(Effect.as(parsed))
      }),
      // Transport errors (timeout, network, non-JSON transport-level failure)
      // count toward the pause budget. Previously they returned
      // parseFailed: false, which reset consecutive_parse_failures and let a
      // flaky provider alternate bad-JSON and timeout indefinitely without
      // ever hitting MAX_CONSECUTIVE_PARSE_FAILURES. Returning parseFailed: true
      // feeds them through the same auto-pause path as parse failures, treating
      // "judge is unreliable" uniformly regardless of failure mode. The verdict
      // stays "continue" so a single transient blip does not stall the loop;
      // it only pauses after MAX_CONSECUTIVE_PARSE_FAILURES in a row.
      //
      // catchCause (not orElseSucceed): the production callLLM chain can
      // DEFECT — config first-use orDie, payload decode throws — and a defect
      // escaping here kills afterIdle invisibly (the loop stalls at 0 turns
      // with zero logs and no pause budget). catchCause folds defects into
      // the same parseFailed budget.
      Effect.catchCause((cause) =>
        Effect.logWarning("goal judge transport failure", {
          "goal.judge.attempt": attempt,
          "goal.judge.error_category": errorCategory(Cause.squash(cause)),
        }).pipe(Effect.as(failed("transport-error", 0))),
      ),
    )
    if (!result.parseFailed || attempt === 2) return result
  }
  return failed("transport-error", 0)
})
