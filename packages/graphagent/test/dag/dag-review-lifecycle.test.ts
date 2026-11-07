import { describe, expect, it } from "bun:test"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import {
  reviewContractForNode,
  reviewEvidenceKeys,
  validateReviewExecutionInput,
  validateReviewLifecycle,
  validateReviewResult,
  unresolvedReviewOutcomes,
} from "@/dag/review-lifecycle"

function node(id: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: `Run ${id}` },
    ...overrides,
  }
}

function workflow(mode: "standard" | "deep", nodes: NodeConfig[]): WorkflowConfig {
  return { name: "review-lifecycle", mode, nodes }
}

describe("reviewEvidenceKeys", () => {
  it("returns artifact keys from the implementation node for a diff review", () => {
    const review = node("review-diff", {
      review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
      input_mapping: {
        diff: "implement.output.diff",
        implementation_fingerprint: "implement.output.fingerprint",
        verification: "verify.output",
      },
    })
    expect(reviewEvidenceKeys(review)).toEqual(["diff"])
  })

  it("returns nothing for design reviews and plain nodes", () => {
    expect(reviewEvidenceKeys(node("plain"))).toEqual([])
    expect(
      reviewEvidenceKeys(node("review-design", { review: { phase: "design" } as never })),
    ).toEqual([])
  })

  it("ignores artifact-shaped fields from other nodes", () => {
    const review = node("review-diff", {
      review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
      input_mapping: { diff: "other.output.diff", patch: "implement.output.patch" },
    })
    expect(reviewEvidenceKeys(review)).toEqual(["patch"])
  })
})

function validDiffFlow() {
  return [
    node("implement", {
      output_schema: {
        type: "object",
        properties: {
          diff: { type: "string" },
          fingerprint: { type: "string" },
        },
        required: ["diff", "fingerprint"],
      },
    }),
    node("verify", {
      depends_on: ["implement"],
      output_schema: {
        type: "object",
        properties: { verdict: { enum: ["PASS", "FAIL"] } },
        required: ["verdict"],
      },
    }),
    node("review-diff", {
      worker_type: "review",
      depends_on: ["verify"],
      review: {
        phase: "diff",
        implementation_node_id: "implement",
        verification_node_id: "verify",
      },
      input_mapping: {
        diff: "implement.output.diff",
        implementation_fingerprint: "implement.output.fingerprint",
        verification: "verify.output",
      },
      condition: 'verify.output.verdict == "PASS"',
      output_schema: {
        type: "object",
        properties: {
          verdict: { enum: ["ACCEPT", "REJECT"] },
          implementation_fingerprint: { type: "string" },
        },
        required: ["verdict", "implementation_fingerprint"],
      },
    }),
    node("final-audit", {
      worker_type: "audit",
      depends_on: ["review-diff"],
      input_mapping: { review: "review-diff.output" },
      condition: 'review-diff.output.verdict == "ACCEPT"',
    }),
  ]
}

describe("DAG review lifecycle", () => {
  it("accepts a pre-implementation design review in a deep workflow", () => {
    const result = validateReviewLifecycle(workflow("deep", [
      node("spec", { worker_type: "plan" }),
      node("review-design", {
        worker_type: "review",
        depends_on: ["spec"],
        review: { phase: "design" },
      }),
      node("implement", { depends_on: ["review-design"] }),
    ]))

    expect(result).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it("rejects an unclassified review in a deep workflow", () => {
    const result = validateReviewLifecycle(workflow("deep", [
      node("explore", { worker_type: "explore" }),
      node("review-security", {
        worker_type: "review",
        depends_on: ["explore"],
      }),
    ]))

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      'review-security: deep review worker must declare review.phase as "design" or "diff"',
    ])
  })

  it("preserves an unclassified legacy review in a standard workflow", () => {
    expect(validateReviewLifecycle(workflow("standard", [
      node("review-legacy", { worker_type: "review" }),
    ]))).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it("accepts implementation to verification PASS to diff review to final audit", () => {
    expect(validateReviewLifecycle(workflow("deep", validDiffFlow()))).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    })
  })

  it("rejects a deep diff review without a downstream final ACCEPT gate", () => {
    const nodes = validDiffFlow().filter((item) => item.id !== "final-audit")
    expect(validateReviewLifecycle(workflow("deep", nodes))).toEqual({
      valid: false,
      errors: [
        "review-diff: deep diff review must feed a required final gate conditioned on verdict ACCEPT",
      ],
      warnings: [],
    })
  })

  it("validates explicit diff-review metadata even on a non-review worker", () => {
    const nodes = validDiffFlow().filter((item) => item.id !== "final-audit")
    const review = nodes[2]
    if (!review) throw new Error("fixture is incomplete")
    review.worker_type = "general"
    expect(validateReviewLifecycle(workflow("deep", nodes))).toEqual({
      valid: false,
      errors: [
        "review-diff: deep diff review must feed a required final gate conditioned on verdict ACCEPT",
      ],
      warnings: [],
    })
  })

  it("rejects a final gate that mentions ACCEPT but runs only for REJECT", () => {
    const nodes = validDiffFlow()
    const gate = nodes[3]
    if (!gate) throw new Error("fixture is incomplete")
    gate.condition = 'review-diff.output.verdict != "ACCEPT"'
    expect(validateReviewLifecycle(workflow("deep", nodes))).toEqual({
      valid: false,
      errors: [
        "review-diff: deep diff review must feed a required final gate conditioned on verdict ACCEPT",
      ],
      warnings: [],
    })
  })

  it("reports every missing diff-review evidence edge and mapping", () => {
    const nodes = validDiffFlow()
    const review = nodes[2]
    if (!review) throw new Error("fixture is incomplete")
    review.depends_on = []
    review.input_mapping = {
      plan: "implement.output",
    }
    review.condition = 'verify.output.verdict == "FAIL"'

    const result = validateReviewLifecycle(workflow("deep", nodes))
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      "review-diff: diff review must depend transitively on verification node verify",
      "review-diff: input_mapping must map an actual diff or changed-file artifact from implement",
      "review-diff: input_mapping must map implementation fingerprint from implement",
      "review-diff: input_mapping must map verification output from verify",
      "review-diff: condition must require PASS from verification node verify",
    ])
  })

  it("requires a mapped implementation fingerprint and bound review result schema", () => {
    const nodes = validDiffFlow()
    const review = nodes[2]
    if (!review) throw new Error("fixture is incomplete")
    review.input_mapping = {
      diff: "implement.output.diff",
      verification: "verify.output",
    }
    review.output_schema = {
      type: "object",
      properties: {
        verdict: { enum: ["ACCEPT", "REJECT"] },
      },
      required: ["verdict"],
    }

    expect(validateReviewLifecycle(workflow("deep", nodes)).errors).toEqual([
      "review-diff: input_mapping must map implementation fingerprint from implement",
      "review-diff: output_schema must require verdict and implementation_fingerprint",
    ])
  })

  it("rejects missing and reversed implementation verification dependencies", () => {
    const missing = validDiffFlow()
    const verify = missing[1]
    if (!verify) throw new Error("fixture is incomplete")
    verify.depends_on = []
    expect(validateReviewLifecycle(workflow("deep", missing)).errors).toEqual([
      "review-diff: verification node verify must depend transitively on implementation node implement",
    ])

    const absent = validDiffFlow()
    const review = absent[2]
    if (!review?.review) throw new Error("fixture is incomplete")
    review.review.implementation_node_id = "missing-implementation"
    review.review.verification_node_id = "missing-verification"
    expect(validateReviewLifecycle(workflow("deep", absent)).errors).toEqual([
      "review-diff: implementation node missing-implementation does not exist",
      "review-diff: verification node missing-verification does not exist",
    ])
  })

  it("warns rather than rejects explicit invalid diff metadata in standard mode", () => {
    const result = validateReviewLifecycle(workflow("standard", [
      node("review-standard", {
        worker_type: "review",
        review: {
          phase: "diff",
          implementation_node_id: "implement",
          verification_node_id: "verify",
        },
      }),
    ]))

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [
        "review-standard: implementation node implement does not exist",
        "review-standard: verification node verify does not exist",
      ],
    })
  })

  it("accepts actual diff evidence only after verification PASS", () => {
    const review = validDiffFlow()[2]
    if (!review) throw new Error("fixture is incomplete")
    expect(validateReviewExecutionInput(review, {
      diff: "diff --git a/file.ts b/file.ts\n+added",
      implementation_fingerprint: "sha256:implementation-1",
      verification: { verdict: "PASS", tests: 42 },
    })).toEqual({
      valid: true,
      phase: "diff",
      satisfies_diff_gate: true,
      errors: [],
    })
  })

  it("blocks failed verification and missing diff before execution", () => {
    const review = validDiffFlow()[2]
    if (!review) throw new Error("fixture is incomplete")
    expect(validateReviewExecutionInput(review, {
      diff: "",
      implementation_fingerprint: "sha256:implementation-1",
      verification: { verdict: "FAIL" },
    })).toEqual({
      valid: false,
      phase: "diff",
      satisfies_diff_gate: false,
      errors: [
        "review-diff: implementation evidence is empty or unresolved",
        "review-diff: verification evidence must contain verdict PASS",
      ],
    })
    expect(validateReviewExecutionInput(review, {
      diff: "{{implementation-diff}}",
      verification: { verdict: "PASS" },
    }).errors).toEqual([
      "review-diff: implementation evidence is empty or unresolved",
      "review-diff: implementation fingerprint is empty or unresolved",
    ])
  })

  it("keeps design review out of diff gates and emits a phase-specific contract", () => {
    const design = node("review-design", {
      worker_type: "review",
      review: { phase: "design" },
    })
    expect(validateReviewExecutionInput(design, {
      diff: "diff --git a/file.ts b/file.ts",
      verification: { verdict: "PASS" },
    })).toEqual({
      valid: true,
      phase: "design",
      satisfies_diff_gate: false,
      errors: [],
    })
    expect(reviewContractForNode(design)).toContain("design/specification review")
    expect(reviewContractForNode(design)).toContain("MUST NOT claim")
  })

  it("binds ACCEPT and REJECT results to the current implementation fingerprint", () => {
    expect(validateReviewResult({
      verdict: "ACCEPT",
      implementation_fingerprint: "sha256:revision-2",
    }, "sha256:revision-2")).toEqual({
      valid: true,
      action: "proceed",
      reviewed_fingerprint: "sha256:revision-2",
      errors: [],
    })
    expect(validateReviewResult({
      verdict: "REJECT",
      implementation_fingerprint: "sha256:revision-2",
      findings: ["Missing timeout test"],
    }, "sha256:revision-2")).toEqual({
      valid: true,
      action: "correct",
      reviewed_fingerprint: "sha256:revision-2",
      errors: [],
    })
    expect(validateReviewResult({
      verdict: "ACCEPT",
      implementation_fingerprint: "sha256:revision-1",
    }, "sha256:revision-2")).toEqual({
      valid: false,
      action: "invalidate",
      reviewed_fingerprint: "sha256:revision-1",
      errors: [
        "review result fingerprint sha256:revision-1 does not match current implementation sha256:revision-2",
      ],
    })
  })

  it("accepts fingerprints that match after trimming surrounding whitespace (issue #410)", () => {
    expect(validateReviewResult({
      verdict: "ACCEPT",
      implementation_fingerprint: "\n  sha256:revision-2\n",
    }, "sha256:revision-2")).toEqual({
      valid: true,
      action: "proceed",
      reviewed_fingerprint: "\n  sha256:revision-2\n",
      errors: [],
    })
    expect(validateReviewResult({
      verdict: "ACCEPT",
      implementation_fingerprint: "sha256:revision-2",
    }, "\n  sha256:revision-2\n")).toEqual({
      valid: true,
      action: "proceed",
      reviewed_fingerprint: "sha256:revision-2",
      errors: [],
    })
    expect(validateReviewResult({
      verdict: "ACCEPT",
      implementation_fingerprint: "sha256:revision 2",
    }, "sha256:revision-2")).toEqual({
      valid: false,
      action: "invalidate",
      reviewed_fingerprint: "sha256:revision 2",
      errors: [
        "review result fingerprint sha256:revision 2 does not match current implementation sha256:revision-2",
      ],
    })
  })

  it("keeps a deep workflow from succeeding with an unresolved review outcome", () => {
    const rejected = workflow("deep", validDiffFlow())
    expect(unresolvedReviewOutcomes(rejected, [
      {
        id: "review-diff",
        status: "completed",
        output: { verdict: "REJECT", implementation_fingerprint: "sha256:revision-1" },
      },
    ])).toEqual(["review-diff"])
    expect(unresolvedReviewOutcomes(rejected, [
      { id: "review-diff", status: "skipped", output: undefined },
      { id: "final-audit", status: "skipped", output: undefined },
    ])).toEqual(["review-diff"])
    expect(unresolvedReviewOutcomes(rejected, [
      {
        id: "review-diff",
        status: "completed",
        output: { verdict: "ACCEPT", implementation_fingerprint: "sha256:revision-1" },
      },
      { id: "final-audit", status: "skipped", output: undefined },
    ])).toEqual(["review-diff"])

    const corrected = [
      ...rejected.nodes,
      node("implement-fix", {
        depends_on: ["review-diff"],
        condition: 'review-diff.output.verdict == "REJECT"',
      }),
      node("verify-fix", { depends_on: ["implement-fix"] }),
      node("review-diff-2", {
        worker_type: "review",
        depends_on: ["verify-fix"],
        review: {
          phase: "diff",
          implementation_node_id: "implement-fix",
          verification_node_id: "verify-fix",
        },
      }),
      node("final-audit-2", {
        worker_type: "audit",
        depends_on: ["review-diff-2"],
        input_mapping: { review: "review-diff-2.output" },
        condition: 'review-diff-2.output.verdict == "ACCEPT"',
      }),
    ]
    expect(unresolvedReviewOutcomes(workflow("deep", corrected), [
      {
        id: "review-diff",
        status: "completed",
        output: { verdict: "REJECT", implementation_fingerprint: "sha256:revision-1" },
      },
      {
        id: "review-diff-2",
        status: "completed",
        output: { verdict: "ACCEPT", implementation_fingerprint: "sha256:revision-2" },
      },
      { id: "final-audit-2", status: "completed", output: "audited" },
    ])).toEqual([])
    expect(unresolvedReviewOutcomes(workflow("deep", corrected), [
      {
        id: "review-diff",
        status: "completed",
        output: { verdict: "ACCEPT", implementation_fingerprint: "sha256:revision-1" },
      },
      { id: "final-audit", status: "completed", output: "audited" },
      { id: "review-diff-2", status: "skipped", output: undefined },
      { id: "final-audit-2", status: "skipped", output: undefined },
    ])).toEqual([])
    expect(unresolvedReviewOutcomes(workflow("deep", corrected), [
      {
        id: "review-diff",
        status: "completed",
        output: { verdict: "ACCEPT", implementation_fingerprint: "sha256:revision-1" },
      },
      { id: "final-audit", status: "completed", output: "audited" },
      {
        id: "review-diff-2",
        status: "completed",
        output: { verdict: "REJECT", implementation_fingerprint: "sha256:revision-2" },
      },
      { id: "final-audit-2", status: "skipped", output: undefined },
    ])).toEqual(["review-diff-2"])
  })

  it("accepts a rejected-review correction wave only after reimplementation and verification", () => {
    const first = validDiffFlow()
    const correction = [
      node("implement-fix", {
        depends_on: ["review-diff"],
        condition: 'review-diff.output.verdict == "REJECT"',
        output_schema: {
          type: "object",
          properties: {
            diff: { type: "string" },
            fingerprint: { type: "string" },
          },
          required: ["diff", "fingerprint"],
        },
      }),
      node("verify-fix", {
        depends_on: ["implement-fix"],
        output_schema: {
          type: "object",
          properties: { verdict: { enum: ["PASS", "FAIL"] } },
          required: ["verdict"],
        },
      }),
      node("review-diff-2", {
        worker_type: "review",
        depends_on: ["verify-fix"],
        review: {
          phase: "diff",
          implementation_node_id: "implement-fix",
          verification_node_id: "verify-fix",
        },
        input_mapping: {
          diff: "implement-fix.output.diff",
          implementation_fingerprint: "implement-fix.output.fingerprint",
          verification: "verify-fix.output",
        },
        condition: 'verify-fix.output.verdict == "PASS"',
        output_schema: {
          type: "object",
          properties: {
            verdict: { enum: ["ACCEPT", "REJECT"] },
            implementation_fingerprint: { type: "string" },
          },
          required: ["verdict", "implementation_fingerprint"],
        },
      }),
      node("final-audit-2", {
        worker_type: "audit",
        depends_on: ["review-diff-2"],
        input_mapping: { review: "review-diff-2.output" },
        condition: 'review-diff-2.output.verdict == "ACCEPT"',
      }),
    ]

    expect(validateReviewLifecycle(workflow("deep", [...first, ...correction]))).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    })
  })
})
