// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M6: cross-round review arbitration — dispositions/resolved coverage,
// prior-round injection, round accounting, and the strict lane-completeness
// rule.
import { describe, expect, it } from "bun:test"
import { DagBlocks, type PriorRound } from "@/dag/blocks"
import {
  arbitrationConsistencyErrors,
  canonicalLaneNodes,
  reviewLaneFindings,
  reviewRoundMetrics,
  reviewRoundSummary,
  verdictEvidenceOf,
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
// #1556: a block decision's lanes reach it under input keys (`intent_review`), and a lane's node id
// (`decision--intent`) never appears in its prompt. Settlement reads the key as the lane it names.
describe("a block decision that names its lanes by the input key it was shown (#1556)", () => {
  const keyed = (nodeID: string, key: string, required: string[]): VerdictEvidence => ({
    ...lane(nodeID, required),
    keys: [key],
  })
  const lanes = [
    keyed("decision--intent", "intent_review", ["A"]),
    keyed("decision--completeness", "completeness_review", ["B", "C"]),
    keyed("decision--skeptic-1", "skeptic_1_review", ["D"]),
  ]
  const entry = (node: string, index: number, decision: "upheld" | "refuted" = "upheld") => ({
    node,
    index,
    novelty: "new",
    decision,
    evidence: `${index} is ${decision}`,
  })
  const byKey = [
    entry("intent_review", 0),
    entry("completeness_review", 0),
    entry("completeness_review", 1, "refuted"),
    entry("skeptic_1_review", 0),
  ]
  const byID = [
    entry("decision--intent", 0),
    entry("decision--completeness", 0),
    entry("decision--completeness", 1, "refuted"),
    entry("decision--skeptic-1", 0),
  ]
  const settle = (output: unknown, reviewArbitration = true) =>
    settleCapturedOutput(output, undefined, "", true, lanes, reviewArbitration ? { reviewArbitration } : {})
  const reject = (dispositions: unknown[]) => ({ verdict: "REJECT", dispositions, resolved: [] })

  it("completes and stores the lane node ids instead of the keys", () => {
    const settled = settle(reject(byKey))
    expect(settled).toEqual({ kind: "complete", output: reject(byID) })
    if (settled.kind !== "complete") return
    // What the quality counts and the next round's prior findings read is the stored node id.
    expect(reviewLaneFindings(settled.output, new Set(["decision--skeptic-1"]))).toBe(1)
    expect(reviewLaneFindings(reject(byKey), new Set(["decision--skeptic-1"]))).toBe(0)
  })

  it("accepts the lane node id itself, and both spellings in one result", () => {
    expect(settle(reject(byID))).toEqual({ kind: "complete", output: reject(byID) })
    expect(settle(reject([byKey[0], byID[1], byKey[2], byID[3]]))).toEqual({
      kind: "complete",
      output: reject([byID[0], byID[1], byID[2], byID[3]]),
    })
  })

  it("still rejects a node that is neither a lane nor the key of one", () => {
    const settled = settle(reject([byKey[0], entry("intent_reviews", 0), byKey[2], byKey[3]]))
    expect(settled.kind).toBe("fail")
    if (settled.kind !== "fail") return
    expect(settled.reason).toContain("dispositions name unknown lane required action(s): intent_reviews[0]")
    expect(settled.reason).toContain("dispositions miss lane required action(s): decision--completeness[0]")
    // The model can fix this one, and is told exactly what the contract refused.
    expect(settled.correctable).toEqual([
      "dispositions miss lane required action(s): decision--completeness[0]",
      "dispositions name unknown lane required action(s): intent_reviews[0]",
    ])
  })

  it("does not turn an index the lane never raised into a match", () => {
    const settled = settle(reject([byKey[0], entry("completeness_review", 5), byKey[2], byKey[3]]))
    expect(settled.kind).toBe("fail")
    if (settled.kind !== "fail") return
    expect(settled.reason).toContain("dispositions name unknown lane required action(s): decision--completeness[5]")
  })

  it("reads the keys of the entries an ACCEPT refutes the same way", () => {
    const refuted = [
      { node: "intent_review", index: 0, reason: "The finding is not supported" },
      { node: "decision--completeness", index: 0, reason: "Covered by README.md" },
      { node: "completeness_review", index: 1, reason: "Out of scope" },
      { node: "skeptic_1_review", index: 0, reason: "Not reproducible" },
    ]
    const accept = {
      verdict: "ACCEPT",
      required_actions: [],
      refuted,
      dispositions: byKey.map((item) => ({ ...item, decision: "refuted" })),
      resolved: [],
    }
    const settled = settle(accept)
    expect(settled.kind).toBe("complete")
    if (settled.kind !== "complete") return
    expect(settled.output).toMatchObject({
      refuted: [
        { node: "decision--intent", index: 0 },
        { node: "decision--completeness", index: 0 },
        { node: "decision--completeness", index: 1 },
        { node: "decision--skeptic-1", index: 0 },
      ],
    })
  })

  it("leaves a decision that is not block-compiled as it was: no rewrite, no correction", () => {
    const accept = {
      verdict: "ACCEPT",
      required_actions: [],
      refuted: [{ node: "intent_review", index: 0, reason: "r" }],
    }
    const settled = settle(accept, false)
    expect(settled.kind).toBe("fail")
    if (settled.kind !== "fail") return
    expect(settled.reason).toContain("ACCEPT leaves required actions unrefuted")
    expect(settled.correctable).toBeUndefined()
  })

  it("marks a block decision's consistency errors as correctable and keeps the reason text", () => {
    const settled = settle({ verdict: "REJECT" })
    expect(settled.kind).toBe("fail")
    if (settled.kind !== "fail") return
    expect(settled.correctable).toContain("decision must submit dispositions covering every lane required action")
    expect(settled.reason).toBe(`Verdict consistency contract failed: ${settled.correctable?.join("; ")}`)
  })
})

describe("the input keys a decision reads its lanes under", () => {
  const rows = [
    { id: "decision--intent", status: "completed", output: { verdict: "REJECT" } },
    { id: "decision--skeptic-1", status: "completed", output: { verdict: "ACCEPT" } },
    { id: "decision--security", status: "failed", output: null },
    { id: "verification", status: "completed", output: { verdict: "PASS" } },
    { id: "unrelated", status: "completed", output: "x" },
  ]
  const dependsOn = ["decision--intent", "decision--skeptic-1", "decision--security", "verification"]

  it("reads the key of each completed dependency from the decision's input mapping", () => {
    expect(
      verdictEvidenceOf(dependsOn, rows, {
        implementation_fingerprint: "implementation.output.fingerprint",
        verification: "verification.output",
        intent_review: "decision--intent.output",
        skeptic_1_review: "decision--skeptic-1.output",
        security_review: "decision--security.output",
        intent_actions: "decision--intent.output.required_actions",
      }),
    ).toEqual([
      { nodeID: "decision--intent", output: rows[0]?.output, keys: ["intent_review"] },
      { nodeID: "decision--skeptic-1", output: rows[1]?.output, keys: ["skeptic_1_review"] },
      // A key that is the node's own id adds nothing, and a path below the output is not the lane itself.
      { nodeID: "verification", output: rows[3]?.output },
    ])
  })

  it("adds no keys without an input mapping, where the context is keyed by node id", () => {
    expect(verdictEvidenceOf(dependsOn, rows)).toEqual([
      { nodeID: "decision--intent", output: rows[0]?.output },
      { nodeID: "decision--skeptic-1", output: rows[1]?.output },
      { nodeID: "verification", output: rows[3]?.output },
    ])
  })

  it("does not rewrite a node that is itself the id of another dependency", () => {
    const evidence: VerdictEvidence[] = [
      { nodeID: "decision--intent", output: {}, keys: ["decision--standards"] },
      { nodeID: "decision--standards", output: {} },
    ]
    const output = { dispositions: [{ node: "decision--standards", index: 0 }], refuted: [] }
    expect(canonicalLaneNodes(output, evidence)).toBe(output)
  })

  it("hands back the very output when no entry names a key", () => {
    const evidence: VerdictEvidence[] = [{ nodeID: "decision--intent", output: {}, keys: ["intent_review"] }]
    const output = { verdict: "REJECT", dispositions: [{ node: "decision--intent", index: 0 }] }
    expect(canonicalLaneNodes(output, evidence)).toBe(output)
    expect(canonicalLaneNodes("not an object", evidence)).toBe("not an object")
  })
})

describe("what the arbitration prompt says about the lanes (#1556)", () => {
  const route = (priorRound?: { workflow_id: string; review_id: string }) => [
    { id: "implementation", kind: "coding" as const },
    { id: "verification", kind: "verify" as const, depends_on: ["implementation"] },
    {
      id: "decision",
      kind: "review" as const,
      depends_on: ["verification"],
      lenses: ["standards", "intent", "completeness"] as const,
      skeptics: 2,
      ...(priorRound ? { prior_round: priorRound } : {}),
    },
  ]
  const compile = (priorRound?: PriorRound) =>
    DagBlocks.compileWorkflowBlocks(
      {
        objective: "Ship it",
        blocks: route(
          priorRound ? { workflow_id: priorRound.workflow_id, review_id: priorRound.review_id } : undefined,
        ),
      },
      {
        review_gate: "strict",
        acceptance: [{ id: "AC1", text: "Boundary is correct" }],
        ...(priorRound ? { prior_rounds: { [`${priorRound.workflow_id}/${priorRound.review_id}`]: priorRound } } : {}),
      },
    )
  const promptOf = (nodes: ReturnType<typeof compile>) =>
    nodes.find((node) => node.id === "decision")?.prompt_template.inline ?? ""

  it("pairs every input key of a route's decision with the lane node id it stands for", () => {
    const nodes = compile()
    const decision = nodes.find((node) => node.id === "decision")
    const prompt = promptOf(nodes)
    expect(prompt).toContain(
      "In dispositions and refuted, node is the lane's node id and index is the position in that lane's required_actions, counted from 0, never the key its result arrives under in the context.",
    )
    expect(prompt).toContain(
      "Input key = lane node id: standards_review = decision--standards; intent_review = decision--intent; completeness_review = decision--completeness; skeptic_1_review = decision--skeptic-1; skeptic_2_review = decision--skeptic-2.",
    )
    // The pairs are the decision's own input mapping, so the keys the model is shown are the ones it is told about.
    const laneMapping = Object.entries(decision?.input_mapping ?? {}).filter(([key]) => key.endsWith("_review"))
    expect(laneMapping).toHaveLength(5)
    for (const [key, source] of laneMapping) expect(prompt).toContain(`${key} = ${source.replace(/\.output$/, "")}`)
    for (const laneNode of nodes.filter((node) => node.review_lane !== undefined)) expect(prompt).toContain(laneNode.id)
  })

  it("lists the lane node ids of a decision that has no route, whose context is keyed by them", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Judge the design",
      blocks: [{ id: "decision", kind: "review" as const, lenses: ["standards", "intent"] as const }],
    })
    expect(nodes.find((node) => node.id === "decision")?.input_mapping).toBeUndefined()
    expect(promptOf(nodes)).toContain(
      "In dispositions and refuted, node is the lane's node id and index is the position in that lane's required_actions, counted from 0. Lane node ids: decision--standards, decision--intent.",
    )
    expect(promptOf(nodes)).not.toContain("Input key =")
  })

  it("tells a first round that no prior findings exist, so novelty is new and resolved is empty", () => {
    expect(promptOf(compile())).toContain(
      'No prior findings are supplied, so every novelty is "new" (dup_of takes the ref of a prior finding, never a finding of this round) and resolved is [].',
    )
    expect(promptOf(compile())).not.toContain("The supplied prior findings are")
  })

  it("keeps the prior-round instruction when prior findings are supplied", () => {
    const prompt = promptOf(
      compile({
        workflow_id: "wf-prev",
        review_id: "decision",
        round: 1,
        quiet_rounds: 0,
        new_findings: 1,
        findings: [{ ref: "wf-prev/decision--intent/0", node: "decision--intent", index: 0, action: "Fix it" }],
      }),
    )
    expect(prompt).toContain("The supplied prior findings are the previous round's unresolved and resolved items")
    expect(prompt).not.toContain("No prior findings are supplied")
  })
})
