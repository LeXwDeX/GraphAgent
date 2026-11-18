// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LoopAnalysisResult, LoopIntent } from "@graphagent/schema/loop"
import { LoopValidate } from "@/loop/validate"

// The basis window is assembled by the caller (the analysis service) from genuine human messages only.
// Loop continuation messages, wake-ups, DAG and hook injections, and human messages from before the last
// committed analysis are therefore simply not in the set; the validator trusts the set as given.
const HUMAN_IN_WINDOW = "msg_human_in_window"
// Typed while an automatic turn was running and merged into it. The caller counts it as human input and puts it in the window.
const HUMAN_MERGED_INTO_TURN = "msg_human_merged_into_running_turn"
const HUMAN_BEFORE_WINDOW = "msg_human_before_last_analysis"
const LOOP_CONTINUATION = "msg_loop_continuation"
const WAKE_UP = "msg_wake_up"
const WINDOW: ReadonlySet<string> = new Set([HUMAN_IN_WINDOW, HUMAN_MERGED_INTO_TURN])
const OUTSIDE_WINDOW = [LOOP_CONTINUATION, WAKE_UP, HUMAN_BEFORE_WINDOW, "msg_unknown"]

const intent = (overrides: Partial<LoopIntent> = {}): LoopIntent => ({
  objective: "Ship the loop analysis service",
  acceptance: [
    { id: "A1", text: "The schema is exported", status: "unmet" },
    { id: "A2", text: "The validator rejects drift", status: "unmet" },
  ],
  constraints: ["Do not touch the shared runner"],
  non_goals: ["No new configuration keys"],
  assumptions: ["The session model has variants"],
  open_questions: [],
  ...overrides,
})

const allMet = (): LoopIntent =>
  intent({
    acceptance: [
      { id: "A1", text: "The schema is exported", status: "met", evidence: "packages/schema/src/loop.ts" },
      { id: "A2", text: "The validator rejects drift", status: "met", evidence: "test/loop/validate.test.ts" },
    ],
  })

const result = (overrides: Partial<LoopAnalysisResult> = {}): LoopAnalysisResult => ({
  verdict: "continue",
  intent: intent(),
  intent_change: { changed: false },
  progress: { advanced: true, summary: "Schema landed", done: ["schema"], remaining: ["validator"] },
  next_prompt: "Implement the validator and run its tests.",
  reason: "Two acceptance items are still unmet.",
  ...overrides,
})

const checkFirst = (submitted: LoopAnalysisResult, basisMessageIDs: ReadonlySet<string> = WINDOW) =>
  LoopValidate.check({ result: submitted, first: true, basisMessageIDs })

const checkLater = (
  submitted: LoopAnalysisResult,
  previous: LoopIntent = intent(),
  basisMessageIDs: ReadonlySet<string> = WINDOW,
) => LoopValidate.check({ result: submitted, first: false, previous, basisMessageIDs })

const rules = (violations: ReadonlyArray<LoopValidate.Violation>) => violations.map((violation) => violation.rule)

/** A change to the objective, with the given intent_change. */
const retarget = (change: LoopAnalysisResult["intent_change"]) =>
  result({ intent: intent({ objective: "Ship the loop analysis service and its UI" }), intent_change: change })

describe("LoopValidate.check", () => {
  test("a faithful analysis has no violations", () => {
    expect(checkFirst(result())).toEqual([])
    expect(checkLater(result())).toEqual([])
  })

  test("the input type ties `previous` to `first`", () => {
    // Compile-time contract, enforced by the typecheck; never called, since both calls would be malformed.
    const malformed = () => {
      // @ts-expect-error a non-first analysis must carry the previous intent
      LoopValidate.check({ result: result(), first: false, basisMessageIDs: WINDOW })
      // @ts-expect-error the first analysis has no previous intent
      LoopValidate.check({ result: result(), first: true, previous: intent(), basisMessageIDs: WINDOW })
    }
    expect(typeof malformed).toBe("function")
  })

  test("reports every violation at once, ordered by rule number, each with a message for the model", () => {
    const violations = checkLater(
      result({
        verdict: "blocked",
        intent: intent({ objective: "Something else", acceptance: [{ id: "A1", text: "The schema is exported", status: "unmet" }] }),
        reason: "",
      }),
    )
    expect(rules(violations)).toEqual(["V2", "V3", "V7", "V8"])
    for (const violation of violations) expect(violation.message.length).toBeGreaterThan(20)
  })
})

describe("V1: the first analysis", () => {
  test("accepts a non-empty objective with at least one acceptance item", () => {
    expect(checkFirst(result())).toEqual([])
  })

  test("rejects an empty acceptance list", () => {
    const violations = checkFirst(result({ intent: intent({ acceptance: [] }) }))
    expect(rules(violations)).toEqual(["V1"])
    expect(violations[0]?.message).toContain("intent.acceptance")
  })

  test("rejects a blank objective", () => {
    const violations = checkFirst(result({ intent: intent({ objective: "  \n" }) }))
    expect(rules(violations)).toEqual(["V1"])
    expect(violations[0]?.message).toContain("intent.objective")
  })

  test("rejects acceptance whose items all have blank text", () => {
    const violations = checkFirst(result({ intent: intent({ acceptance: [{ id: "A1", text: " ", status: "unmet" }] }) }))
    expect(rules(violations)).toEqual(["V1"])
  })

  test("rejects repeated acceptance ids, so the frozen anchor stays addressable", () => {
    const repeated = intent({
      acceptance: [
        { id: "A1", text: "first", status: "unmet" },
        { id: "A1", text: "second", status: "unmet" },
      ],
    })
    const violations = checkFirst(result({ intent: repeated }))
    expect(rules(violations)).toEqual(["V1"])
    expect(violations[0]?.message).toContain('"A1"')
  })

  test("applies only to the first analysis, and V2 / V3 do not apply to it", () => {
    // First: anything goes for objective and acceptance wording, with no change flag and no basis.
    expect(checkFirst(result({ intent: intent({ objective: "A brand new objective" }) }))).toEqual([])
    // Later: V1 is not checked, so a previous intent without acceptance may stay without acceptance.
    const bare = intent({ acceptance: [] })
    expect(checkLater(result({ intent: bare }), bare)).toEqual([])
  })
})

describe("V2: the intent stays verbatim unless a human message in the window asks for the change", () => {
  test("accepts an identical intent without a change flag", () => {
    expect(checkLater(result())).toEqual([])
  })

  test("accepts progress edits that need no basis: status, evidence, new items, assumptions, questions", () => {
    const progressed = intent({
      acceptance: [
        { id: "A1", text: "The schema is exported", status: "met", evidence: "packages/schema/src/loop.ts" },
        { id: "A2", text: "The validator rejects drift", status: "unmet" },
        { id: "A3", text: "highestVariant is exported", status: "unmet" },
      ],
      assumptions: ["A different assumption"],
      open_questions: ["Which tier should small models use?"],
    })
    expect(checkLater(result({ intent: progressed }))).toEqual([])
  })

  test("accepts reordering the acceptance list, since items are matched by id", () => {
    const reordered = intent({ acceptance: [...intent().acceptance].reverse() })
    expect(checkLater(result({ intent: reordered }))).toEqual([])
  })

  test("rejects a changed objective without intent_change.changed", () => {
    const violations = checkLater(retarget({ changed: false, basis_message_id: HUMAN_IN_WINDOW }))
    expect(rules(violations)).toEqual(["V2"])
    expect(violations[0]?.message).toContain("intent.objective")
    expect(violations[0]?.message).toContain("intent_change.changed")
  })

  test("rejects a changed objective whose change flag is set but has no basis message", () => {
    const violations = checkLater(retarget({ changed: true }))
    expect(rules(violations)).toEqual(["V2"])
    expect(violations[0]?.message).toContain("basis_message_id")
    expect(violations[0]?.message).toContain("missing")
  })

  for (const basis of OUTSIDE_WINDOW) {
    // Loop continuation message, wake-up message, human message from before the window, unknown id.
    test(`rejects a changed objective whose basis is outside the window (${basis})`, () => {
      const violations = checkLater(retarget({ changed: true, basis_message_id: basis }))
      expect(rules(violations)).toEqual(["V2"])
      expect(violations[0]?.message).toContain(basis)
    })
  }

  test("accepts a changed objective whose basis is a human message in the window", () => {
    expect(checkLater(retarget({ changed: true, basis_message_id: HUMAN_IN_WINDOW, summary: "User widened scope" }))).toEqual([])
  })

  test("accepts a basis that is a human message merged into a running automatic turn, once the caller put it in the window", () => {
    expect(checkLater(retarget({ changed: true, basis_message_id: HUMAN_MERGED_INTO_TURN }))).toEqual([])
  })

  test("with an empty window no change can be justified, and the message says why", () => {
    const violations = checkLater(retarget({ changed: true, basis_message_id: HUMAN_IN_WINDOW }), intent(), new Set())
    expect(rules(violations)).toEqual(["V2"])
    expect(violations[0]?.message).toContain("window is empty")
  })

  test("rejects changed constraints and non_goals the same way, reordering included", () => {
    const constraints = checkLater(result({ intent: intent({ constraints: ["Do not touch the shared runner", "Extra"] }) }))
    expect(rules(constraints)).toEqual(["V2"])
    expect(constraints[0]?.message).toContain("intent.constraints")

    const nonGoals = checkLater(result({ intent: intent({ non_goals: [] }) }))
    expect(rules(nonGoals)).toEqual(["V2"])
    expect(nonGoals[0]?.message).toContain("intent.non_goals")

    const previous = intent({ constraints: ["first", "second"] })
    expect(rules(checkLater(result({ intent: intent({ constraints: ["second", "first"] }) }), previous))).toEqual(["V2"])
  })

  test("accepts the same constraints and non_goals changes with a basis in the window", () => {
    const changed = result({
      intent: intent({ constraints: [], non_goals: ["No new configuration keys", "No UI"] }),
      intent_change: { changed: true, basis_message_id: HUMAN_IN_WINDOW },
    })
    expect(checkLater(changed)).toEqual([])
  })

  test("rejects rewriting the text of an existing acceptance item, and accepts it with a basis", () => {
    const rewritten = intent({
      acceptance: [
        { id: "A1", text: "The schema is exported and documented", status: "unmet" },
        { id: "A2", text: "The validator rejects drift", status: "unmet" },
      ],
    })
    const violations = checkLater(result({ intent: rewritten }))
    expect(rules(violations)).toEqual(["V2"])
    expect(violations[0]?.message).toContain('"A1"')

    expect(
      checkLater(result({ intent: rewritten, intent_change: { changed: true, basis_message_id: HUMAN_IN_WINDOW } })),
    ).toEqual([])
  })

  test("a change flag with nothing actually changed is not an error", () => {
    expect(checkLater(result({ intent_change: { changed: true, basis_message_id: LOOP_CONTINUATION } }))).toEqual([])
  })

  test("compares against the previous version, so a change already justified earlier is the new baseline", () => {
    const previous = intent({ objective: "Ship the loop analysis service and its UI" })
    expect(checkLater(result({ intent: previous }), previous)).toEqual([])
    expect(rules(checkLater(result({ intent: intent() }), previous))).toEqual(["V2"])
  })
})

describe("V3: acceptance items may be added but not deleted", () => {
  const withoutA2 = intent({ acceptance: [{ id: "A1", text: "The schema is exported", status: "unmet" }] })

  test("accepts added items without a basis", () => {
    const grown = intent({
      acceptance: [...intent().acceptance, { id: "A3", text: "highestVariant is exported", status: "unmet" }],
    })
    expect(checkLater(result({ intent: grown }))).toEqual([])
  })

  test("rejects deleting an item without a basis", () => {
    const violations = checkLater(result({ intent: withoutA2 }))
    expect(rules(violations)).toEqual(["V3"])
    expect(violations[0]?.message).toContain('"A2"')
  })

  test("rejects deleting an item whose basis is outside the window", () => {
    const violations = checkLater(result({ intent: withoutA2, intent_change: { changed: true, basis_message_id: WAKE_UP } }))
    expect(rules(violations)).toEqual(["V3"])
  })

  test("accepts deleting an item with a basis in the window", () => {
    expect(
      checkLater(result({ intent: withoutA2, intent_change: { changed: true, basis_message_id: HUMAN_IN_WINDOW } })),
    ).toEqual([])
  })

  test("renaming the id of an existing item counts as deleting it", () => {
    const renamed = intent({
      acceptance: [
        { id: "A1", text: "The schema is exported", status: "unmet" },
        { id: "B2", text: "The validator rejects drift", status: "unmet" },
      ],
    })
    const violations = checkLater(result({ intent: renamed }))
    expect(rules(violations)).toEqual(["V3"])
    expect(violations[0]?.message).toContain('"A2"')
  })

  test("deleting and rewriting together report both rules", () => {
    const both = intent({ acceptance: [{ id: "A1", text: "The schema is exported, documented", status: "unmet" }] })
    expect(rules(checkLater(result({ intent: both })))).toEqual(["V2", "V3"])
  })

  test("rejects repeated acceptance ids, so an existing item stays identifiable", () => {
    const repeated = intent({
      acceptance: [...intent().acceptance, { id: "A1", text: "A second A1", status: "unmet" }],
    })
    const violations = checkLater(result({ intent: repeated }))
    expect(rules(violations)).toEqual(["V3"])
    expect(violations[0]?.message).toContain('"A1"')
  })
})

describe("V4: done needs every item met with evidence and no open questions", () => {
  test("accepts done with all items met, evidence on each, and no open questions", () => {
    expect(checkLater(result({ verdict: "done", intent: allMet(), next_prompt: undefined }))).toEqual([])
  })

  test("rejects done while an item is unmet", () => {
    const partial = allMet()
    const violations = checkLater(
      result({
        verdict: "done",
        intent: { ...partial, acceptance: [partial.acceptance[0], { ...partial.acceptance[1], status: "unmet" }] },
      }),
    )
    expect(rules(violations)).toEqual(["V4"])
    expect(violations[0]?.message).toContain('"A2"')
  })

  test("rejects done when a met item has no evidence, or only blank evidence", () => {
    const partial = allMet()
    const missing = checkLater(
      result({
        verdict: "done",
        intent: { ...partial, acceptance: [{ ...partial.acceptance[0], evidence: undefined }, partial.acceptance[1]] },
      }),
    )
    expect(rules(missing)).toEqual(["V4"])
    expect(missing[0]?.message).toContain('"A1"')

    const blank = checkLater(
      result({
        verdict: "done",
        intent: { ...partial, acceptance: [partial.acceptance[0], { ...partial.acceptance[1], evidence: "  " }] },
      }),
    )
    expect(rules(blank)).toEqual(["V4"])
    expect(blank[0]?.message).toContain('"A2"')
  })

  test("rejects done while open questions remain", () => {
    const violations = checkLater(
      result({ verdict: "done", intent: { ...allMet(), open_questions: ["Which tier for small models?"] } }),
    )
    expect(rules(violations)).toEqual(["V4"])
    expect(violations[0]?.message).toContain("open_questions")
  })

  test("is not checked for other verdicts: continue with unmet items is fine", () => {
    expect(checkLater(result({ verdict: "continue" }))).toEqual([])
  })
})

describe("V5: continue needs a next_prompt of at most 8000 characters", () => {
  test("accepts a non-empty next_prompt, including one of exactly 8000 characters", () => {
    expect(checkLater(result({ next_prompt: "x".repeat(8000) }))).toEqual([])
  })

  test("rejects a missing, empty or blank next_prompt", () => {
    for (const prompt of [undefined, "", "   \n"]) {
      const violations = checkLater(result({ next_prompt: prompt }))
      expect(rules(violations)).toEqual(["V5"])
      expect(violations[0]?.message).toContain("next_prompt")
    }
  })

  test("rejects a next_prompt over 8000 characters", () => {
    const violations = checkLater(result({ next_prompt: "x".repeat(8001) }))
    expect(rules(violations)).toEqual(["V5"])
    expect(violations[0]?.message).toContain("8001")
    expect(violations[0]?.message).toContain("8000")
  })

  test("is not required for other verdicts", () => {
    expect(
      checkLater(result({ verdict: "blocked", intent: intent({ open_questions: ["Which database?"] }), next_prompt: undefined })),
    ).toEqual([])
  })
})

describe("V6: goal_changed and user_stop cite a human message in the window", () => {
  for (const verdict of ["goal_changed", "user_stop"] as const) {
    test(`${verdict}: accepts a basis that is a human message in the window`, () => {
      expect(
        checkLater(result({ verdict, intent_change: { changed: false, basis_message_id: HUMAN_IN_WINDOW }, next_prompt: undefined })),
      ).toEqual([])
    })

    test(`${verdict}: accepts a basis that is a human message merged into a running automatic turn`, () => {
      expect(
        checkLater(result({ verdict, intent_change: { changed: false, basis_message_id: HUMAN_MERGED_INTO_TURN } })),
      ).toEqual([])
    })

    test(`${verdict}: rejects a missing basis`, () => {
      const violations = checkLater(result({ verdict, intent_change: { changed: false } }))
      expect(rules(violations)).toEqual(["V6"])
      expect(violations[0]?.message).toContain(verdict)
      expect(violations[0]?.message).toContain("missing")
    })

    for (const basis of OUTSIDE_WINDOW) {
      test(`${verdict}: rejects a basis outside the window (${basis})`, () => {
        const violations = checkLater(result({ verdict, intent_change: { changed: false, basis_message_id: basis } }))
        expect(rules(violations)).toEqual(["V6"])
        expect(violations[0]?.message).toContain(basis)
      })
    }

    test(`${verdict}: also applies to the first analysis`, () => {
      expect(rules(checkFirst(result({ verdict, intent_change: { changed: false } })))).toEqual(["V6"])
      expect(checkFirst(result({ verdict, intent_change: { changed: false, basis_message_id: HUMAN_IN_WINDOW } }))).toEqual([])
    })
  }

  test("with an empty window neither verdict is available, and the message says so", () => {
    const violations = checkLater(
      result({ verdict: "user_stop", intent_change: { changed: false, basis_message_id: HUMAN_IN_WINDOW } }),
      intent(),
      new Set(),
    )
    expect(rules(violations)).toEqual(["V6"])
    expect(violations[0]?.message).toContain("window is empty")
  })

  test("is not checked for other verdicts: continue needs no basis", () => {
    expect(checkLater(result({ verdict: "continue", intent_change: { changed: false } }))).toEqual([])
  })
})

describe("V7: blocked needs open questions", () => {
  test("accepts blocked with a question only the user can answer", () => {
    expect(
      checkLater(result({ verdict: "blocked", intent: intent({ open_questions: ["Which database should it use?"] }) })),
    ).toEqual([])
  })

  test("rejects blocked without open questions, or with only blank ones", () => {
    for (const open_questions of [[], [""], ["  "]]) {
      const violations = checkLater(result({ verdict: "blocked", intent: intent({ open_questions }) }))
      expect(rules(violations)).toEqual(["V7"])
      expect(violations[0]?.message).toContain("open_questions")
    }
  })

  test("is not checked for other verdicts: continue with no questions is fine", () => {
    expect(checkLater(result({ verdict: "continue", intent: intent({ open_questions: [] }) }))).toEqual([])
  })
})

describe("V8: reason is non-empty and at most 300 characters", () => {
  test("accepts a reason of 1 and of exactly 300 characters", () => {
    expect(checkLater(result({ reason: "x" }))).toEqual([])
    expect(checkLater(result({ reason: "x".repeat(300) }))).toEqual([])
  })

  test("rejects an empty or blank reason", () => {
    for (const reason of ["", "  \n"]) {
      const violations = checkLater(result({ reason }))
      expect(rules(violations)).toEqual(["V8"])
      expect(violations[0]?.message).toContain("reason")
    }
  })

  test("rejects a reason over 300 characters", () => {
    const violations = checkLater(result({ reason: "x".repeat(301) }))
    expect(rules(violations)).toEqual(["V8"])
    expect(violations[0]?.message).toContain("301")
    expect(violations[0]?.message).toContain("300")
  })

  test("applies to every verdict", () => {
    const verdicts = ["continue", "done", "blocked", "goal_changed", "user_stop"] as const
    for (const verdict of verdicts) {
      expect(rules(checkLater(result({ verdict, reason: "" }))).includes("V8")).toBe(true)
    }
  })
})
