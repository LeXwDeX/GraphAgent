// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the compact draft wire schema (#1030): schema.ts mirrors the
 * authoring graph schema by hand. An authoring field added without updating
 * the mirror would make draft reject a config that start/validate accept, so
 * this test derives every field set from the authoring schema and fails
 * explicitly on divergence.
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DagBlocks } from "@/dag/blocks"
import { DagValidation } from "@/dag/validation"
import { CompactBlock, CompactNode, CompactNodeDefaults, DraftGraph, Parameters } from "@/tool/workflow/schema"

const keys = (fields: Record<string, unknown>) => Object.keys(fields).sort()

// #1606: a draft writes a start document, so the node flags that only act in a replan fragment are not on the
// draft wire (the tool definition is a per-turn budget). A replan fragment is its own file envelope.
const REPLAN_ONLY_NODE_FIELDS = ["restart", "cancel"]

describe("workflow draft wire schema parity", () => {
  test("compact node fields mirror the authoring node schema, less the replan-only flags", () => {
    const authoring = keys(DagValidation.NodeSchema.fields)
    // The exclusion names real authoring fields, so it cannot go stale silently.
    for (const field of REPLAN_ONLY_NODE_FIELDS) expect(authoring).toContain(field)
    expect(keys(CompactNode.fields)).toEqual(authoring.filter((field) => !REPLAN_ONLY_NODE_FIELDS.includes(field)))
  })

  test("compact block fields mirror the authoring block schema", () => {
    expect(keys(CompactBlock.fields)).toEqual(keys(DagBlocks.WorkflowBlock.fields))
  })

  test("compact node defaults mirror the authoring node defaults", () => {
    expect(keys(CompactNodeDefaults.fields)).toEqual(keys(DagValidation.NodeDefaults.fields))
  })

  test("draft graph fields mirror both authoring graph shapes", () => {
    // GraphBudgetFields reach the authoring shapes through their spreads, so
    // the union covers every graph-level field, budget ones included.
    const authoring = [
      ...keys(DagValidation.BlocksGraphSchema.fields),
      ...keys(DagValidation.NodesGraphSchema.fields),
    ].sort()
    expect(keys(DraftGraph.fields)).toEqual([...new Set(authoring)])
  })

  test("draft decoding accepts every authoring key and rejects unknown ones", () => {
    const node = {
      id: "build",
      name: "Build",
      worker_type: "build",
      depends_on: [],
      required: true,
      skip_ok: true,
      prompt_template: { inline: "work" },
      worker_config: { timeout_ms: 1000 },
      input_mapping: { plan: "plan" },
      report_to_parent: true,
      condition: "plan.output.ready == true",
      output_schema: { type: "object" },
      review: { phase: "design" },
      fan_out: "plan",
      workspace: "/worktree",
      isolation: "worktree",
      workspace_writes: "deny",
    }
    const block = {
      id: "build",
      kind: "coding",
      depends_on: [],
      instruction: "Implement the plan",
      worker_type: "build",
      worker_config: { timeout_ms: 1000 },
      required: true,
      report_to_parent: true,
      fan_out: "plan",
      lenses: ["standards", "intent"],
      skeptics: 2,
    }
    const config = {
      name: "parity",
      objective: "Exercise every mirrored key",
      blocks: [block],
      nodes: [node],
      node_defaults: { required: true, worker_config: { timeout_ms: 1000 }, report_to_parent: true },
      delivery_node: "build",
      max_concurrency: 2,
      max_node_replan_attempts: 2,
      max_total_nodes: 100,
      workspace: "/worktree",
      acceptance: [{ id: "AC1", text: "Every mirrored key round-trips" }],
      review_gate: "strict",
    }
    const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
    expect(() => decode({ params: { action: "spec", operation: "draft", config } })).not.toThrow()
    expect(() =>
      decode({ params: { action: "spec", operation: "draft", config: { ...config, unknown_field: true } } }),
    ).toThrow()
    expect(() =>
      decode({
        params: {
          action: "spec",
          operation: "draft",
          config: { ...config, nodes: [{ ...node, unknown_field: true }] },
        },
      }),
    ).toThrow()
    // The replan-only flags have no meaning in a start document, so the draft boundary rejects them.
    for (const flag of REPLAN_ONLY_NODE_FIELDS)
      expect(
        () =>
          decode({
            params: {
              action: "spec",
              operation: "draft",
              config: { ...config, nodes: [{ ...node, [flag]: true }] },
            },
          }),
        flag,
      ).toThrow()
  })
})
