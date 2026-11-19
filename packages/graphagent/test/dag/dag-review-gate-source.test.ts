// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1560: where the effective review gate came from decides what a strict
// failure tells the author. Only a gate the spec declared itself can be lowered
// by editing the spec; when DAG mode (a caller override) or a deep workflow fixed
// it, the diagnostic says how to satisfy strict instead of suggesting a change
// that cannot take effect. The source is a validation detail: it never reaches
// the prepared graph, and so never the stored workflow.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { ReviewGate } from "@/dag/blocks"
import { DagValidation } from "@/dag/validation"

const LOWER = "lower config.review_gate"
const GENERIC_BLOCK_HINT =
  "Blocks must satisfy the writer-serialization and review-route contracts; inline compiled nodes if you need a shape blocks cannot express"
const SESSION_REASON = "DAG mode fixes the strict review gate at start, so the spec cannot lower it"
const DEEP_REASON = "A deep workflow always runs under the strict review gate"
const WORKFLOW_REASON = "The workflow's strict review gate was frozen at start, so a fragment cannot lower it"

const brief = {
  goal: "Ship the bounded change",
  scope: { in: ["src"], out: [] },
  constraints: [],
  assumptions: [],
  acceptance_criteria: ["criterion one"],
  evidence_required: ["focused checks pass"],
  risks: [],
  review_plan: ["independent review"],
  open_questions: [],
  blocking_questions: [],
}
const admission = { brief_revision: 1, qa_mode: "STANDARD", verdict: "READY", brief }

const acceptance = [{ id: "AC1", text: "The change works" }]
const completeness = ["standards", "intent", "completeness"]

/** A hand-written node on a write-capable worker: strict rejects it. */
const writerNode: DagValidation.NodeSpec = {
  id: "work",
  name: "work",
  worker_type: "general",
  depends_on: [],
  prompt_template: { inline: "Do the work" },
}

const prepare = (value: unknown, input: { action?: "start" | "extend" | "replan"; review_gate?: ReviewGate } = {}) =>
  Effect.runPromise(
    WorkflowAuthoring.make().prepare({
      action: input.action ?? "start",
      source: { kind: "inline", value },
      profile: "portable",
      ...(input.review_gate !== undefined ? { review_gate: input.review_gate } : {}),
    }),
  )

const start = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...extra,
  config: { name: "gate-source", ...config },
})

const onlyError = (result: Awaited<ReturnType<typeof prepare>>) => {
  expect(result.valid).toBe(false)
  expect(result.errors).toHaveLength(1)
  return result.errors[0]
}

describe("a node-form writer under strict", () => {
  const nodes = { nodes: [writerNode] }

  it("keeps suggesting a lower gate when the spec declared strict itself", async () => {
    const error = onlyError(await prepare(start({ ...nodes, review_gate: "strict" })))
    expect(error.path).toBe("nodes[work].worker_type")
    expect(error.hint).toBe("Use the blocks form (objective + blocks) or lower config.review_gate to standard")
  })

  it("does not suggest it when DAG mode fixed the gate, even over an authored standard", async () => {
    for (const authored of [{}, { review_gate: "standard" }]) {
      const error = onlyError(await prepare(start({ ...nodes, ...authored }), { review_gate: "strict" }))
      expect(error.hint).not.toContain(LOWER)
      expect(error.hint).toContain(SESSION_REASON)
      // It says how to satisfy strict instead.
      expect(error.hint).toContain("use the blocks form (objective + blocks)")
      expect(error.hint).toContain("a synthesize block that depends on the review")
      expect(error.hint).toContain("read-only worker_type")
    }
  })

  it("does not suggest it for a deep workflow", async () => {
    const error = onlyError(await prepare(start(nodes, { mode: "deep", admission })))
    expect(error.hint).not.toContain(LOWER)
    expect(error.hint).toContain(DEEP_REASON)
  })

  it("does not suggest it for a fragment: the gate was frozen at start", async () => {
    for (const action of ["extend", "replan"] as const) {
      const value = action === "extend" ? nodes : { fragment: { name: "fragment", ...nodes } }
      const error = onlyError(await prepare(value, { action, review_gate: "strict" }))
      expect(error.hint).not.toContain(LOWER)
      expect(error.hint).toContain(WORKFLOW_REASON)
    }
  })

  it("treats a gate with no recorded source as the spec's own", () => {
    const compiled = DagValidation.compileBlockSource({ nodes: [writerNode] }, { review_gate: "strict" })
    expect(compiled.diagnostics[0]?.hint).toContain(LOWER)
  })
})

describe("a strict failure of block compilation", () => {
  // One case per rule DagBlocks.requireReviewCoverage enforces: the real message,
  // and what the hint tells the author to do about it.
  // A writer routed through verify, a review and a final gate, with acceptance
  // items unless `items` is null: valid under strict until one rule is broken.
  const reviewed = (review: Record<string, unknown>, items: readonly object[] | null = acceptance) => ({
    objective: "Ship the bounded change",
    blocks: [
      { id: "implementation", kind: "coding" },
      { id: "verification", kind: "verify", depends_on: ["implementation"] },
      { id: "decision", kind: "review", depends_on: ["verification"], lenses: completeness, ...review },
      { id: "final", kind: "synthesize", depends_on: ["decision"] },
    ],
    ...(items === null ? {} : { acceptance: items }),
  })

  const rules: ReadonlyArray<{ rule: string; config: Record<string, unknown>; message: string; repair: string }> = [
    {
      rule: "a writer with no downstream review",
      config: { objective: "Ship it", blocks: [{ id: "implementation", kind: "coding" }], acceptance },
      message: "has no downstream review gate",
      repair: "a review block that depends on that verify, and a synthesize block that depends on the review",
    },
    {
      rule: "a worker override to a write-capable profile",
      config: { objective: "Look around", blocks: [{ id: "summary", kind: "synthesize", worker_type: "build" }] },
      message: "overrides its worker to write-capable",
      repair: "drop worker_type from that block; only coding and prototype blocks may write",
    },
    {
      rule: "a review that may be skipped",
      config: reviewed({ required: false }),
      message: "must set required: true",
      repair: "drop required: false from the review block",
    },
    {
      rule: "a review without the completeness lens",
      config: reviewed({ lenses: ["standards", "intent"] }),
      message: "must include the completeness lens",
      repair: "add completeness to the review block's lenses, for example lenses: [standards, intent, completeness]",
    },
    {
      rule: "a review on a write-capable worker",
      config: reviewed({ worker_type: "build" }),
      message: "use write-capable worker",
      repair: "drop worker_type from the review block; the read-only auditor is its default",
    },
    {
      rule: "writers with no acceptance items",
      config: reviewed({}, null),
      message: "must declare config.acceptance",
      repair: "declare config.acceptance as 1-50 items { id, text } with unique ids",
    },
    {
      rule: "repeated acceptance ids",
      config: reviewed({}, [...acceptance, ...acceptance]),
      message: "config.acceptance repeats id(s): AC1",
      repair: "declare config.acceptance as 1-50 items { id, text } with unique ids",
    },
    {
      rule: "more than 50 acceptance items",
      config: reviewed(
        {},
        Array.from({ length: 51 }, (_, index) => ({ id: `AC${index}`, text: "x" })),
      ),
      message: "config.acceptance has 51 items",
      repair: "declare config.acceptance as 1-50 items { id, text } with unique ids",
    },
  ]

  for (const { rule, config, message, repair } of rules) {
    it(`says how to satisfy strict for ${rule} when DAG mode fixed the gate`, async () => {
      const error = onlyError(await prepare(start(config), { review_gate: "strict" }))
      expect(error.code).toBe(DagValidation.DIAGNOSTIC_CODES.blockCompileFailed)
      expect(error.message).toContain(message)
      expect(error.hint).toContain(SESSION_REASON)
      expect(error.hint).toContain(repair)
      expect(error.hint).not.toContain(LOWER)
    })

    it(`keeps the generic hint for ${rule} when the spec declared strict itself`, async () => {
      const error = onlyError(await prepare(start({ ...config, review_gate: "strict" })))
      expect(error.message).toContain(message)
      expect(error.hint).toBe(GENERIC_BLOCK_HINT)
    })
  }

  it("names the deep workflow as the reason when the mode fixed the gate", async () => {
    const spec = start(
      { objective: "Ship it", blocks: [{ id: "implementation", kind: "coding" }], acceptance },
      { mode: "deep", admission },
    )
    const error = onlyError(await prepare(spec))
    expect(error.hint).toContain(DEEP_REASON)
    expect(error.hint).toContain("a review block that depends on that verify")
  })

  it("tells a fragment to start a successor for acceptance items, which are fixed at start", async () => {
    const fragment = {
      objective: "Add the change",
      blocks: [
        { id: "implementation", kind: "coding" },
        { id: "verification", kind: "verify", depends_on: ["implementation"] },
        { id: "decision", kind: "review", depends_on: ["verification"], lenses: completeness },
        { id: "final", kind: "synthesize", depends_on: ["decision"] },
      ],
    }
    const error = onlyError(await prepare(fragment, { action: "extend", review_gate: "strict" }))
    expect(error.hint).toContain(WORKFLOW_REASON)
    expect(error.hint).toContain("start a successor workflow that declares config.acceptance")
    expect(error.hint).not.toContain(LOWER)
  })

  it("keeps the generic hint for a failure that is not one of the strict rules", async () => {
    // A review fed by a prototype with no verification fails block routing under any gate.
    const spec = start({
      objective: "Ship it",
      blocks: [
        { id: "proto", kind: "prototype" },
        { id: "decision", kind: "review", depends_on: ["proto"], lenses: completeness },
      ],
      acceptance,
    })
    for (const gate of [undefined, "strict"] as const) {
      const error = onlyError(await prepare(spec, gate ? { review_gate: gate } : {}))
      expect(error.message).toContain("requires exactly one verification ancestor")
      expect(error.hint).toBe(GENERIC_BLOCK_HINT)
    }
  })
})

describe("a strict diff review without its final gate", () => {
  const spec = start({
    objective: "Ship the bounded change",
    blocks: [
      { id: "implementation", kind: "coding" },
      { id: "verification", kind: "verify", depends_on: ["implementation"] },
      { id: "decision", kind: "review", depends_on: ["verification"], lenses: completeness },
    ],
    acceptance,
  })

  it("says to add a block after the review, whoever fixed the gate", async () => {
    for (const input of [{ review_gate: "strict" as const }, {}]) {
      const declared = Object.keys(input).length === 0 ? start({ ...spec.config, review_gate: "strict" }) : spec
      const error = onlyError(await prepare(declared, input))
      expect(error.message).toContain("must feed a required final gate conditioned on verdict ACCEPT")
      expect(error.hint).toContain("synthesize block")
      expect(error.hint).toContain('condition `<review>.output.verdict == "ACCEPT"`')
    }
  })
})

describe("the gate source is not part of the prepared graph", () => {
  const spec = (config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    start({ objective: "Look around", blocks: [{ id: "survey", kind: "explore" }], ...config }, extra)

  /** Every key of a value, at any depth. */
  const keysOf = (value: unknown): string[] =>
    typeof value !== "object" || value === null
      ? []
      : Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)])

  const prepared = async (value: unknown, input: { review_gate?: ReviewGate } = {}) => {
    const result = await prepare(value, input)
    expect(result.valid).toBe(true)
    if (result.prepared?.action !== "start") throw new Error("expected a prepared start graph")
    return result.prepared.config
  }

  it("gives an authored, a session and a deep start the same stored shape", async () => {
    const authored = await prepared(spec({ review_gate: "strict" }))
    const session = await prepared(spec(), { review_gate: "strict" })
    const deep = await prepared(spec({}, { mode: "deep", admission }))
    expect(session).toEqual(authored)
    expect(deep).toEqual({ ...authored, mode: "deep", acceptance: [{ id: "AC1", text: "criterion one" }] })
    for (const config of [authored, session, deep]) {
      expect(config.review_gate).toBe("strict")
      expect(keysOf(config)).not.toContain("review_gate_source")
      expect(keysOf(config)).not.toContain("gate_source")
      expect(Object.keys(config)).not.toContain("source")
    }
  })

  it("leaves an authored standard gate standard when nothing fixes it", async () => {
    expect((await prepared(spec())).review_gate).toBe("standard")
    expect((await prepared(spec({ review_gate: "standard" }))).review_gate).toBe("standard")
  })
})
