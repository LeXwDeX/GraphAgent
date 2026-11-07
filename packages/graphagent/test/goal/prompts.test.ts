import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { GoalState } from "@/goal/state"
import { GoalPrompts } from "@/goal/prompts"

// Decode a plain object into a branded GoalState.Info so tests stay free of
// `as any` brand casts. Decoding also exercises the optional/withDecodingDefault
// fields (subgoals defaults to [], optional verdict/reason stay undefined).
function mkState(overrides: Partial<{
  goal: string
  status: "active" | "paused" | "done"
  turns_used: number
  max_turns: number
  created_at: number
  last_turn_at: number
  last_verdict: "done" | "continue"
  last_reason: string
  paused_reason: string
  subgoals: ReadonlyArray<string>
}>): GoalState.Info {
  return Schema.decodeUnknownSync(GoalState.Info)({
    goal: "ship the feature",
    status: "active",
    turns_used: 3,
    max_turns: 20,
    created_at: 1000,
    last_turn_at: 2000,
    last_verdict: "continue",
    last_reason: "making progress",
    consecutive_parse_failures: 0,
    subgoals: [],
    ...overrides,
  })
}

describe("GoalPrompts.renderGoalSystemBlock (D4.1 dynamic system prompt)", () => {
  test("active goal with subgoals renders structured live-state block", () => {
    const block = GoalPrompts.renderGoalSystemBlock(
      mkState({
        goal: "Add login page",
        status: "active",
        turns_used: 3,
        max_turns: 20,
        subgoals: ["write tests", "wire route"],
        last_verdict: "continue",
        last_reason: "tests passing, route pending",
      }),
    )

    expect(block).toContain("## Current Goal (autonomous loop)")
    expect(block).toContain("Goal: Add login page")
    expect(block).toContain("Status: active")
    expect(block).toContain("Turns: 3/20 (17 remaining)")
    expect(block).toContain("Subgoals:")
    expect(block).toContain("1. write tests")
    expect(block).toContain("2. wire route")
    expect(block).toContain("Last judge verdict: continue — tests passing, route pending")
  })

  test("paused goal surfaces the paused reason", () => {
    const block = GoalPrompts.renderGoalSystemBlock(
      mkState({
        status: "paused",
        paused_reason: "budget exhausted",
        turns_used: 20,
        max_turns: 20,
      }),
    )

    expect(block).toContain("Status: paused")
    expect(block).toContain("Paused because: budget exhausted")
    expect(block).toContain("Turns: 20/20 (0 remaining)")
  })

  test("goal with no subgoals reports none", () => {
    const block = GoalPrompts.renderGoalSystemBlock(mkState({ subgoals: [] }))
    expect(block).toContain("Subgoals: none")
    expect(block).not.toMatch(/Subgoals:\n/)
  })

  test("goal without a prior verdict omits the judge line", () => {
    const block = GoalPrompts.renderGoalSystemBlock(
      mkState({ last_verdict: undefined, last_reason: undefined }),
    )
    expect(block).not.toContain("Last judge verdict")
  })

  test("verdict present without reason still renders the verdict", () => {
    const block = GoalPrompts.renderGoalSystemBlock(
      mkState({ last_verdict: "continue", last_reason: undefined }),
    )
    expect(block).toContain("Last judge verdict: continue")
    expect(block).not.toContain("Last judge verdict: continue —")
  })
})

describe("GoalPrompts.renderContinuation (D4.2 merged injection)", () => {
  test("renders goal, turns/budget, and the autonomous-mode frame", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: [],
      turnsUsed: 3,
      maxTurns: 20,
    })

    expect(text).toContain("[Continuing toward your standing goal]")
    expect(text).toContain("Goal: Add login page")
    expect(text).toContain("Turns: 3/20 (17 remaining)")
    expect(text).toContain("autonomous mode")
    expect(text).toContain("Do not ask the user for clarification or confirmation.")
    expect(text).toContain("Take the next concrete step.")
  })

  test("numbers subgoals when present", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: ["write tests", "wire route"],
      turnsUsed: 1,
      maxTurns: 10,
    })

    expect(text).toContain("Subgoals:")
    expect(text).toContain("1. write tests")
    expect(text).toContain("2. wire route")
  })

  test("omits the subgoals block when there are none", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: [],
      turnsUsed: 1,
      maxTurns: 10,
    })
    expect(text).not.toContain("Subgoals:")
  })

  test("labels the last judge reason when provided", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: [],
      turnsUsed: 2,
      maxTurns: 10,
      lastJudgeReason: "needs error handling",
    })
    expect(text).toContain("Judge feedback: needs error handling")
  })

  test("omits the judge feedback line when no reason is given", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: [],
      turnsUsed: 2,
      maxTurns: 10,
    })
    expect(text).not.toContain("Judge feedback:")
  })

  test("clamps remaining turns at zero when budget exhausted", () => {
    const text = GoalPrompts.renderContinuation({
      goal: "Add login page",
      subgoals: [],
      turnsUsed: 20,
      maxTurns: 20,
    })
    expect(text).toContain("Turns: 20/20 (0 remaining)")
  })
})

describe("GoalPrompts.renderJudgeUserPrompt", () => {
  const responseSection = (prompt: string) => /---\n([\s\S]*)\n---/.exec(prompt)?.[1]

  test("an agent response containing replacement patterns reaches the judge verbatim", () => {
    const response = "Fixed it with: printf $'line1\\nline2' and kept $& and $` literal"
    const prompt = GoalPrompts.renderJudgeUserPrompt("make the script print two lines", response, [])
    expect(responseSection(prompt)).toBe(response)
  })

  test("a goal that mentions a placeholder does not capture the agent response", () => {
    const prompt = GoalPrompts.renderJudgeUserPrompt(
      "fix the email template so the {response} placeholder renders",
      "AGENT-OUTPUT: template fixed, tests pass",
      [],
    )
    expect(responseSection(prompt)).toBe("AGENT-OUTPUT: template fixed, tests pass")
    expect(prompt).toContain("Goal: fix the email template so the {response} placeholder renders")
  })

  test("subgoals that mention placeholders are rendered literally", () => {
    const prompt = GoalPrompts.renderJudgeUserPrompt("ship it", "AGENT-OUTPUT", ["render {response}", "keep {goal}"])
    expect(prompt).toContain("1. render {response}\n2. keep {goal}")
    expect(prompt).toContain("Goal: ship it")
    expect(responseSection(prompt)).toBe("AGENT-OUTPUT")
  })
})
