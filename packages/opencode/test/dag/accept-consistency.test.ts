import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import { acceptConsistencyErrors } from "@/dag/review-lifecycle"
import { settleCapturedOutput } from "@/dag/runtime/capture"

const lane = (nodeID: string, required_actions: string[]) => ({
  nodeID,
  output: { verdict: required_actions.length > 0 ? "REJECT" : "ACCEPT", required_actions },
})

describe("acceptConsistencyErrors", () => {
  it("rejects an ACCEPT that still lists required actions", () => {
    expect(acceptConsistencyErrors({ verdict: "ACCEPT", required_actions: ["Fix X"] })).toEqual([
      "ACCEPT must not list required_actions (1 listed); submit REJECT instead",
    ])
  })

  it("names every lane action an ACCEPT leaves unrefuted", () => {
    const errors = acceptConsistencyErrors({ verdict: "ACCEPT", required_actions: [] }, [
      lane("review--standards", ["A", "B"]),
      lane("review--intent", ["C"]),
    ])
    expect(errors).toEqual([
      "ACCEPT leaves required actions unrefuted: review--standards[0], review--standards[1], review--intent[0]; refute each as { node, index, reason } or submit REJECT",
    ])
  })

  it("accepts when every lane action is refuted with a reason", () => {
    const output = {
      verdict: "ACCEPT",
      required_actions: [],
      refuted: [
        { node: "review--standards", index: 0, reason: "Already covered by src/a.test.ts:3" },
        { node: "review--intent", index: 0, reason: "Out of the confirmed scope" },
      ],
    }
    expect(
      acceptConsistencyErrors(output, [lane("review--standards", ["A"]), lane("review--intent", ["C"])]),
    ).toEqual([])
  })

  it("does not count a refutation without a reason, or one aimed at the wrong lane or index", () => {
    const output = {
      verdict: "ACCEPT",
      required_actions: [],
      refuted: [
        { node: "review--standards", index: 0, reason: " " },
        { node: "review--intent", index: 0, reason: "wrong lane" },
        { node: "review--standards", index: 1, reason: "wrong index" },
      ],
    }
    expect(acceptConsistencyErrors(output, [lane("review--standards", ["A"])])).toHaveLength(1)
  })

  it("reads JSON-string outputs and ignores free-text legacy evidence", () => {
    expect(
      acceptConsistencyErrors(JSON.stringify({ verdict: "ACCEPT", required_actions: [] }), [
        { nodeID: "legacy", output: "## Review\nREJECT: fix everything" },
        { nodeID: "json", output: JSON.stringify({ required_actions: ["A"] }) },
      ]),
    ).toEqual([
      "ACCEPT leaves required actions unrefuted: json[0]; refute each as { node, index, reason } or submit REJECT",
    ])
  })

  it.each(["REJECT", "REVISE", "BLOCKED", undefined])("leaves verdict %s unconstrained", (verdict) => {
    expect(acceptConsistencyErrors({ verdict, required_actions: ["A"] }, [lane("x", ["B"])])).toEqual([])
  })

  it("fails settlement with the consistency reason", () => {
    expect(settleCapturedOutput({ verdict: "ACCEPT", required_actions: ["A"] }, undefined, " (recovered)")).toEqual({
      kind: "fail",
      reason:
        "Verdict consistency contract failed (recovered): ACCEPT must not list required_actions (1 listed); submit REJECT instead",
    })
  })
})

describe("review block compilation", () => {
  const nodes = DagBlocks.compileWorkflowBlocks({
    objective: "Ship the change",
    blocks: [
      new DagBlocks.WorkflowBlock({ id: "code", kind: "coding" }),
      new DagBlocks.WorkflowBlock({ id: "gates", kind: "verify", depends_on: ["code"] }),
      new DagBlocks.WorkflowBlock({ id: "decision", kind: "review", depends_on: ["gates"] }),
      new DagBlocks.WorkflowBlock({ id: "design", kind: "review" }),
    ],
  })
  const byID = new Map(nodes.map((node) => [node.id, node]))

  it("gives both review lanes a structured verdict with blocking required_actions", () => {
    for (const id of ["decision--standards", "decision--intent", "design--standards", "design--intent"]) {
      expect(byID.get(id)?.output_schema).toMatchObject({
        required: ["verdict", "summary", "findings", "required_actions"],
        properties: { verdict: { enum: ["ACCEPT", "REJECT"] } },
      })
      expect(byID.get(id)?.prompt_template.inline).toContain("ACCEPT requires it to be empty")
    }
  })

  it("lets both decision shapes refute lane actions and states the rule", () => {
    for (const id of ["decision", "design"]) {
      expect(byID.get(id)?.output_schema).toMatchObject({
        properties: { refuted: { items: { required: ["node", "index", "reason"] } } },
      })
      expect(byID.get(id)?.prompt_template.inline).toContain("The runtime rejects an ACCEPT that does neither.")
    }
  })
})
