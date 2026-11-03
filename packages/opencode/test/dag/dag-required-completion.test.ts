import { describe, expect, it } from "bun:test"
import { type WorkflowConfig, requiredCompletionGaps } from "@/dag/dag"
import { failingGateVerdict } from "@/dag/runtime/verdict"

const gateNode = {
  id: "gate",
  name: "gate",
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: "gate" },
}

function config(nodes: WorkflowConfig["nodes"]): WorkflowConfig {
  return { name: "completion-gate", nodes }
}

function row(id: string, status: string, output?: unknown, errorReason: string | null = null) {
  return { id, status, required: true, output, errorReason }
}

describe("failingGateVerdict", () => {
  it("recognizes structured failing gate verdicts", () => {
    expect(failingGateVerdict({ verdict: "FAIL" })).toBe("FAIL")
    expect(failingGateVerdict({ verdict: "blocking" })).toBe("BLOCKING")
    expect(failingGateVerdict({ verdict: "BLOCKED" })).toBe("BLOCKED")
    expect(failingGateVerdict({ verdict: "incomplete" })).toBe("INCOMPLETE")
    expect(failingGateVerdict('{"verdict":"FAIL"}')).toBe("FAIL")
  })

  it("does not reinterpret ordinary scalar task data as a verdict", () => {
    expect(failingGateVerdict("FAIL")).toBeUndefined()
    expect(failingGateVerdict("BLOCKED")).toBeUndefined()
    expect(failingGateVerdict("PASS")).toBeUndefined()
    expect(failingGateVerdict("Status: incomplete; replan required")).toBeUndefined()
    // An explicit gate contract opts scalar verdicts in.
    expect(failingGateVerdict("FAIL", { allowScalar: true })).toBe("FAIL")
  })

  it("never parses a string-declared output as structured verdict data", () => {
    expect(failingGateVerdict('{"verdict":"FAIL"}', { parseString: false })).toBeUndefined()
    expect(failingGateVerdict('{"verdict":"FAIL"}', { parseString: false, allowScalar: true })).toBeUndefined()
  })

  it("does not fail ACCEPT/REJECT/PASS objects", () => {
    expect(failingGateVerdict({ verdict: "ACCEPT" })).toBeUndefined()
    expect(failingGateVerdict({ verdict: "REJECT" })).toBeUndefined()
    expect(failingGateVerdict({ verdict: "PASS" })).toBeUndefined()
  })
})

describe("requiredCompletionGaps", () => {
  const gated = config([
    gateNode,
    {
      ...gateNode,
      id: "branch",
      depends_on: ["gate"],
      condition: 'gate.output.verdict == "ACCEPT"',
      skip_ok: false,
    },
  ])

  it("reports a required condition_false skip when skip_ok is false", () => {
    expect(requiredCompletionGaps(gated, [row("branch", "skipped", undefined, "condition_false")])).toEqual([
      "branch (skipped: condition_false)",
    ])
  })

  it("accepts an explicitly accepted skip", () => {
    const accepted = config([{ ...gated.nodes[1], skip_ok: true }])
    expect(requiredCompletionGaps(accepted, [row("branch", "skipped", undefined, "condition_false")])).toEqual([])
  })

  it("keeps historical definitions without skip_ok on the accepted-skip path", () => {
    const historical = config([{ ...gated.nodes[1], skip_ok: undefined }])
    expect(requiredCompletionGaps(historical, [row("branch", "skipped", undefined, "condition_false")])).toEqual([])
    expect(
      requiredCompletionGaps(historical, [row("branch", "skipped", undefined, "condition_false")], "strict"),
    ).toEqual(["branch (skipped: condition_false)"])
  })

  it("strict completion reports pending, running, and failed required nodes", () => {
    expect(requiredCompletionGaps(gated, [row("gate", "pending")], "strict")).toEqual(["gate (pending)"])
    expect(requiredCompletionGaps(gated, [row("gate", "running")], "strict")).toEqual(["gate (running)"])
    expect(requiredCompletionGaps(gated, [row("gate", "failed")], "strict")).toEqual(["gate (failed)"])
  })

  it("strict completion accepts only an explicit skip", () => {
    expect(
      requiredCompletionGaps(gated, [row("branch", "skipped", undefined, "condition_false")], "strict"),
    ).toEqual(["branch (skipped: condition_false)"])
    const accepted = config([{ ...gated.nodes[1], skip_ok: true }])
    expect(
      requiredCompletionGaps(accepted, [row("branch", "skipped", undefined, "condition_false")], "strict"),
    ).toEqual([])
    // Opting a skip in does not excuse a failed execution.
    expect(requiredCompletionGaps(accepted, [row("branch", "failed")], "strict")).toEqual(["branch (failed)"])
    expect(requiredCompletionGaps(accepted, [row("branch", "running")], "strict")).toEqual(["branch (running)"])
  })

  it("reports failing verdicts on completed required non-review gate nodes", () => {
    expect(requiredCompletionGaps(config([gateNode]), [row("gate", "completed", { verdict: "FAIL" })])).toEqual([
      "gate (verdict FAIL)",
    ])
  })

  it("reports a completed required node whose target changed as a gap", () => {
    const stale = { ...row("gate", "completed", { verdict: "PASS" }), staleTarget: true }
    expect(requiredCompletionGaps(config([gateNode]), [stale])).toEqual(["gate (stale target)"])
    expect(
      requiredCompletionGaps(config([gateNode]), [
        { ...row("gate", "completed", { verdict: "PASS" }), staleTarget: false },
      ]),
    ).toEqual([])
    // A non-required stale node never gates completion.
    expect(
      requiredCompletionGaps(config([{ ...gateNode, required: false }]), [
        { ...row("gate", "completed", { verdict: "PASS" }), required: false, staleTarget: true },
      ]),
    ).toEqual([])
  })

  it("keeps legacy diff review REJECT decisions out of the verdict gate", () => {
    const review = config([
      {
        ...gateNode,
        review: { phase: "diff" as const, implementation_node_id: "impl", verification_node_id: "verify" },
      },
    ])
    expect(requiredCompletionGaps(review, [row("gate", "completed", { verdict: "REJECT" })])).toEqual([])
    expect(requiredCompletionGaps(review, [row("gate", "completed", { verdict: "BLOCKED" })])).toEqual([
      "gate (verdict BLOCKED)",
    ])
  })

  it("fails schema-valid design review verdicts and treats a scalar verdict contract explicitly", () => {
    const review = config([
      {
        ...gateNode,
        review: { phase: "design" as const },
      },
    ])
    expect(requiredCompletionGaps(review, [row("gate", "completed", { verdict: "FAIL" })])).toEqual([
      "gate (verdict FAIL)",
    ])
    expect(requiredCompletionGaps(review, [row("gate", "completed", { verdict: "INCOMPLETE" })])).toEqual([
      "gate (verdict INCOMPLETE)",
    ])
  })

  it("requires a structured verdict or an explicit verdict contract for scalar output", () => {
    const ordinary = config([{ ...gateNode, output_schema: { type: "string" } }])
    expect(requiredCompletionGaps(ordinary, [row("gate", "completed", "FAIL")])).toEqual([])
    expect(requiredCompletionGaps(ordinary, [row("gate", "completed", '{"verdict":"FAIL"}')])).toEqual([])
    const contract = config([
      {
        ...gateNode,
        output_schema: { type: "object", properties: { verdict: { type: "string" } } },
      },
    ])
    expect(requiredCompletionGaps(contract, [row("gate", "completed", "FAIL")])).toEqual(["gate (verdict FAIL)"])
    const structured = config([gateNode])
    expect(requiredCompletionGaps(structured, [row("gate", "completed", { verdict: "FAIL" })])).toEqual([
      "gate (verdict FAIL)",
    ])
  })

  it("ignores optional nodes and passing verdicts", () => {
    expect(
      requiredCompletionGaps(config([gateNode]), [
        { id: "gate", status: "completed", required: true, output: { verdict: "PASS" }, errorReason: null },
        { id: "optional", status: "skipped", required: false, output: undefined, errorReason: "condition_false" },
      ]),
    ).toEqual([])
  })
})
