// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1027 D6b: the review quality the `/dag` summary reports (`quality`) and the
// `review_quality` block of `inspect` status come from one function. These
// tests pin its accounting on block-compiled review graphs and prove the two
// surfaces agree on the same fixture.
import { describe, expect, it } from "bun:test"
import type { WorkflowQuality } from "@graphagent/schema/dag-summary"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { DagQuality } from "@/dag/quality"
import { renderStatus } from "@/tool/workflow/render"
import { makeWorkflowRow } from "./fixtures"
import {
  accepted,
  acceptedDecision,
  completeness,
  disposition,
  lane,
  roundOne,
  roundOneDecision,
  rowsFor,
  strictConfig,
  withRound,
  type Outputs,
} from "./review-fixtures"

const quality = (config: WorkflowConfig, outputs: Outputs) =>
  DagQuality.workflowQuality({ config, nodes: rowsFor(config, outputs) })

describe("workflow quality (#1027 D6b)", () => {
  it("counts one arbitrated round: reviews, raised/refuted, skeptic findings, completeness", () => {
    expect(quality(strictConfig(), roundOne)).toEqual({
      reviewBound: false,
      reviews: 1,
      // Two standards actions, the completeness lane's missing item and unlisted
      // expectation, and the skeptic's counterexample.
      raised: 5,
      fixed: 0,
      refuted: 1,
      stillOpen: 0,
      skepticRefutations: 1,
      rounds: 1,
      quietRounds: 0,
      completeness: { covered: 1, total: 2, unlisted: 1 },
    })
  })

  it("reports null unless the workflow is strict and holds a review decision", () => {
    const standard = { ...strictConfig(), review_gate: undefined }
    expect(quality(standard, roundOne)).toBeNull()
    // The same graph under deep mode is strict without a review_gate.
    expect(quality({ ...standard, mode: "deep" }, roundOne)).not.toBeNull()
    // `inspect` still shows the counters for a standard workflow with a review.
    expect(DagQuality.reviewMetrics({ config: standard, nodes: rowsFor(standard, roundOne) })).toBeDefined()

    const noReview = {
      ...strictConfig(),
      nodes: strictConfig().nodes.filter((node) => node.review_arbitration !== true),
    }
    expect(quality(noReview, roundOne)).toBeNull()
    expect(quality({ ...strictConfig(), nodes: [] }, {})).toBeNull()
    expect(DagQuality.workflowQuality({ config: undefined, nodes: [] })).toBeNull()
  })

  it("does not count a decision that has not completed as a round", () => {
    const config = strictConfig()
    const running = quality(config, { ...roundOne, decision: { status: "running" } })
    expect(running).toMatchObject({ reviews: 0, rounds: 0, quietRounds: 0, raised: 0, skepticRefutations: 0 })
    // Before any arbitration there is no accepted completeness verdict either way.
    const pending = quality(config, { implementation: roundOne.implementation })
    expect(pending).toMatchObject({ reviews: 0, rounds: 0, quietRounds: 0, completeness: null })
  })

  it("accumulates rounds, and counts what is still open once, not once per round", () => {
    const config = withRound(withRound(strictConfig(), "decision2", 2), "decision3", 3)
    const outputs: Outputs = {
      ...roundOne,
      "decision2--standards": { output: lane("Fix C") },
      "decision2--intent": { output: lane() },
      "decision2--completeness": { output: completeness(["AC1", "AC2"], []) },
      "decision2--skeptic-1": { output: lane() },
      decision2: {
        output: {
          verdict: "REJECT",
          implementation_fingerprint: "fp-1",
          required_actions: [],
          dispositions: [disposition("decision2--standards", 0, "upheld")],
          resolved: [
            { ref: "r1/a", how: "fixed", evidence: "src/a.ts" },
            { ref: "r1/b", how: "still_open", evidence: "waiting on the API" },
          ],
        },
      },
      "decision3--standards": { output: lane() },
      "decision3--intent": { output: lane() },
      "decision3--completeness": { output: completeness(["AC1", "AC2"], []) },
      "decision3--skeptic-1": { output: lane() },
      decision3: {
        output: {
          verdict: "BLOCKED",
          implementation_fingerprint: "fp-1",
          required_actions: [],
          dispositions: [],
          resolved: [
            { ref: "r1/b", how: "still_open", evidence: "waiting on the API" },
            { ref: "r2/c", how: "fixed", evidence: "src/c.ts" },
          ],
        },
      },
    }
    const metrics = DagQuality.reviewMetrics({ config, nodes: rowsFor(config, outputs) })!
    expect(metrics.newFindingsPerRound).toEqual([4, 1, 0])
    expect(metrics.quality).toEqual({
      reviewBound: false,
      reviews: 3,
      raised: 6,
      fixed: 2,
      refuted: 1,
      // `r1/b` is re-listed by rounds two and three but is one open finding.
      stillOpen: 1,
      skepticRefutations: 1,
      rounds: 3,
      quietRounds: 1,
      // The latest round's completeness lane judges both items covered.
      completeness: { covered: 2, total: 2, unlisted: 0 },
    })
  })

  it("counts only upheld new findings on skeptic lanes as skeptic refutations", () => {
    const config = strictConfig()
    const outputs: Outputs = {
      ...roundOne,
      "decision--skeptic-1": { output: lane("One", "Two", "Three") },
      decision: {
        output: {
          ...roundOneDecision,
          dispositions: [
            disposition("decision--skeptic-1", 0, "upheld"),
            disposition("decision--skeptic-1", 1, "refuted"),
            disposition("decision--skeptic-1", 2, "upheld", { dup_of: "wf/decision--skeptic-1/0" }),
            disposition("decision--standards", 0, "upheld"),
          ],
        },
      },
    }
    expect(quality(config, outputs)?.skepticRefutations).toBe(1)
  })

  describe("review bound to the final implementation", () => {
    it("is bound by a completed ACCEPT that echoes the implementation fingerprint", () => {
      expect(quality(strictConfig(), accepted)?.reviewBound).toBe(true)
    })

    it("is not bound by a REJECT, a stale target, or a different fingerprint", () => {
      expect(
        quality(strictConfig(), { ...accepted, decision: { output: { ...acceptedDecision, verdict: "REJECT" } } })
          ?.reviewBound,
      ).toBe(false)
      expect(
        quality(strictConfig(), { ...accepted, decision: { ...accepted.decision, staleTarget: true } })?.reviewBound,
      ).toBe(false)
      // The implementation was re-run after the decision judged fp-1.
      expect(
        quality(strictConfig(), {
          ...accepted,
          implementation: { output: { summary: "again", changed_files: ["a.ts"], fingerprint: "fp-2" } },
        })?.reviewBound,
      ).toBe(false)
      expect(quality(strictConfig(), { ...accepted, decision: { status: "running" } })?.reviewBound).toBe(false)
    })

    it("stops being bound once a later writer is built on the accepted decision", () => {
      const config = strictConfig()
      const later: NodeConfig = {
        id: "followup",
        name: "followup",
        worker_type: "build",
        depends_on: ["decision"],
        required: true,
        prompt_template: { inline: "follow up" },
      }
      const extended = { ...config, nodes: [...config.nodes, later] }
      expect(quality(extended, { ...accepted, followup: { status: "running" } })?.reviewBound).toBe(false)
      // A read-only successor (the default final gate) leaves the binding intact.
      expect(quality(config, accepted)?.reviewBound).toBe(true)
    })
  })

  it("reads completeness against the declared acceptance list", () => {
    const config = strictConfig()
    // The lane judged only AC1; the unjudged AC2 still counts against the total.
    expect(
      quality(config, { ...roundOne, "decision--completeness": { output: completeness(["AC1"], [], []) } })
        ?.completeness,
    ).toEqual({ covered: 1, total: 2, unlisted: 0 })

    // Without a declared list the lane's own judged items are the denominator.
    const undeclared = { ...config, acceptance: undefined }
    expect(quality(undeclared, roundOne)?.completeness).toEqual({ covered: 1, total: 2, unlisted: 1 })

    // No completed completeness lane means no completeness verdict.
    expect(quality(config, { ...roundOne, "decision--completeness": { status: "failed" } })?.completeness).toBeNull()
  })

  it("combines several workflows into one session-level quality", () => {
    const one = quality(strictConfig(), roundOne)!
    const bound: WorkflowQuality = {
      ...one,
      reviewBound: true,
      quietRounds: 2,
      completeness: { covered: 2, total: 2, unlisted: 0 },
    }
    expect(DagQuality.combine([])).toBeNull()
    expect(DagQuality.combine([one])).toEqual(one)
    expect(DagQuality.combine([one, bound])).toEqual({
      reviewBound: true,
      reviews: 2,
      raised: 10,
      fixed: 0,
      refuted: 2,
      stillOpen: 0,
      skepticRefutations: 2,
      rounds: 2,
      quietRounds: 2,
      completeness: { covered: 3, total: 4, unlisted: 1 },
    })
  })

  it("names the nodes whose outputs the counters read", () => {
    expect(DagQuality.outputNodeIDs(strictConfig()).toSorted()).toEqual([
      "decision",
      "decision--completeness",
      "decision--intent",
      "decision--skeptic-1",
      "decision--standards",
      "implementation",
    ])
    expect(DagQuality.outputNodeIDs({ name: "plain", nodes: [] })).toEqual([])
  })

  // D6 acceptance: the panel's `quality` and the tool result's `review_quality`
  // are one computation, checked on one fixture.
  it("agrees with inspect status on the same fixture", () => {
    const config = withRound(strictConfig(), "decision2", 2)
    const outputs: Outputs = {
      ...roundOne,
      "decision2--standards": { output: lane("Fix C") },
      "decision2--intent": { output: lane() },
      "decision2--completeness": { output: completeness(["AC1", "AC2"], []) },
      "decision2--skeptic-1": { output: lane() },
      decision2: {
        output: {
          verdict: "ACCEPT",
          implementation_fingerprint: "fp-1",
          required_actions: [],
          refuted: [{ node: "decision2--standards", index: 0, reason: "not reproducible" }],
          dispositions: [disposition("decision2--standards", 0, "refuted")],
          resolved: [{ ref: "r1/a", how: "fixed", evidence: "src/a.ts" }],
        },
      },
    }
    const rows = rowsFor(config, outputs)
    const summary = quality(config, outputs)!
    const status = JSON.parse(
      renderStatus({
        workflow: makeWorkflowRow({ config: JSON.stringify(config) }),
        nodes: rows,
        allNodes: rows,
      }).output,
    ).review_quality

    expect(status).toEqual({
      reviews: summary.reviews,
      review_bound: summary.reviewBound,
      rounds: summary.rounds,
      quiet_rounds: summary.quietRounds,
      new_findings_per_round: [4, 0],
      raised: summary.raised,
      fixed: summary.fixed,
      refuted: summary.refuted,
      still_open: summary.stillOpen,
      skeptic_refutations: summary.skepticRefutations,
      completeness: summary.completeness,
    })
    // The values themselves, so a shared mistake cannot hide behind agreement.
    expect(summary).toMatchObject({
      reviews: 2,
      raised: 6,
      fixed: 1,
      refuted: 2,
      stillOpen: 0,
      skepticRefutations: 1,
      rounds: 2,
      quietRounds: 1,
      reviewBound: true,
    })
  })
})
