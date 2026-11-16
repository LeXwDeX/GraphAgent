// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1027 D6b: block-compiled review graphs and the stored outputs of a rejected
// first round, shared by the quality, derivation and publisher tests.
import type { DagStore } from "@graphagent/core/dag/store"
import { DagBlocks, type WorkflowBlock } from "@/dag/blocks"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { makeNodeRow } from "./fixtures"

export const acceptance = [
  { id: "AC1", text: "The boundary is checked" },
  { id: "AC2", text: "Errors are reported" },
]

const blocks: WorkflowBlock[] = [
  { id: "implementation", kind: "coding" },
  { id: "verification", kind: "verify", depends_on: ["implementation"] },
  {
    id: "decision",
    kind: "review",
    depends_on: ["verification"],
    lenses: ["standards", "intent", "completeness"],
    skeptics: 1,
  },
  { id: "final", kind: "synthesize", depends_on: ["decision"] },
]

export const strictConfig = (): WorkflowConfig => ({
  name: "quality",
  review_gate: "strict",
  acceptance,
  nodes: DagBlocks.compileWorkflowBlocks(
    { objective: "Ship the bounded change", blocks },
    { review_gate: "strict", acceptance },
  ),
})

/** The id `makeWorkflowRow` gives a workflow, and the one `prior_round` names to stay in it. */
export const WORKFLOW_ID = "wf-1"

/**
 * The same review block again under `to`, as an extend that adds a later round.
 * Without `prior` it is an independent review of its own; with `prior` (the
 * review id of an earlier round) it continues that review through `prior_round`,
 * in this workflow unless `priorWorkflow` names another.
 */
export const withRound = (
  config: WorkflowConfig,
  to: string,
  round: number,
  prior?: string,
  priorWorkflow = WORKFLOW_ID,
): WorkflowConfig => {
  const rename = (id: string) => (id === "decision" ? to : id.startsWith("decision--") ? `${to}${id.slice(8)}` : id)
  const clones = config.nodes
    .filter((node) => node.id === "decision" || node.id.startsWith("decision--"))
    .map((node): NodeConfig => ({
      ...node,
      id: rename(node.id),
      depends_on: node.depends_on.map(rename),
      ...(node.id === "decision"
        ? {
            review_round: round,
            ...(prior === undefined ? {} : { prior_round: { workflow_id: priorWorkflow, review_id: prior } }),
          }
        : {}),
    }))
  return { ...config, nodes: [...config.nodes, ...clones] }
}

export type Outputs = Record<string, { status?: string; output?: unknown; staleTarget?: boolean }>

/** One persisted row per configured node; unlisted nodes are pending. */
export const rowsFor = (config: WorkflowConfig, outputs: Outputs): DagStore.NodeRow[] =>
  config.nodes.map((node) =>
    makeNodeRow({
      id: node.id,
      name: node.name,
      dependsOn: node.depends_on,
      status: outputs[node.id]?.status ?? (node.id in outputs ? "completed" : "pending"),
      output: outputs[node.id]?.output,
      staleTarget: outputs[node.id]?.staleTarget ?? null,
    }),
  )

export const disposition = (
  node: string,
  index: number,
  decision: "upheld" | "refuted",
  novelty: "new" | { dup_of: string } = "new",
) => ({
  node,
  index,
  novelty,
  decision,
  evidence: "checked",
})

export const completeness = (covered: string[], missing: string[], unlisted: string[] = []) => ({
  verdict: missing.length > 0 || unlisted.length > 0 ? "REJECT" : "ACCEPT",
  required_actions: [...missing.map((id) => `${id} missing`), ...unlisted],
  acceptance: [
    ...covered.map((id) => ({ id, status: "covered", evidence: "seen" })),
    ...missing.map((id) => ({ id, status: "missing", evidence: "absent" })),
  ],
  unlisted,
})

export const lane = (...actions: string[]) => ({
  verdict: actions.length > 0 ? "REJECT" : "ACCEPT",
  required_actions: actions,
})

/** A completeness lane's judgement of each acceptance item, without the actions it would raise. */
export const judgement = (status: Record<string, "covered" | "partial" | "missing">, unlisted: string[] = []) => ({
  verdict: "ACCEPT",
  required_actions: [],
  acceptance: Object.entries(status).map(([id, state]) => ({ id, status: state, evidence: "seen" })),
  unlisted,
})

/**
 * The outputs of one finished review round under `id`: clean lanes unless a
 * lane is given, and the arbitration `decision` over them. Round outputs are
 * compared by their accounting here, not by the arbitration contract.
 */
export const roundOutputs = (
  id: string,
  input: { decision: Record<string, unknown>; lanes?: Partial<Record<"standards" | "completeness", unknown>> },
): Outputs => ({
  [`${id}--standards`]: { output: input.lanes?.standards ?? lane() },
  [`${id}--intent`]: { output: lane() },
  [`${id}--completeness`]: { output: input.lanes?.completeness ?? judgement({ AC1: "covered", AC2: "covered" }) },
  [`${id}--skeptic-1`]: { output: lane() },
  [id]: {
    output: {
      verdict: "REJECT",
      implementation_fingerprint: "fp-1",
      required_actions: [],
      dispositions: [],
      resolved: [],
      ...input.decision,
    },
  },
})

/** The round-one arbitration: four upheld new findings (one a skeptic's) and one refuted claim. */
export const roundOneDecision = {
  verdict: "REJECT",
  implementation_fingerprint: "fp-1",
  required_actions: [],
  dispositions: [
    disposition("decision--standards", 0, "upheld"),
    disposition("decision--standards", 1, "refuted"),
    disposition("decision--completeness", 0, "upheld"),
    disposition("decision--completeness", 1, "upheld"),
    disposition("decision--skeptic-1", 0, "upheld"),
  ],
  resolved: [],
}

/** Round one: the lanes behind that arbitration, with AC2 missing. */
export const roundOne: Outputs = {
  implementation: { output: { summary: "done", changed_files: ["a.ts"], fingerprint: "fp-1" } },
  verification: { output: { verdict: "PASS", summary: "green", evidence: [] } },
  "decision--standards": { output: lane("Fix A", "Drop B") },
  "decision--intent": { output: lane() },
  "decision--completeness": { output: completeness(["AC1"], ["AC2"], ["Unlisted expectation"]) },
  "decision--skeptic-1": { output: lane("Counterexample") },
  decision: { output: roundOneDecision },
}

/** An ACCEPT that echoes the implementation fingerprint, every lane clean. */
export const acceptedDecision = {
  verdict: "ACCEPT",
  implementation_fingerprint: "fp-1",
  required_actions: [],
  dispositions: [],
  resolved: [],
}

/** A review that accepted the implementation and ran the final gate. */
export const accepted: Outputs = {
  implementation: { output: { summary: "done", changed_files: ["a.ts"], fingerprint: "fp-1" } },
  verification: { output: { verdict: "PASS", summary: "green", evidence: [] } },
  "decision--standards": { output: lane() },
  "decision--intent": { output: lane() },
  "decision--completeness": { output: completeness(["AC1", "AC2"], []) },
  "decision--skeptic-1": { output: lane() },
  decision: { output: acceptedDecision },
  final: { output: { summary: "ready" } },
}

/**
 * Two independent reviews in one workflow. Chain A is the block `decision` and
 * its continuation `decision2`; chain B is a separate block `other` with the
 * continuations `other2` and `other3`. B runs the later rounds, so the last
 * decision of the workflow is B's, while A is the chain that still has an open
 * finding.
 */
export const chainsConfig = (): WorkflowConfig =>
  withRound(
    withRound(withRound(withRound(strictConfig(), "decision2", 2, "decision"), "other", 1), "other2", 2, "other"),
    "other3",
    3,
    "other2",
  )

export const chainsOutputs: Outputs = {
  implementation: roundOne.implementation,
  verification: roundOne.verification,
  ...roundOutputs("decision", {
    lanes: { standards: lane("Fix A") },
    decision: { dispositions: [disposition("decision--standards", 0, "upheld")] },
  }),
  ...roundOutputs("decision2", {
    lanes: { completeness: judgement({ AC1: "covered", AC2: "missing" }, ["Edge case"]) },
    decision: {
      resolved: [{ ref: `${WORKFLOW_ID}/decision--standards/0`, how: "still_open", evidence: "waiting on the API" }],
    },
  }),
  ...roundOutputs("other", {
    lanes: { standards: lane("Fix B") },
    decision: { dispositions: [disposition("other--standards", 0, "upheld")] },
  }),
  ...roundOutputs("other2", {
    decision: { resolved: [{ ref: `${WORKFLOW_ID}/other--standards/0`, how: "fixed", evidence: "src/b.ts" }] },
  }),
  ...roundOutputs("other3", {
    lanes: { completeness: judgement({ AC1: "covered", AC2: "covered" }, ["Edge case", "Other"]) },
    decision: {},
  }),
}
