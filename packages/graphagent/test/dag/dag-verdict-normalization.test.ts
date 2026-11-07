// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { unresolvedReviewOutcomes, validateReviewExecutionInput } from "@/dag/review-lifecycle"
import { Checkpoint } from "@/dag/runtime/checkpoint"
import { evaluateCondition } from "@/dag/runtime/eval"
import { DagVerdict } from "@/dag/runtime/verdict"

function node(id: string, extra: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...extra,
  }
}

const review = node("review", {
  worker_type: "review",
  depends_on: ["verify"],
  review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
  input_mapping: {
    diff: "implement.output.diff",
    fingerprint: "implement.output.fingerprint",
    verification: "verify.output",
  },
  condition: 'verify.output.verdict == "PASS"',
})

describe("shared verdict normalization", () => {
  it("parses JSON strings, including a single Markdown code fence", () => {
    expect(DagVerdict.normalizeOutput('{"verdict":"PASS"}')).toEqual({ verdict: "PASS" })
    expect(DagVerdict.normalizeOutput('```json\n{"verdict":"PASS"}\n```')).toEqual({ verdict: "PASS" })
    // The prompt sanitizer rewrites ``` to `` before review input checks.
    expect(DagVerdict.normalizeOutput('``json\n{"verdict":"PASS"}\n``')).toEqual({ verdict: "PASS" })
    expect(DagVerdict.normalizeOutput("plain prose")).toBe("plain prose")
    expect(DagVerdict.normalizeOutput("```\nnot json\n```")).toBe("```\nnot json\n```")
  })

  it("detects a replan verdict regardless of case or code fence", () => {
    expect(Checkpoint.isReplanVerdict({ verdict: "replan" })).toBe(true)
    expect(Checkpoint.isReplanVerdict({ verdict: "REPLAN", reason: "scope drift" })).toBe(true)
    expect(Checkpoint.isReplanVerdict('```json\n{"verdict":"Replan"}\n```')).toBe(true)
    expect(Checkpoint.isReplanVerdict({ verdict: "proceed" })).toBe(false)
    expect(Checkpoint.isReplanVerdict("replan")).toBe(false)
  })

  it("accepts the same JSON-string verification the review condition accepts", () => {
    const verification = '{"verdict":"PASS","summary":"green"}'
    const condition = evaluateCondition(review.condition, {
      verify: { output: DagVerdict.normalizeOutput(verification) },
    })
    expect(condition).toEqual({ ok: true, value: true })
    const input = validateReviewExecutionInput(review, {
      diff: "diff --git a/x b/x",
      fingerprint: "fp-1",
      verification,
    })
    expect(input.errors).toEqual([])
    expect(input.valid).toBe(true)
  })

  it("resolves a review accepted through a JSON-string output", () => {
    const config: WorkflowConfig = {
      name: "wf",
      nodes: [
        node("implement"),
        node("verify", { depends_on: ["implement"] }),
        review,
        node("finalize", {
          depends_on: ["review"],
          input_mapping: { review: "review.output" },
          condition: 'review.output.verdict == "ACCEPT"',
        }),
      ],
    }
    const rows = [
      { id: "implement", status: "completed", output: { diff: "d", fingerprint: "fp-1" } },
      { id: "verify", status: "completed", output: { verdict: "PASS" } },
      { id: "review", status: "completed", output: '{"verdict":"ACCEPT","implementation_fingerprint":"fp-1"}' },
      { id: "finalize", status: "completed", output: "done" },
    ]
    expect(unresolvedReviewOutcomes(config, rows)).toEqual([])
  })
})
