import { GoalState } from "./state"

export * as GoalPrompts from "./prompts"

export const DEFAULT_MAX_TURNS = 20
// Seconds — used as `Effect.timeout(`${timeout} seconds`)` in loop.ts.
// Was 30_000 (ms) which produced "30000 seconds" = 8.3h (effectively no timeout).
export const DEFAULT_JUDGE_TIMEOUT_SECONDS = 30
export const MAX_CONSECUTIVE_PARSE_FAILURES = 3
// Known tradeoff: the judge only sees the last JUDGE_RESPONSE_SNIPPET_CHARS of
// the final assistant message. This bounds judge cost/latency but means a long
// response that buries a problem in an earlier section can pass review. The
// budget is generous for normal replies; the limit is also surfaced in
// tool/goal.txt so operators know the judge's view is tail-bounded.
export const JUDGE_RESPONSE_SNIPPET_CHARS = 4000
// Zombie-goal freshness guard threshold (D6). A goal that is still active with
// turns_used 0 after this many ms, and whose initial kick produced no assistant
// message, is treated as orphaned and auto-paused so the user can recover via
// /goal resume instead of the goal sitting silently "active" forever.
export const FRESHNESS_THRESHOLD = 120_000

export const JUDGE_SYSTEM_PROMPT = `You are an autonomous-goal completion judge.
You receive:
1. The user's original goal.
2. The agent's most recent response.

Return only a JSON object. Do not add markdown or explanation. Keep the reason under 160 characters:
{"verdict": "done" | "continue" | "blocked", "reason": "one sentence explanation"}

Use "done" only when at least one condition is true:
- The agent explicitly says the goal is complete and gives evidence.
- The goal produced a clear, verifiable result, such as a created file or passing test.

Use "blocked" when progress requires user input or an external-state change.

Use "continue" while the agent is making progress or has more steps.

When unsure, choose "continue".`

export const JUDGE_USER_PROMPT_TEMPLATE = `Goal: {goal}

Agent's most recent response (last {snippetChars} chars):
---
{response}
---

Is the goal done?`

export const JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE = `Goal: {goal}

Additional criteria:
{subgoals}

Agent's most recent response (last {snippetChars} chars):
---
{response}
---

Is the goal done? Check each sub-goal against concrete evidence. Return only the verdict and one short reason. Do not list sub-goals or accept vague claims such as "all requirements met".`

export interface ContinuationInput {
  readonly goal: string
  readonly subgoals: ReadonlyArray<string>
  readonly turnsUsed: number
  readonly maxTurns: number
  readonly lastJudgeReason?: string
}

// Renders the continuation sent as synthetic user text. It reaches the model
// without appearing as human input in Memory or the visible conversation.
export function renderContinuation(input: ContinuationInput): string {
  const remaining = Math.max(0, input.maxTurns - input.turnsUsed)
  const lines = [
    "[Continuing toward your standing goal]",
    `Goal: ${input.goal}`,
    `Turns: ${input.turnsUsed}/${input.maxTurns} (${remaining} remaining)`,
  ]
  if (input.subgoals.length > 0) {
    lines.push("Subgoals:")
    lines.push(...input.subgoals.map((s, i) => `${i + 1}. ${s}`))
  }
  if (input.lastJudgeReason) lines.push(`Judge feedback: ${input.lastJudgeReason}`)
  lines.push("")
  lines.push(
    "You are in autonomous mode. Interactive questions are disabled and will not receive answers. Do not ask the user for clarification or confirmation. Make decisions independently using your best judgment.",
  )
  lines.push("")
  lines.push("Continue working toward this goal. Take the next concrete step.")
  lines.push("If you believe the goal is complete, state so explicitly and stop.")
  lines.push("If you are completely blocked and cannot make any progress, state the blocker explicitly and stop.")
  return lines.join("\n")
}

// Renders the live-state fragment for an active/paused goal.
// Pure: SystemPrompt.goal(sessionID) returns it as runtime context, outside the cached system prefix.
export function renderGoalSystemBlock(state: GoalState.Info): string {
  const turnsUsed = state.turns_used
  const maxTurns = state.max_turns
  const remaining = Math.max(0, maxTurns - turnsUsed)
  const subgoals = state.subgoals ?? []
  const lines = [
    "## Current Goal (autonomous loop)",
    `Goal: ${state.goal}`,
    `Status: ${state.status}`,
    `Turns: ${turnsUsed}/${maxTurns} (${remaining} remaining)`,
  ]
  if (subgoals.length > 0) {
    lines.push("Subgoals:")
    lines.push(...subgoals.map((s, i) => `  ${i + 1}. ${s}`))
  } else {
    lines.push("Subgoals: none")
  }
  if (state.status === "paused" && state.paused_reason) {
    lines.push(`Paused because: ${state.paused_reason}`)
  }
  if (state.last_verdict) {
    lines.push(
      state.last_reason
        ? `Last judge verdict: ${state.last_verdict} — ${state.last_reason}`
        : `Last judge verdict: ${state.last_verdict}`,
    )
  }
  return lines.join("\n")
}

export function renderJudgeUserPrompt(goal: string, response: string, subgoals: ReadonlyArray<string>): string {
  const values: Record<string, string> = {
    goal,
    subgoals: subgoals.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    snippetChars: String(JUDGE_RESPONSE_SNIPPET_CHARS),
    response: response.slice(-JUDGE_RESPONSE_SNIPPET_CHARS),
  }
  const template = subgoals.length === 0 ? JUDGE_USER_PROMPT_TEMPLATE : JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE
  // Single pass with a function replacer: inserted text is never re-scanned
  // for placeholders, and `$&`, `$'`, `` $` `` in it are never expanded.
  return template.replace(/\{(goal|subgoals|snippetChars|response)\}/g, (_, key: string) => values[key])
}
