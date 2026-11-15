// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M6: cross-round review arbitration — dispositions/resolved coverage,
// prior-round injection, round accounting, and the strict lane-completeness
// rule.
import { describe, expect, it } from "bun:test"
import { DagBlocks, type PriorRound } from "@/dag/blocks"
import {
  arbitrationConsistencyErrors,
  reviewRoundMetrics,
  reviewRoundSummary,
  type VerdictEvidence,
} from "@/dag/review-lifecycle"
import { settleCapturedOutput } from "@/dag/runtime/capture"

const lane = (nodeID: string, required: string[]): VerdictEvidence => ({
  nodeID,
  output: { verdict: required.length > 0 ? "REJECT" : "ACCEPT", required_actions: required },
})

const disposition = (node: string, index: number, decision: "upheld" | "refuted", novelty: unknown = "new") => ({
  node,
  index,
  novelty,
  decision,
  evidence: `${node}[${index}] evidence`,
})

const prior = (ref: string): PriorRound["findings"][number] => ({
  ref,
  node: "review--intent",
  index: 0,
  action: "Fix the boundary check",
})

const evidence = [lane("review--standards", ["A", "B"]), lane("review--intent", ["C"])]

const actionsOf = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null) return []
  const actions = Reflect.get(value, "required_actions")
  return Array.isArray(actions) ? actions.filter((action): action is string => typeof action === "string") : []
}

describe("arbitrationConsistencyErrors", () => {
  it("rejects a decision that submits neither dispositions nor resolved", () => {
    const errors = arbitrationConsistencyErrors({ verdict: "REJECT" }, evidence)
    expect(errors).toContain("decision must submit dispositions covering every lane required action")
    expect(errors).toContain("decision must submit resolved covering every prior finding")
    expect(errors).toContain("dispositions miss lane required action(s): review--standards[0], review--standards[1], review--intent[0]")
  })

  it("rejects missing dispositions regardless of the verdict", () => {
    const errors = arbitrationConsistencyErrors(
      { verdict: "BLOCKED", dispositions: [disposition("review--standards", 0, "refuted")], resolved: [] },
      evidence,
    )
    expect(errors).toEqual([
      "dispositions miss lane required action(s): review--standards[1], review--intent[0]",
    ])
  })

  it("rejects a missing resolution for a prior finding", () => {
    const errors = arbitrationConsistencyErrors(
      {
        verdict: "REJECT",
        dispositions: evidence.flatMap((item) =>
          actionsOf(item.output).map((_, index) => disposition(item.nodeID, index, "upheld")),
        ),
        resolved: [],
      },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")] },
    )
    expect(errors).toEqual(["resolved misses prior finding(s): wf-prev/review--intent/0"])
  })

  it("rejects a dangling dup_of reference", () => {
    const errors = arbitrationConsistencyErrors(
      {
        verdict: "REJECT",
        dispositions: [
          disposition("review--standards", 0, "upheld", { dup_of: "wf-prev/missing/9" }),
          disposition("review--standards", 1, "refuted"),
          disposition("review--intent", 0, "refuted"),
        ],
        resolved: [],
      },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")] },
    )
    expect(errors).toContain("dispositions name dup_of ref(s) that are not prior findings: wf-prev/missing/9")
  })

  it("rejects an ACCEPT that upholds a finding or leaves a prior finding open", () => {
    const upheld = arbitrationConsistencyErrors(
      {
        verdict: "ACCEPT",
        dispositions: [
          disposition("review--standards", 0, "upheld"),
          disposition("review--standards", 1, "refuted"),
          disposition("review--intent", 0, "refuted"),
        ],
        resolved: [],
      },
      evidence,
    )
    expect(upheld).toContain("ACCEPT upholds finding(s) review--standards[0]; fix them or submit a non-ACCEPT verdict")

    const open = arbitrationConsistencyErrors(
      {
        verdict: "ACCEPT",
        dispositions: [
          disposition("review--standards", 0, "refuted"),
          disposition("review--standards", 1, "refuted"),
          disposition("review--intent", 0, "refuted"),
        ],
        resolved: [{ ref: "wf-prev/review--intent/0", how: "still_open", evidence: "not addressed" }],
      },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")] },
    )
    expect(open).toContain("ACCEPT leaves prior finding(s) still open: wf-prev/review--intent/0")
  })

  it("rejects an ACCEPT whose duplicate points at a still-open prior finding", () => {
    const errors = arbitrationConsistencyErrors(
      {
        verdict: "ACCEPT",
        dispositions: [
          disposition("review--standards", 0, "refuted", { dup_of: "wf-prev/review--intent/0" }),
          disposition("review--standards", 1, "refuted"),
          disposition("review--intent", 0, "refuted"),
        ],
        resolved: [{ ref: "wf-prev/review--intent/0", how: "still_open", evidence: "not addressed" }],
      },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")] },
    )
    expect(errors).toContain(
      "ACCEPT hides still-open work behind duplicates: review--standards[0] duplicates still-open wf-prev/review--intent/0",
    )
  })

  it("accepts a fully accounted non-ACCEPT and refuses an ACCEPT with an incomplete strict lane", () => {
    const output = {
      verdict: "REJECT",
      dispositions: [
        disposition("review--standards", 0, "upheld"),
        disposition("review--standards", 1, "refuted"),
        disposition("review--intent", 0, "upheld"),
      ],
      resolved: [{ ref: "wf-prev/review--intent/0", how: "fixed", evidence: "src/a.ts:3" }],
    }
    expect(arbitrationConsistencyErrors(output, evidence, { priorFindings: [prior("wf-prev/review--intent/0")] })).toEqual(
      [],
    )

    const incomplete = arbitrationConsistencyErrors(
      { ...output, verdict: "ACCEPT" },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")], strict: true, incompleteReviewLanes: ["review--security"] },
    )
    expect(incomplete).toContain(
      "ACCEPT requires every review lane to complete under the strict gate; not completed: review--security. Submit BLOCKED or REJECT",
    )
    const blocked = arbitrationConsistencyErrors(
      { ...output, verdict: "BLOCKED" },
      evidence,
      { priorFindings: [prior("wf-prev/review--intent/0")], strict: true, incompleteReviewLanes: ["review--security"] },
    )
    expect(blocked).toEqual([])
  })

  it("only enforces the arbitration contract on block-compiled decisions", () => {
    expect(settleCapturedOutput({ verdict: "ACCEPT", required_actions: [] }, undefined).kind).toBe("complete")
    const failed = settleCapturedOutput({ verdict: "ACCEPT", required_actions: [] }, undefined, "", true, [], {
      reviewArbitration: true,
    })
    expect(failed.kind).toBe("fail")
    if (failed.kind !== "fail") return
    expect(failed.reason).toContain("decision must submit dispositions")
  })
})

describe("review round accounting", () => {
  const rounds = [
    {
      evidence: [lane("review--standards", ["A", "B"]), lane("review--intent", ["C"])],
      output: {
        verdict: "REJECT",
        dispositions: [
          disposition("review--standards", 0, "upheld"),
          disposition("review--standards", 1, "refuted"),
          disposition("review--intent", 0, "upheld"),
        ],
        resolved: [],
      },
    },
    {
      evidence: [lane("review--intent", ["D"])],
      output: {
        verdict: "REJECT",
        dispositions: [disposition("review--intent", 0, "upheld")],
        resolved: [
          { ref: "r0/a", how: "fixed", evidence: "fixed A" },
          { ref: "r0/b", how: "refuted", evidence: "not a defect" },
        ],
      },
    },
    {
      evidence: [lane("review--intent", [])],
      output: {
        verdict: "BLOCKED",
        dispositions: [],
        resolved: [{ ref: "r1/c", how: "still_open", evidence: "blocked by external API" }],
      },
    },
  ]

  it("sums per-round new findings and raised/fixed/refuted/open deterministically", () => {
    const metrics = rounds.map((round) => reviewRoundMetrics(round.output, round.evidence))
    expect(metrics).toEqual([
      { raised: 3, newFindings: 2, upheld: 2, refuted: 1, fixed: 0, resolvedRefuted: 0, stillOpen: 0 },
      { raised: 1, newFindings: 1, upheld: 1, refuted: 0, fixed: 1, resolvedRefuted: 1, stillOpen: 0 },
      { raised: 0, newFindings: 0, upheld: 0, refuted: 0, fixed: 0, resolvedRefuted: 0, stillOpen: 1 },
    ])
    expect(reviewRoundSummary(metrics)).toEqual({
      rounds: 3,
      newFindingsPerRound: [2, 1, 0],
      raised: 4,
      newFindings: 3,
      upheld: 3,
      refuted: 1,
      fixed: 1,
      resolvedRefuted: 1,
      stillOpen: 1,
      quietRounds: 1,
    })
  })
})

describe("prior-round compilation", () => {
  const blocks = (priorRound: boolean) => [
    { id: "implementation", kind: "coding" as const },
    { id: "verification", kind: "verify" as const, depends_on: ["implementation"] },
    {
      id: "decision",
      kind: "review" as const,
      depends_on: ["verification"],
      lenses: ["standards", "intent", "completeness"] as const,
      ...(priorRound ? { prior_round: { workflow_id: "wf-prev", review_id: "decision" } } : {}),
    },
  ]
  const round: PriorRound = {
    workflow_id: "wf-prev",
    review_id: "decision",
    round: 2,
    quiet_rounds: 0,
    new_findings: 1,
    findings: [
      {
        ref: "wf-prev/decision--intent/0",
        node: "decision--intent",
        index: 0,
        action: "Fix the boundary check",
        disposition: { novelty: "new", decision: "upheld", evidence: "reproduced" },
      },
    ],
  }
  const compile = (withPrior: boolean) =>
    DagBlocks.compileWorkflowBlocks(
      { objective: "Ship it", blocks: [...blocks(withPrior)] },
      {
        review_gate: "strict",
        acceptance: [{ id: "AC1", text: "Boundary is correct" }],
        ...(withPrior ? { prior_rounds: { "wf-prev/decision": round } } : {}),
      },
    )

  it("injects stored prior findings into a strict arbitration decision", () => {
    const decision = compile(true).find((node) => node.id === "decision")
    expect(decision).toMatchObject({
      required: true,
      skip_ok: false,
      review_round: 3,
      review_quiet_rounds: 0,
      review_new_findings: 1,
      review_lenses: ["standards", "intent", "completeness"],
      prior_round: { workflow_id: "wf-prev", review_id: "decision" },
      prior_findings: [expect.objectContaining({ ref: "wf-prev/decision--intent/0" })],
    })
    expect(decision?.prompt_template.inline).toContain("Prior findings (from the referenced review round):")
    expect(decision?.prompt_template.input?.prior_findings).toEqual(round.findings)
  })

  it("keeps a first round free of prior findings and marks lane nodes read-only", () => {
    const nodes = compile(false)
    const decision = nodes.find((node) => node.id === "decision")
    expect(decision?.review_round).toBe(1)
    expect(decision?.prior_findings).toBeUndefined()
    expect(nodes.find((node) => node.id === "decision--completeness")).toMatchObject({
      review_lane: "completeness",
      worker_type: "auditor",
    })
  })

  it("rejects prior_round outside review blocks", () => {
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Ship it",
        blocks: [
          {
            id: "implementation",
            kind: "coding",
            depends_on: [],
            // Runtime guard for decoded YAML that puts the field on a writer.
            prior_round: { workflow_id: "wf", review_id: "decision" },
          },
        ],
      }),
    ).toThrow('Block "implementation" declares prior_round, which only review blocks support')
  })
})