// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { AcceptanceItem, ReviewGate } from "@/dag/blocks"

const brief = {
  goal: "Ship the bounded change",
  scope: { in: ["src"], out: [] },
  constraints: [],
  assumptions: [],
  acceptance_criteria: ["criterion one", "criterion two"],
  evidence_required: ["focused checks pass"],
  risks: [],
  review_plan: ["independent review"],
  open_questions: [],
  blocking_questions: [],
}

const node = {
  id: "work",
  name: "work",
  worker_type: "general",
  depends_on: [],
  prompt_template: { inline: "Do the work" },
}

const startSpec = (input: {
  mode?: "standard" | "deep"
  reviewGate?: ReviewGate
  acceptance?: AcceptanceItem[]
  blocks?: unknown[]
} = {}) => ({
  ...(input.mode ? { mode: input.mode } : {}),
  ...(input.mode === "deep" ? { admission: { brief_revision: 1, qa_mode: "STANDARD", verdict: "READY", brief } } : {}),
  config: {
    name: "review-gate",
    ...(input.reviewGate ? { review_gate: input.reviewGate } : {}),
    ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    ...(input.blocks
      ? { objective: "Review the bounded change", blocks: input.blocks }
      : { nodes: [node] }),
  },
})

const prepare = (
  value: unknown,
  input: { action?: "start" | "extend" | "replan"; review_gate?: ReviewGate; acceptance?: readonly AcceptanceItem[] } = {},
) =>
  Effect.runPromise(
    WorkflowAuthoring.make().prepare({
      action: input.action ?? "start",
      source: { kind: "inline", value },
      profile: "portable",
      ...(input.review_gate !== undefined ? { review_gate: input.review_gate } : {}),
      ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
    }),
  )

function startConfig(result: Awaited<ReturnType<typeof prepare>>) {
  if (!result.prepared || result.prepared.action !== "start") throw new Error("expected a prepared start graph")
  return result.prepared.config
}

describe("review gate fixation and acceptance", () => {
  it("fixes a deep workflow to strict and derives AC1..ACn from the admission brief", async () => {
    const result = await prepare(startSpec({ mode: "deep" }))
    expect(result.valid).toBe(true)
    expect(startConfig(result)).toMatchObject({
      mode: "deep",
      review_gate: "strict",
      acceptance: [
        { id: "AC1", text: "criterion one" },
        { id: "AC2", text: "criterion two" },
      ],
    })
  })

  it("keeps an authored acceptance list instead of deriving one", async () => {
    const result = await prepare(
      startSpec({ mode: "deep", acceptance: [{ id: "X1", text: "authored criterion" }] }),
    )
    expect(startConfig(result).acceptance).toEqual([{ id: "X1", text: "authored criterion" }])
  })

  it("lets a session-mode override upgrade an authored standard gate to strict", async () => {
    const standard = await prepare(startSpec({ reviewGate: "standard" }))
    expect(startConfig(standard).review_gate).toBe("standard")

    const overridden = await prepare(startSpec({ reviewGate: "standard" }), { review_gate: "strict" })
    expect(startConfig(overridden).review_gate).toBe("strict")
  })

  it("defaults to the standard gate and honors an authored strict gate", async () => {
    expect(startConfig(await prepare(startSpec())).review_gate).toBe("standard")
    expect(startConfig(await prepare(startSpec({ reviewGate: "strict" }))).review_gate).toBe("strict")
  })

  it("rejects gate fields in replan fragments", async () => {
    const base = { name: "fragment", nodes: [node] }
    for (const field of ["review_gate", "acceptance"] as const) {
      const result = await prepare(
        {
          fragment:
            field === "review_gate"
              ? { ...base, review_gate: "strict" }
              : { ...base, acceptance: [{ id: "AC1", text: "criterion" }] },
        },
        { action: "replan" },
      )
      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: `fragment.${field}` }),
      )
    }
  })

  it("accepts the review lens and skeptic ranges and rejects values beyond them", async () => {
    const nodesBlock = (extra: { lenses?: string[]; skeptics?: number }) => [
      { id: "implementation", kind: "coding" },
      { id: "verification", kind: "verify", depends_on: ["implementation"] },
      { id: "review", kind: "review", depends_on: ["verification"], ...extra },
    ]

    const accepted = await prepare(
      startSpec({ blocks: nodesBlock({ lenses: ["standards", "completeness"], skeptics: 4 }) }),
    )
    expect(accepted.valid).toBe(true)

    for (const extra of [{ lenses: ["unknown"] }, { skeptics: 5 }, { skeptics: -1 }]) {
      const rejected = await prepare(startSpec({ blocks: nodesBlock(extra) }))
      expect(rejected.valid).toBe(false)
      expect(rejected.errors).toContainEqual(
        expect.objectContaining({ code: "schema.invalid" }),
      )
    }
  })
})