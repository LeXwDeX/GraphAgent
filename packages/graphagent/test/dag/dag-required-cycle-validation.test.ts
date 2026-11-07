// Regression: a dependency cycle among `required: true` nodes made the shared
// structural validator THROW (CycleError from validateRequiredNodes' addEdge)
// instead of returning a dag.invalid diagnostic, so validate/start/draft and
// Dag.create died with a defect rather than reporting structured diagnostics.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { NodeConfig } from "../../src/dag/dag"
import { DagValidation } from "../../src/dag/validation"
import { WorkflowAuthoring } from "../../src/dag/authoring"

const node = (id: string, deps: string[], extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: "general",
  depends_on: deps,
  prompt_template: { inline: `Run ${id}` },
  ...extra,
})

const cycle = () => [node("a", ["b"], { required: true }), node("b", ["a"], { required: true })]

describe("required-node cycle validation", () => {
  test("structuralDiagnostics reports the cycle instead of throwing", () => {
    let diagnostics: DagValidation.Diagnostic[] = []
    expect(() => {
      diagnostics = DagValidation.structuralDiagnostics({ nodes: cycle() })
    }).not.toThrow()
    const messages = diagnostics.filter((d) => d.code === "dag.invalid").map((d) => d.message)
    expect(messages).toContain("Required nodes form a cycle")
    expect(messages.some((message) => message.startsWith("Workflow config contains a dependency cycle"))).toBe(true)
  })

  test("a required self-dependency is a diagnostic too", () => {
    const diagnostics = DagValidation.structuralDiagnostics({ nodes: [node("a", ["a"], { required: true })] })
    expect(diagnostics.some((d) => d.code === "dag.invalid" && d.message.includes("cycle"))).toBe(true)
  })

  test("authoring returns an invalid result instead of dying", async () => {
    const exit = await Effect.runPromiseExit(
      WorkflowAuthoring.make().prepare({
        action: "start",
        source: { kind: "inline", value: { config: { name: "required-cycle", nodes: cycle() } } },
        profile: "portable",
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.valid).toBe(false)
  })
})
