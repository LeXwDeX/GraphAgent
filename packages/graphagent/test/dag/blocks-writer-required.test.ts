// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR4a (D9): a writer block that leaves `required` out is required, so code that failed to be written fails
// the workflow at the writer instead of surfacing later at a verification that read a placeholder. An explicit
// value always wins, and every read-only block keeps its own default. The scheduler's required-failure path is
// exercised through the loop in dag-tier-roles-runtime.test.ts.
import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import type { NodeConfig } from "@/dag/dag"

type BlockInput = ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]

function compile(blocks: BlockInput[]): NodeConfig[] {
  return DagBlocks.compileWorkflowBlocks({
    objective: "Deliver the change",
    blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block)),
  })
}

const requiredOf = (nodes: readonly NodeConfig[]) => Object.fromEntries(nodes.map((node) => [node.id, node.required]))

describe("writer block defaults", () => {
  it.each(["coding", "prototype"] as const)(
    "compiles a %s block that leaves required out to required: true",
    (kind) => {
      expect(requiredOf(compile([{ id: "writer", kind }]))).toEqual({ writer: true })
    },
  )

  it.each(["coding", "prototype"] as const)("keeps an explicit required value on a %s block", (kind) => {
    expect(requiredOf(compile([{ id: "writer", kind, required: false }]))).toEqual({ writer: false })
    expect(requiredOf(compile([{ id: "writer", kind, required: true }]))).toEqual({ writer: true })
  })

  it("leaves the read-only blocks on their own defaults", () => {
    const nodes = compile([
      { id: "map", kind: "explore" },
      { id: "plan", kind: "plan", depends_on: ["map"] },
      { id: "bug", kind: "debug", depends_on: ["map"] },
      { id: "check", kind: "verify", depends_on: ["plan", "bug"] },
      { id: "gate", kind: "review", depends_on: ["check"] },
      { id: "report", kind: "synthesize", depends_on: ["gate"] },
    ])
    expect(requiredOf(nodes)).toEqual({
      map: false,
      plan: true,
      "bug--evidence": false,
      bug: true,
      check: true,
      "gate--standards": false,
      "gate--intent": false,
      gate: true,
      report: true,
    })
  })

  it("keeps an optional exploration optional even when a writer reads it", () => {
    const nodes = compile([
      { id: "map", kind: "explore" },
      { id: "build", kind: "coding", depends_on: ["map"] },
    ])
    expect(requiredOf(nodes)).toEqual({ map: false, build: true })
  })

  it("carries the writer's value onto a fan_out writer, whose package writers inherit it at admission", () => {
    const fanOut = (required?: boolean) =>
      compile([
        { id: "plan", kind: "plan" },
        {
          id: "slices",
          kind: "coding",
          depends_on: ["plan"],
          fan_out: "plan",
          ...(required === undefined ? {} : { required }),
        },
      ]).find((node) => node.id === "slices")
    expect(fanOut()).toMatchObject({ required: true, fan_out: "plan" })
    expect(fanOut(false)).toMatchObject({ required: false, fan_out: "plan" })
    expect(fanOut(true)).toMatchObject({ required: true, fan_out: "plan" })
  })

  it("keeps the generated aggregator of parallel writers required", () => {
    const nodes = compile([
      { id: "api", kind: "coding" },
      { id: "ui", kind: "coding" },
      { id: "check", kind: "verify", depends_on: ["api", "ui"] },
      { id: "gate", kind: "review", depends_on: ["check"] },
    ])
    expect(requiredOf(nodes)).toMatchObject({ api: true, ui: true, "gate--aggregate": true, check: true, gate: true })
    expect(nodes.find((node) => node.id === "gate--aggregate")).toMatchObject({
      aggregates_writers: true,
      generated_helper: "aggregate",
    })
  })

  it("makes a gated writer required without making its skip a failure", () => {
    const nodes = compile([
      { id: "plan", kind: "plan" },
      { id: "check", kind: "verify", depends_on: ["plan"] },
      { id: "gate", kind: "review", depends_on: ["check"] },
      { id: "fix", kind: "coding", depends_on: ["gate"] },
    ])
    // A writer after a review gate waits for its verdict: it runs only on ACCEPT, and a skipped branch is accepted.
    expect(nodes.find((node) => node.id === "fix")).toMatchObject({
      required: true,
      condition: 'gate.output.verdict == "ACCEPT"',
      skip_ok: true,
    })
  })
})
