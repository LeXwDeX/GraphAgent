// Regression: the condition evaluator supports one comparison. `===`, `!==`,
// `&&` and `||` used to lex into a malformed operand and silently mis-route:
// `review.output.verdict !== "REJECT"` parsed as `!= '= "REJECT"'` and was
// ALWAYS true, so a REJECT verdict never stopped the gated dependent. They are
// now unevaluable at spawn (the loop fails the node) and rejected at
// create/replan validation.
import { describe, expect, test } from "bun:test"
import type { NodeConfig } from "../../src/dag/dag"
import { DagValidation } from "../../src/dag/validation"
import { conditionSyntaxError, evaluateCondition } from "../../src/dag/runtime/eval"

const node = (id: string, deps: string[], extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: "general",
  depends_on: deps,
  prompt_template: { inline: `Run ${id}` },
  ...extra,
})

const rejected = { gate: { output: { verdict: "REJECT", count: 1 } } }

const unsupported = [
  'gate.output.verdict !== "REJECT"',
  "gate.output.count === 1",
  'gate.output.count == 1 && gate.output.verdict == "ACCEPT"',
  'gate.output.verdict == "ACCEPT" || gate.output.count > 0',
  "gate.output.count == hello world",
]

describe("condition syntax", () => {
  test("unsupported operators are unevaluable instead of silently mis-routing", () => {
    for (const condition of unsupported) {
      const result = evaluateCondition(condition, rejected)
      expect(result.ok, condition).toBe(false)
      if (!result.ok) expect(result.error, condition).toContain("unsupported syntax")
    }
  })

  test("the supported grammar still evaluates", () => {
    expect(evaluateCondition('gate.output.verdict != "REJECT"', rejected)).toEqual({ ok: true, value: false })
    expect(evaluateCondition('gate.output.verdict == "REJECT"', rejected)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("gate.output.verdict == REJECT", rejected)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("gate.output.count >= 1", rejected)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("gate.output.count<1", rejected)).toEqual({ ok: true, value: false })
    expect(evaluateCondition('gate.output.verdict == "a && b"', rejected)).toEqual({ ok: true, value: false })
    expect(evaluateCondition("gate.output.missing == null", rejected)).toEqual({ ok: true, value: false })
    expect(conditionSyntaxError('gate.output.verdict == "ACCEPT"')).toBeUndefined()
    expect(conditionSyntaxError(undefined)).toBeUndefined()
  })

  test("structural validation rejects conditions the runtime cannot evaluate", () => {
    for (const condition of [...unsupported, "gate.output.verdict =="]) {
      const diagnostics = DagValidation.structuralDiagnostics({
        nodes: [node("gate", []), node("next", ["gate"], { condition })],
      })
      const errors = diagnostics.filter((d) => d.severity === "error")
      expect(
        errors.some((d) => d.code === "dag.invalid" && d.path === "nodes[next].condition"),
        condition,
      ).toBe(true)
    }
  })

  test("replan structural validation rejects them on (re)running fragment nodes", () => {
    const next = node("next", ["gate"], { condition: 'gate.output.verdict !== "REJECT"' })
    const diagnostics = DagValidation.replanStructuralDiagnostics({
      fragmentNodes: [next],
      rerunNodes: [next],
      existingNodeIds: new Set(["gate"]),
      existingNodeCount: 1,
      addCount: 1,
      merged: { nodes: [node("gate", []), next] },
      config: {},
    })
    expect(diagnostics.some((d) => d.severity === "error" && d.path === "nodes[next].condition")).toBe(true)
  })
})
