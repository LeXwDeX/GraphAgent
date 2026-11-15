// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M6: the strict review-coverage gate (writers need a bound diff review,
// completeness lenses, acceptance items, read-only lanes) plus the coverage
// contract that keeps skipped/failed/unread work visible.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { WorkflowAuthoring } from "@/dag/authoring"
import {
  DagBlocks,
  type AcceptanceItem,
  type ReviewGate,
  type ReviewLens,
  type WorkflowBlock,
} from "@/dag/blocks"
import { strictReviewCoverageErrors } from "@/dag/review-lifecycle"
import { settleCapturedOutput } from "@/dag/runtime/capture"
import { recoveredSettlement } from "@/dag/runtime/recovery"
import { coverageSection, resultPage, withResultPageCoverage, workflowCoverage } from "@/dag/coverage"
import { renderResult, renderStatus } from "@/tool/workflow/render"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const acceptance: AcceptanceItem[] = [{ id: "AC1", text: "The change works" }]

const reviewed = (extra: { lenses?: ReviewLens[]; acceptance?: boolean } = {}): {
  objective: string
  blocks: WorkflowBlock[]
  acceptance?: AcceptanceItem[]
} => ({
  objective: "Ship the bounded change",
  blocks: [
    { id: "implementation", kind: "coding" },
    { id: "verification", kind: "verify", depends_on: ["implementation"] },
    {
      id: "decision",
      kind: "review",
      depends_on: ["verification"],
      lenses: extra.lenses ?? ["standards", "intent", "completeness"],
    },
    // The strict gate also keeps the pre-existing final-gate requirement: the
    // accepted review must feed a required node conditioned on ACCEPT.
    { id: "final", kind: "synthesize", depends_on: ["decision"] },
  ] as WorkflowBlock[],
  ...(extra.acceptance === false ? {} : { acceptance }),
})

const prepare = (value: unknown, input: { action?: "start" | "extend" | "replan"; review_gate?: ReviewGate; acceptance?: readonly AcceptanceItem[] } = {}) =>
  Effect.runPromise(
    WorkflowAuthoring.make().prepare({
      action: input.action ?? "start",
      source: { kind: "inline", value },
      profile: "portable",
      ...(input.review_gate !== undefined ? { review_gate: input.review_gate } : {}),
      ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
    }),
  )

const graph = (config: Record<string, unknown>) => ({ config: { name: "strict", ...config } })
const startSpec = (config: Record<string, unknown>) => graph(config)

function strictGraph(extra: { lenses?: ReviewLens[]; acceptance?: boolean } = {}) {
  const spec = reviewed(extra)
  const { objective, blocks, acceptance: items } = spec
  return {
    name: "strict",
    objective,
    blocks,
    ...(items ? { acceptance: items } : {}),
    review_gate: "strict" as const,
  }
}

describe("strict review coverage at authoring checkpoints", () => {
  it("accepts a writer routed through verify and a completeness diff review", async () => {
    const result = await prepare(startSpec(strictGraph()))
    expect(result.valid).toBe(true)
  })

  it("rejects a writer with no downstream review", async () => {
    const result = await prepare(
      startSpec({
        name: "strict",
        objective: "Ship it",
        blocks: [{ id: "implementation", kind: "coding" }],
        acceptance,
        review_gate: "strict",
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.message).toContain("has no downstream review gate bound to its implementation fingerprint")
  })

  it("rejects a strict review without the completeness lens", async () => {
    const result = await prepare(startSpec(strictGraph({ lenses: ["standards", "intent"] })))
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.message).toContain('must include the completeness lens under the strict gate')
  })

  it("rejects a writing strict graph without acceptance items", async () => {
    const result = await prepare(startSpec(strictGraph({ acceptance: false })))
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.message).toContain("must declare config.acceptance")
  })

  it("rejects a non-block write-capable node under strict", async () => {
    const result = await prepare(
      startSpec({
        name: "strict",
        nodes: [
          {
            id: "work",
            name: "work",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "Do the work" },
          },
        ],
        review_gate: "strict",
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.message).toContain('node "work" is write-capable ("general")')
    expect(result.errors[0]?.message).toContain(
      "under the strict review gate writers must use a coding, prototype, or build block so they produce a fingerprint",
    )
  })

  it("accepts a read-only explore plus synthesize block graph", async () => {
    const result = await prepare(
      startSpec({
        name: "read-only",
        objective: "Compare two approaches",
        blocks: [
          { id: "left", kind: "explore" },
          { id: "right", kind: "explore" },
          { id: "merge", kind: "synthesize", depends_on: ["left", "right"] },
        ],
        review_gate: "strict",
      }),
    )
    expect(result.valid).toBe(true)
  })

  it("keeps the same gaps advisory under the standard gate", async () => {
    const result = await prepare(
      startSpec({
        name: "standard",
        objective: "Ship it",
        blocks: [
          { id: "implementation", kind: "coding" },
          { id: "verification", kind: "verify", depends_on: ["implementation"] },
          { id: "decision", kind: "review", depends_on: ["verification"], lenses: ["standards", "intent"] },
        ],
      }),
      { review_gate: "standard" },
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((warning) => warning.message.includes("completeness lens"))).toBe(true)
    expect(result.warnings.some((warning) => warning.message.includes("config.acceptance"))).toBe(true)
  })

  it("rejects a strict extend or replan fragment that adds an uncovered writer", async () => {
    const extend = await prepare(
      { objective: "Ship it", blocks: [{ id: "implementation", kind: "coding" }] },
      { action: "extend", review_gate: "strict", acceptance },
    )
    expect(extend.valid).toBe(false)
    expect(extend.errors[0]?.message).toContain("has no downstream review gate")

    const replan = await prepare(
      {
        fragment: {
          name: "fragment",
          objective: "Ship it",
          blocks: [
            { id: "implementation", kind: "coding" },
            { id: "verification", kind: "verify", depends_on: ["implementation"] },
            { id: "decision", kind: "review", depends_on: ["verification"], lenses: ["standards", "intent"] },
            { id: "final", kind: "synthesize", depends_on: ["decision"] },
          ],
        },
      },
      { action: "replan", review_gate: "strict", acceptance },
    )
    expect(replan.valid).toBe(false)
    expect(replan.errors[0]?.message).toContain("must include the completeness lens")
  })

  it("fails completion when a strict verify FAIL leaves the decision skipped", () => {
    const nodes = DagBlocks.compileWorkflowBlocks(
      { objective: "Ship it", blocks: reviewed().blocks },
      { review_gate: "strict", acceptance },
    )
    const config = { name: "strict", review_gate: "strict" as const, acceptance, nodes }
    const rows = nodes.map((node) => {
      if (node.id === "implementation") return completionRow(node, "completed", { fingerprint: "sha" })
      if (node.id === "verification") return completionRow(node, "completed", { verdict: "FAIL" })
      // Every review lane and the decision are condition-skipped on FAIL.
      return completionRow(node, "skipped", null)
    })
    const gaps = Dag.requiredCompletionGaps(config, rows, "natural")
    expect(gaps).toContainEqual(expect.stringContaining("decision (skipped"))

    const standardNodes = DagBlocks.compileWorkflowBlocks({ objective: "Ship it", blocks: reviewed().blocks }, {})
    const standardConfig = { name: "standard", review_gate: "standard" as const, acceptance, nodes: standardNodes }
    const standardRows = standardNodes.map((node) =>
      node.id === "verification"
        ? completionRow(node, "completed", { verdict: "FAIL" })
        : node.id === "implementation"
          ? completionRow(node, "completed", { fingerprint: "sha" })
          : completionRow(node, "skipped", null),
    )
    // Standard mode skips the decision instead: the FAIL is the only gap.
    const standardGaps = Dag.requiredCompletionGaps(standardConfig, standardRows, "natural")
    expect(standardGaps).toContain("verification (verdict FAIL)")
    expect(standardGaps.some((gap) => gap.startsWith("decision"))).toBe(false)
  })

  it("re-checks persisted block semantics without the authored blocks", () => {
    const nodes = DagBlocks.compileWorkflowBlocks(
      { objective: "Ship it", blocks: reviewed().blocks },
      { review_gate: "strict", acceptance },
    )
    expect(strictReviewCoverageErrors({ nodes, acceptance })).toEqual([])

    const withoutLens = nodes.map((node) =>
      node.review_arbitration ? { ...node, review_lenses: ["standards", "intent"] } : node,
    )
    expect(strictReviewCoverageErrors({ nodes: withoutLens, acceptance })).toContainEqual(
      expect.stringContaining("must include the completeness lens"),
    )
    // A hand-authored persisted graph is grandfathered (it predates the strict
// gate); the non-block writer rejection happens where the source is authored.
    expect(
      strictReviewCoverageErrors({
        nodes: [{ ...completionConfigNode("plain"), worker_type: "general" }],
      }),
    ).toEqual([])
  })
})

describe("runtime strict lane completeness", () => {
  const output = {
    verdict: "ACCEPT",
    summary: "ok",
    findings: [],
    required_actions: [],
    dispositions: [],
    resolved: [],
  }

  it("refuses an ACCEPT while a lane is not completed and accepts BLOCKED", () => {
    const accepted = settleCapturedOutput(output, undefined, "", true, [], {
      reviewArbitration: true,
      strictReviewGate: true,
      incompleteReviewLanes: ["review--skeptic-1"],
    })
    expect(accepted.kind).toBe("fail")
    if (accepted.kind === "fail")
      expect(accepted.reason).toContain("ACCEPT requires every review lane to complete under the strict gate")

    const blocked = settleCapturedOutput(
      { ...output, verdict: "BLOCKED" },
      undefined,
      "",
      true,
      [],
      { reviewArbitration: true, strictReviewGate: true, incompleteReviewLanes: ["review--skeptic-1"] },
    )
    expect(blocked.kind).toBe("complete")
  })
})

describe("recovery settlement", () => {
  const nodeConfig: NodeConfig = {
    id: "decision",
    name: "decision",
    worker_type: "auditor",
    depends_on: ["implementation", "verification", "review--intent"],
    required: true,
    skip_ok: false,
    prompt_template: { inline: "arbitrate" },
    input_mapping: {
      implementation_changed_files: "implementation.output.changed_files",
      implementation_fingerprint: "implementation.output.fingerprint",
      verification: "verification.output",
      intent_review: "review--intent.output",
    },
    review: {
      phase: "diff",
      implementation_node_id: "implementation",
      verification_node_id: "verification",
    },
    review_arbitration: true,
  }
  const rows = [
    makeNodeRow({
      id: "implementation",
      status: "completed",
      output: { fingerprint: "sha256:one", changed_files: ["src/a.ts"] },
    }),
    makeNodeRow({ id: "verification", status: "completed", output: { verdict: "PASS" } }),
    makeNodeRow({ id: "review--intent", status: "completed", output: { verdict: "REJECT", required_actions: [] } }),
    makeNodeRow({
      id: "decision",
      status: "running",
      dependsOn: ["implementation", "verification", "review--intent"],
    }),
  ]
  const config = {
    mode: "deep" as const,
    review_gate: "strict" as const,
    nodes: [nodeConfig, { ...completionConfigNode("review--intent"), review_lane: "intent" }],
  }

  it("re-applies the arbitration and strict lane rules from durable state", () => {
    const captured = {
      verdict: "ACCEPT",
      implementation_fingerprint: "sha256:one",
      required_actions: [],
      dispositions: [],
      resolved: [],
    }
    expect(recoveredSettlement(nodeConfig, config, rows, captured, true)).toMatchObject({ kind: "complete" })

    const missing = recoveredSettlement(
      nodeConfig,
      config,
      rows.map((row) => (row.id === "review--intent" ? { ...row, status: "failed" } : row)),
      captured,
      true,
    )
    expect(missing.kind).toBe("fail")
    if (missing.kind === "fail") expect(missing.reason).toContain("review--intent")
  })
})

describe("coverage", () => {
  const config: WorkflowConfig = {
    name: "coverage",
    nodes: [
      completionConfigNode("gated", { condition: 'gate.output.verdict == "ACCEPT"' }),
      completionConfigNode("broken"),
      completionConfigNode("unread"),
      completionConfigNode("writer", { fan_out: "plan" }),
      {
        ...completionConfigNode("declined"),
        prompt_template: {
          inline:
            "Implement.\n\nParallel fan-out was declined (the plan produced no packages list). Implement every work package yourself.",
        },
      },
    ],
  }

  it("lists gated and failed nodes, fan-out degradation, lane gaps, and a budget pause", () => {
    const entries = workflowCoverage({
      config,
      nodes: [
        makeNodeRow({ id: "gated", status: "skipped" }),
        makeNodeRow({ id: "broken", status: "failed", errorClass: "exec_failed", errorReason: "boom" }),
        makeNodeRow({ id: "unread", status: "completed", output: { not_examined: ["ran out of budget"] } }),
        makeNodeRow({ id: "writer", status: "completed" }),
        makeNodeRow({ id: "declined", status: "completed" }),
      ],
      workflow: { status: "paused", pauseReason: "budget_exhausted" },
    })
    expect(entries).toEqual([
      { node_id: "gated", reason: 'gated: condition evaluated false (gate.output.verdict == "ACCEPT")' },
      { node_id: "broken", reason: "failed: exec_failed: boom" },
      { node_id: "unread", reason: "not examined: ran out of budget" },
      { node_id: "writer", reason: "parallel fan-out declined; the writer ran serially" },
      { node_id: "declined", reason: "parallel fan-out declined: the plan produced no packages list" },
      { node_id: "workflow", reason: "paused: DAG token budget exhausted" },
    ])
  })

  it("records why a review loop stopped", () => {
    const loopConfig = (extra: Partial<NodeConfig>): WorkflowConfig => ({
      name: "loop",
      nodes: [{ ...completionConfigNode("decision"), review_arbitration: true, ...extra }],
    })
    expect(workflowCoverage({ config: loopConfig({ review_round: 5 }), nodes: [] })).toEqual([
      { node_id: "decision", reason: "review loop stopped: five rounds reached" },
    ])
    expect(workflowCoverage({ config: loopConfig({ review_quiet_rounds: 2 }), nodes: [] })).toEqual([
      { node_id: "decision", reason: "review loop stopped: two consecutive quiet rounds" },
    ])
  })

  it("records unread result pages and renders the section in the configured language", () => {
    const page = resultPage(10_000, 4_000, 4_000)
    const entries = withResultPageCoverage([], { nodeID: "result", page, truncated: true })
    expect(entries).toEqual([
      { node_id: "result", reason: "result pages were not fully read", page: { current: 1, total: 3 } },
    ])
    const zh = coverageSection(entries, "zh-CN")
    expect(zh).toContain("## 覆盖与截断")
    expect(zh).toContain("未读页（第 1 页，共 3 页）")
    const en = coverageSection(entries, "en")
    expect(en).toContain("## Coverage and truncation")
    expect(en).toContain("unread pages (page 1 of 3)")
    expect(coverageSection([], "en")).toBeUndefined()
  })

  it("reports the review round chain from arbitration decisions", () => {
    const roundsConfig: WorkflowConfig = {
      name: "rounds",
      review_gate: "strict",
      nodes: [
        { ...completionConfigNode("review--intent"), review_lane: "intent" },
        {
          ...completionConfigNode("decision"),
          review_arbitration: true,
          review_round: 2,
          review_new_findings: 1,
        },
      ],
    }
    const lane = makeNodeRow({
      id: "review--intent",
      status: "completed",
      output: { verdict: "REJECT", required_actions: ["Fix A"] },
    })
    const decision = makeNodeRow({
      id: "decision",
      status: "completed",
      dependsOn: ["review--intent"],
      output: {
        verdict: "REJECT",
        dispositions: [
          { node: "review--intent", index: 0, novelty: "new", decision: "upheld", evidence: "reproduced" },
        ],
        resolved: [],
      },
    })
    const status = renderStatus({
      workflow: makeWorkflowRow({ config: JSON.stringify(roundsConfig) }),
      nodes: [lane, decision],
      allNodes: [lane, decision],
    })
    expect(JSON.parse(status.output).review_quality).toMatchObject({
      rounds: 1,
      quiet_rounds: 0,
      new_findings_per_round: [1],
      raised: 1,
      refuted: 0,
    })
  })

  it("surfaces coverage in the status and paged result views", async () => {
    const workflow = makeWorkflowRow({ config: JSON.stringify(config), status: "running" })
    const status = renderStatus({
      workflow,
      nodes: [makeNodeRow({ id: "gated", status: "skipped" })],
      allNodes: [makeNodeRow({ id: "gated", status: "skipped" })],
      coverage: [{ node_id: "gated", reason: "skipped" }],
      usage: { nodeCount: 4, tokens: 1_234, tokensCacheRead: 56 },
    })
    expect(JSON.parse(status.output)).toMatchObject({
      coverage: [{ node_id: "gated", reason: "skipped" }],
      usage: { nodes: 4, tokens: 1_234, tokens_cache_read: 56 },
    })

    const result = await Effect.runPromise(
      renderResult(
        Dag.ID.make("dag_test"),
        Dag.NodeID.make("node-1"),
        makeNodeRow({ id: "node-1", status: "completed", output: "x".repeat(100) }),
        undefined,
        20,
      ),
    )
    const parsed = JSON.parse(result.output)
    expect(parsed.truncated).toBe(true)
    expect(parsed.coverage).toEqual([
      { node_id: "node-1", reason: "result pages were not fully read", page: { current: 1, total: 5 } },
    ])
  })
})

function completionRow(node: NodeConfig, status: string, output: unknown) {
  return {
    id: node.id,
    status,
    required: node.required ?? false,
    output,
    errorReason: null,
  }
}

function completionConfigNode(id: string, extra: { condition?: string; fan_out?: string } = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "explore",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...extra,
  }
}