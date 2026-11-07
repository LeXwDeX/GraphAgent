// Regressions for the deep-mode review-lifecycle authoring check.
// 1. The final-gate check read `node.required` raw, ignoring
//    `node_defaults.required`, so a valid deep graph whose final gate inherits
//    `required: true` from node_defaults was rejected by authoring (Dag.create,
//    which normalizes defaults first, accepts the same graph).
// 2. The diff-review PASS-gate check was a substring test, so an inverted gate
//    `verify.output.verdict != "PASS"` was accepted in deep mode: the review
//    would be skipped exactly when verification passes. It is now evaluated.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkflowAuthoring } from "../../src/dag/authoring"

const n = (id: string, deps: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: deps,
  prompt_template: { inline: `Run ${id}` },
  ...extra,
})

function diffFlow(options: { explicitRequired: boolean; reviewCondition: string }) {
  const required = options.explicitRequired ? { required: true } : {}
  return [
    n("implement", [], {
      ...required,
      output_schema: {
        type: "object",
        properties: { diff: { type: "string" }, fingerprint: { type: "string" } },
        required: ["diff", "fingerprint"],
      },
    }),
    n("verify", ["implement"], {
      ...required,
      output_schema: { type: "object", properties: { verdict: { enum: ["PASS", "FAIL"] } }, required: ["verdict"] },
    }),
    n("review-diff", ["verify"], {
      ...required,
      worker_type: "review",
      review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
      input_mapping: {
        diff: "implement.output.diff",
        implementation_fingerprint: "implement.output.fingerprint",
        verification: "verify.output",
      },
      condition: options.reviewCondition,
      output_schema: {
        type: "object",
        properties: { verdict: { enum: ["ACCEPT", "REJECT"] }, implementation_fingerprint: { type: "string" } },
        required: ["verdict", "implementation_fingerprint"],
      },
    }),
    n("final-audit", ["review-diff"], {
      ...required,
      worker_type: "audit",
      input_mapping: { review: "review-diff.output" },
      condition: 'review-diff.output.verdict == "ACCEPT"',
      prompt_template: { inline: "Audit {{review}}" },
    }),
  ]
}

function prepareDeep(nodes: unknown[], nodeDefaults?: Record<string, unknown>) {
  return Effect.runPromise(
    WorkflowAuthoring.make().prepare({
      action: "start",
      source: {
        kind: "inline",
        value: {
          mode: "deep",
          config: { name: "deep-review", ...(nodeDefaults ? { node_defaults: nodeDefaults } : {}), nodes },
        },
      },
      profile: "portable",
    }),
  )
}

describe("deep review lifecycle authoring", () => {
  test("control: explicit required: true on every node is valid", async () => {
    const result = await prepareDeep(
      diffFlow({ explicitRequired: true, reviewCondition: 'verify.output.verdict == "PASS"' }),
      { required: true },
    )
    expect(result.errors).toEqual([])
  })

  test("final gate inheriting required from node_defaults is accepted", async () => {
    const result = await prepareDeep(
      diffFlow({ explicitRequired: false, reviewCondition: 'verify.output.verdict == "PASS"' }),
      { required: true },
    )
    expect(result.errors.map((d) => d.message)).toEqual([])
  })

  test("an inverted or non-PASS gate on the diff review is rejected", async () => {
    for (const reviewCondition of ['verify.output.verdict != "PASS"', 'verify.output.verdict != "FAIL"']) {
      const result = await prepareDeep(diffFlow({ explicitRequired: true, reviewCondition }))
      expect(result.valid, reviewCondition).toBe(false)
      expect(
        result.errors.some((d) => d.message.includes("condition must require PASS from verification node verify")),
        reviewCondition,
      ).toBe(true)
    }
  })

  test("an unquoted PASS gate is still accepted", async () => {
    const result = await prepareDeep(
      diffFlow({ explicitRequired: true, reviewCondition: "verify.output.verdict == PASS" }),
    )
    expect(result.errors).toEqual([])
  })
})
