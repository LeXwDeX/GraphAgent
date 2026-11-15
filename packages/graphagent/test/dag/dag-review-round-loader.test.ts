// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Minimal Dag.Interface stubs for the stored-output loader. */
// #1031 M6: prior_round resolves stored lane actions plus arbitration
// dispositions, inherits the findings a decision leaves still open, and stops
// the loop after two quiet rounds or five rounds.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import type { PriorFinding } from "@/dag/blocks"
import { arbitrationConsistencyErrors } from "@/dag/review-lifecycle"
import { priorRoundLoader } from "@/tool/workflow/prepare"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const lane: NodeConfig = {
  id: "review--intent",
  name: "intent",
  worker_type: "auditor",
  depends_on: [],
  required: false,
  prompt_template: { inline: "review" },
  review_lane: "intent",
}

const decision: NodeConfig = {
  id: "decision",
  name: "decision",
  worker_type: "auditor",
  depends_on: ["review--intent", "verification"],
  required: true,
  skip_ok: false,
  prompt_template: { inline: "arbitrate" },
  review: { phase: "diff", implementation_node_id: "implementation", verification_node_id: "verification" },
  review_arbitration: true,
  review_lenses: ["standards", "intent", "completeness"],
  review_round: 2,
  review_quiet_rounds: 0,
  review_new_findings: 1,
}

const config = (extra: Partial<NodeConfig> = {}): WorkflowConfig => ({
  name: "prior",
  review_gate: "strict",
  nodes: [lane, { ...decision, ...extra }],
})

// What the referenced decision stored when its lane raised two actions and the
// arbitration upheld one of them.
const rows = [
  makeNodeRow({
    id: "review--intent",
    status: "completed",
    output: { verdict: "REJECT", required_actions: ["Fix A", "Fix B"] },
  }),
  makeNodeRow({
    id: "decision",
    status: "completed",
    output: {
      verdict: "REJECT",
      dispositions: [
        { node: "review--intent", index: 0, novelty: "new", decision: "upheld", evidence: "reproduced" },
        { node: "review--intent", index: 1, novelty: { dup_of: "older" }, decision: "refuted", evidence: "by design" },
      ],
      resolved: [],
    },
  }),
]

// A quiet round: the lane raised nothing, so the arbitration has nothing to
// disposition and raised no new upheld finding.
const quietRows = [
  makeNodeRow({
    id: "review--intent",
    status: "completed",
    output: { verdict: "ACCEPT", required_actions: [] },
  }),
  makeNodeRow({
    id: "decision",
    status: "completed",
    output: { verdict: "ACCEPT", dispositions: [], resolved: [] },
  }),
]

interface StoredRound {
  id: string
  config: WorkflowConfig
  rows: ReturnType<typeof makeNodeRow>[]
}

const storeLoader = (rounds: readonly StoredRound[], sessionID = "ses_parent") =>
  priorRoundLoader(
    {
      store: {
        getWorkflow: (id: string) => {
          const round = rounds.find((candidate) => candidate.id === id)
          return Effect.succeed(
            round ? makeWorkflowRow({ id: round.id, config: JSON.stringify(round.config) }) : undefined,
          )
        },
        getCurrentNodes: (id: string) =>
          Effect.succeed(rounds.find((candidate) => candidate.id === id)?.rows ?? []),
      },
    } as unknown as Dag.Interface,
    sessionID,
  )

const loader = (workflowConfig: WorkflowConfig, sessionID = "ses_parent") =>
  storeLoader([{ id: "dag_prev", config: workflowConfig, rows }], sessionID)

const reference = { workflow_id: "dag_prev", review_id: "decision" }

const priorFinding: PriorFinding = {
  ref: "dag_round1/review--intent/0",
  node: "review--intent",
  index: 0,
  action: "Fix the boundary check",
  disposition: { novelty: "new", decision: "upheld", evidence: "reproduced" },
}

const resolvedRows = (how: "fixed" | "refuted" | "still_open", evidence = "checked") => [
  makeNodeRow({
    id: "review--intent",
    status: "completed",
    output: { verdict: "ACCEPT", required_actions: [] },
  }),
  makeNodeRow({
    id: "decision",
    status: "completed",
    output: {
      verdict: "REJECT",
      dispositions: [],
      resolved: [{ ref: priorFinding.ref, how, evidence }],
    },
  }),
]

describe("priorRoundLoader", () => {
  it("reads lane actions and attaches the prior arbitration dispositions", async () => {
    const round = await Effect.runPromise(loader(config())(reference))
    expect(round).toMatchObject({ round: 2, quiet_rounds: 0, new_findings: 1 })
    expect(round.findings).toEqual([
      {
        ref: "dag_prev/review--intent/0",
        node: "review--intent",
        index: 0,
        action: "Fix A",
        disposition: { novelty: "new", decision: "upheld", evidence: "reproduced" },
      },
      {
        ref: "dag_prev/review--intent/1",
        node: "review--intent",
        index: 1,
        action: "Fix B",
        disposition: { novelty: { dup_of: "older" }, decision: "refuted", evidence: "by design" },
      },
    ])
  })

  it("inherits a prior finding the decision leaves still open", async () => {
    const round2 = config({ prior_findings: [priorFinding] })
    const round = await Effect.runPromise(
      storeLoader([
        { id: "dag_prev", config: round2, rows: resolvedRows("still_open", "not addressed") },
      ])(reference),
    )
    // The inherited item keeps its original ref and action; the disposition
    // now reflects that the decision left it open.
    expect(round.findings).toEqual([
      {
        ...priorFinding,
        disposition: { novelty: "new", decision: "upheld", evidence: "not addressed" },
      },
    ])
    // The inherited finding is not a new finding of this round.
    expect(round).toMatchObject({ quiet_rounds: 1, new_findings: 0 })

    // The next round cannot ACCEPT without resolving the inherited ref.
    const evidence = [{ nodeID: "review--intent", output: { verdict: "ACCEPT", required_actions: [] } }]
    expect(
      arbitrationConsistencyErrors(
        { verdict: "ACCEPT", dispositions: [], resolved: [] },
        evidence,
        { priorFindings: round.findings },
      ),
    ).toContain(`resolved misses prior finding(s): ${priorFinding.ref}`)
    expect(
      arbitrationConsistencyErrors(
        {
          verdict: "ACCEPT",
          dispositions: [],
          resolved: [{ ref: priorFinding.ref, how: "fixed", evidence: "src/a.ts:3" }],
        },
        evidence,
        { priorFindings: round.findings },
      ),
    ).toEqual([])
  })

  it("drops a prior finding the decision resolves fixed or refuted", async () => {
    for (const how of ["fixed", "refuted"] as const) {
      const round = await Effect.runPromise(
        storeLoader([
          { id: "dag_prev", config: config({ prior_findings: [priorFinding] }), rows: resolvedRows(how) },
        ])(reference),
      )
      expect(round.findings).toEqual([])
    }
  })

  it("stops the loop after five rounds", async () => {
    const five = await Effect.runPromise(loader(config({ review_round: 5 }))(reference).pipe(Effect.flip))
    expect(five).toContain("review loop stopped: 5 rounds reached")
  })

  it("counts this round from its stored dispositions, not the compiled predecessor count", async () => {
    // The compiler wrote round 1's counts onto this round before it ran; the
    // stored arbitration output is the only authority on this round's novelty.
    const round2 = config({ review_quiet_rounds: 0, review_new_findings: 1 })
    const quiet = await Effect.runPromise(
      storeLoader([{ id: "dag_prev", config: round2, rows: quietRows }])(reference),
    )
    expect(quiet).toMatchObject({ round: 2, quiet_rounds: 1, new_findings: 0 })

    // Round 1 was quiet, so the compiler encoded an entering streak of two;
    // round 2 raising must reset it instead of stopping early.
    const afterQuiet = config({ review_quiet_rounds: 2, review_new_findings: 0 })
    const raised = await Effect.runPromise(
      storeLoader([{ id: "dag_prev", config: afterQuiet, rows }])(reference),
    )
    expect(raised).toMatchObject({ round: 2, quiet_rounds: 0, new_findings: 1 })
  })

  it("stops once two quiet rounds follow a raised one", async () => {
    // Round 1 raised; round 2 is quiet, measured from its own dispositions.
    const round2 = config({ review_quiet_rounds: 0, review_new_findings: 1 })
    const loaded = await Effect.runPromise(
      storeLoader([{ id: "dag_prev", config: round2, rows: quietRows }])(reference),
    )
    expect(loaded).toMatchObject({ quiet_rounds: 1, new_findings: 0 })

    // The compiler carries that streak into round 3 as the entering streak.
    const round3 = config({ review_round: 3, review_quiet_rounds: 2, review_new_findings: 0 })
    const stopped = await Effect.runPromise(
      storeLoader([{ id: "dag_prev", config: round3, rows: quietRows }])(reference).pipe(Effect.flip),
    )
    expect(stopped).toContain("review loop stopped: two consecutive rounds raised no new upheld finding")
  })

  it("refuses a prior_round reference that is not a review decision", async () => {
    const nodes: NodeConfig[] = [
      lane,
      decision,
      {
        id: "verification",
        name: "verification",
        worker_type: "auditor",
        depends_on: [],
        required: true,
        prompt_template: { inline: "verify" },
      },
      {
        id: "implementation",
        name: "implementation",
        worker_type: "build",
        depends_on: [],
        required: true,
        prompt_template: { inline: "implement" },
      },
    ]
    const rounds = () => [
      {
        id: "dag_prev",
        config: { name: "prior", review_gate: "strict" as const, nodes },
        rows: [
          ...rows,
          makeNodeRow({ id: "verification", status: "completed", output: { verdict: "PASS" } }),
          makeNodeRow({
            id: "implementation",
            status: "completed",
            output: { fingerprint: "abc", changed_files: ["a.ts"] },
          }),
        ],
      },
    ]
    // Both nodes have a completed structured output, so only the review
    // decision check can reject them.
    for (const reviewID of ["verification", "implementation"]) {
      const failure = await Effect.runPromise(
        storeLoader(rounds())({ workflow_id: "dag_prev", review_id: reviewID }).pipe(Effect.flip),
      )
      expect(failure).toContain(`review "${reviewID}" is not a review decision`)
    }
    // The real review decision still resolves its round.
    const round = await Effect.runPromise(storeLoader(rounds())(reference))
    expect(round.round).toBe(2)
  })

  it("refuses another session's workflow and an incomplete review", async () => {
    const foreign = await Effect.runPromise(loader(config(), "ses_other")(reference).pipe(Effect.flip))
    expect(foreign).toContain("is not owned by this session")

    const running = await Effect.runPromise(
      priorRoundLoader(
        {
          store: {
            getWorkflow: () =>
              Effect.succeed(
                makeWorkflowRow({ id: "dag_prev", config: JSON.stringify(config()) }),
              ),
            getCurrentNodes: () =>
              Effect.succeed([rows[0], { ...rows[1], status: "running" }]),
          },
        } as unknown as Dag.Interface,
        "ses_parent",
      )(reference).pipe(Effect.flip),
    )
    expect(running).toContain("has no completed structured output")
  })
})