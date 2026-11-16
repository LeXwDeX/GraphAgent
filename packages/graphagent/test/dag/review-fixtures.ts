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

/** The same review block again under `to`, as an extend that adds a later round. */
export const withRound = (config: WorkflowConfig, to: string, round: number): WorkflowConfig => {
  const rename = (id: string) => (id === "decision" ? to : id.startsWith("decision--") ? `${to}${id.slice(8)}` : id)
  const clones = config.nodes
    .filter((node) => node.id === "decision" || node.id.startsWith("decision--"))
    .map((node): NodeConfig => ({
      ...node,
      id: rename(node.id),
      depends_on: node.depends_on.map(rename),
      ...(node.id === "decision" ? { review_round: round } : {}),
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
