import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import {
  AdmissionRecord,
  AdmissionTransitionError,
  evaluateQa,
  fingerprintBrief,
  Modes,
  QaPolicies,
  projectBriefForNode,
  States,
  transitionAdmission,
  validateAdmission,
  Verdicts,
} from "@/dag/admission"

const readyBrief = {
  goal: "Add durable deep-workflow admission",
  scope: {
    in: ["workflow start", "DAG validation"],
    out: ["admission management UI"],
  },
  constraints: ["standard workflows remain compatible"],
  assumptions: ["the parent session can ask questions"],
  acceptance_criteria: ["deep start rejects unresolved blockers"],
  evidence_required: ["unit tests", "integration tests"],
  risks: ["users may overuse waivers"],
  review_plan: ["verify implementation", "review the actual diff"],
  open_questions: [],
  blocking_questions: [],
}

function recordFor(verdict: (typeof Verdicts)[number], qaMode: (typeof Modes)[number]) {
  const brief = verdict === "READY"
    ? readyBrief
    : {
        ...readyBrief,
        blocking_questions: ["Which deployment environments are required?"],
      }
  return {
    protocol_version: 1,
    brief_revision: 1,
    qa_mode: qaMode,
    verdict,
    state: verdict,
    fingerprint: fingerprintBrief(brief),
    brief,
    ...(verdict === "WAIVED"
      ? {
          waiver_reason: "Proceed with preview-only deployment",
          acknowledged_risks: ["Production deployment remains unspecified"],
        }
      : {}),
  }
}

describe("DAG admission", () => {
  it("accepts exactly the specified admission state transitions", () => {
    const allowed = new Set([
      "UNASSESSED:QUESTIONING",
      "UNASSESSED:WAIVED",
      "QUESTIONING:READY",
      "QUESTIONING:NOT_READY",
      "QUESTIONING:WAIVED",
      "NOT_READY:QUESTIONING",
      "NOT_READY:WAIVED",
      "NOT_READY:INVALIDATED",
      "READY:INVALIDATED",
      "READY:CONSUMED",
      "WAIVED:INVALIDATED",
      "WAIVED:CONSUMED",
      "INVALIDATED:QUESTIONING",
    ])

    for (const current of States) {
      for (const target of States) {
        const key = `${current}:${target}`
        if (allowed.has(key)) {
          expect(transitionAdmission(current, target)).toBe(target)
          continue
        }
        expect(() => transitionAdmission(current, target)).toThrow(AdmissionTransitionError)
        expect(() => transitionAdmission(current, target)).toThrow(`${current} -> ${target}`)
      }
    }
  })

  it("decodes every QA mode and final verdict fixture", () => {
    const decode = Schema.decodeUnknownSync(AdmissionRecord)
    for (const qaMode of Modes) {
      for (const verdict of Verdicts) {
        expect(decode(recordFor(verdict, qaMode))).toEqual(recordFor(verdict, qaMode))
      }
    }
  })

  it("rejects records missing required Requirement Brief fields", () => {
    const decode = Schema.decodeUnknownSync(AdmissionRecord)
    const input = recordFor("READY", "STANDARD")
    expect(() => decode({
      ...input,
      brief: {
        ...input.brief,
        acceptance_criteria: undefined,
      },
    })).toThrow()
  })

  it("rejects READY when required content is blank or blockers remain", () => {
    const input = recordFor("READY", "STANDARD")
    expect(validateAdmission({
      ...input,
      brief: {
        ...input.brief,
        goal: " ",
        blocking_questions: ["Define the rollout target"],
      },
    })).toEqual({
      valid: false,
      errors: [
        "brief.goal must not be blank",
        "READY admission must not contain blocking_questions",
        "fingerprint does not match the canonical Requirement Brief",
      ],
    })
  })

  it("rejects an uninformed WAIVED verdict", () => {
    const input = recordFor("WAIVED", "GRILL")
    expect(validateAdmission({
      ...input,
      waiver_reason: " ",
      acknowledged_risks: [],
    })).toEqual({
      valid: false,
      errors: [
        "WAIVED admission requires waiver_reason",
        "WAIVED admission requires acknowledged_risks",
      ],
    })
  })

  it("fingerprints canonical briefs deterministically and tracks revisions", () => {
    const reordered = {
      ...readyBrief,
      scope: {
        in: ["DAG validation", "workflow start"],
        out: ["admission management UI"],
      },
      evidence_required: ["integration tests", "unit tests"],
    }
    expect(fingerprintBrief(reordered)).toBe(fingerprintBrief(readyBrief))
    expect(fingerprintBrief({
      ...readyBrief,
      acceptance_criteria: ["deep start accepts unresolved blockers"],
    })).not.toBe(fingerprintBrief(readyBrief))
    expect(fingerprintBrief(readyBrief)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("stops questioning early when the brief is ready", () => {
    for (const qaMode of Modes) {
      expect(evaluateQa({
        qa_mode: qaMode,
        rounds_completed: 0,
        brief: readyBrief,
      })).toEqual({
        state: "READY",
        blockers: [],
        rounds_remaining: QaPolicies[qaMode].max_rounds,
      })
    }
  })

  it("uses one, three, and five round budgets before NOT_READY", () => {
    expect(QaPolicies).toEqual({
      LIGHT: { max_rounds: 1 },
      STANDARD: { max_rounds: 3 },
      GRILL: { max_rounds: 5 },
    })
    const brief = {
      ...readyBrief,
      acceptance_criteria: [],
      blocking_questions: ["Define the acceptance criteria"],
    }

    for (const qaMode of Modes) {
      const max = QaPolicies[qaMode].max_rounds
      expect(evaluateQa({
        qa_mode: qaMode,
        rounds_completed: max - 1,
        brief,
      })).toEqual({
        state: "QUESTIONING",
        blockers: [
          "brief.acceptance_criteria must contain at least one item",
          "Define the acceptance criteria",
        ],
        rounds_remaining: 1,
      })
      expect(evaluateQa({
        qa_mode: qaMode,
        rounds_completed: max,
        brief,
      })).toEqual({
        state: "NOT_READY",
        blockers: [
          "brief.acceptance_criteria must contain at least one item",
          "Define the acceptance criteria",
        ],
        rounds_remaining: 0,
      })
    }
  })

  it("projects bounded execution context without QA transcript chatter", () => {
    const projection = projectBriefForNode({
      ...readyBrief,
      constraints: Array.from({ length: 25 }, (_, index) => `constraint-${index}-${"x".repeat(600)}`),
      open_questions: ["raw QA transcript: maybe later"],
      blocking_questions: ["raw QA transcript: unanswered"],
    })

    expect(projection).toEqual({
      goal: readyBrief.goal,
      scope: readyBrief.scope,
      constraints: expect.any(Array),
      assumptions: readyBrief.assumptions,
      acceptance_criteria: readyBrief.acceptance_criteria,
      evidence_required: readyBrief.evidence_required,
      risks: readyBrief.risks,
      review_plan: readyBrief.review_plan,
    })
    expect(projection.constraints).toHaveLength(20)
    expect(projection.constraints.every((value) => value.length <= 500)).toBe(true)
    expect(JSON.stringify(projection)).not.toContain("raw QA transcript")
    expect(projection).not.toHaveProperty("open_questions")
    expect(projection).not.toHaveProperty("blocking_questions")
  })
})
