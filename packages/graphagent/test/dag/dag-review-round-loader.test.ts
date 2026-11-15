// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Minimal Dag.Interface stubs for the stored-output loader. */
// #1031 M6: prior_round resolves stored lane actions plus arbitration
// dispositions, and stops the loop after two quiet rounds or five rounds.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
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

const loader = (workflowConfig: WorkflowConfig, sessionID = "ses_parent") =>
  priorRoundLoader(
    {
      store: {
        getWorkflow: (id: string) =>
          Effect.succeed(
            id === "dag_prev"
              ? makeWorkflowRow({ id: "dag_prev", sessionId: "ses_parent", config: JSON.stringify(workflowConfig) })
              : undefined,
          ),
        getCurrentNodes: () => Effect.succeed(rows),
      },
    } as unknown as Dag.Interface,
    sessionID,
  )

const reference = { workflow_id: "dag_prev", review_id: "decision" }

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

  it("stops the loop after five rounds or two quiet rounds", async () => {
    const five = await Effect.runPromise(loader(config({ review_round: 5 }))(reference).pipe(Effect.flip))
    expect(five).toContain("review loop stopped: 5 rounds reached")

    const quiet = await Effect.runPromise(
      loader(config({ review_new_findings: 0, review_quiet_rounds: 2 }))(reference).pipe(Effect.flip),
    )
    expect(quiet).toContain("two consecutive rounds raised no new upheld finding")
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