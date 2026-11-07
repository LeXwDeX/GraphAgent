import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"

describe("parallel workspace writers (issue #293)", () => {
  const parallelRoute = [
    { id: "plan", kind: "plan" },
    { id: "slice-a", kind: "coding", depends_on: ["plan"] },
    { id: "slice-b", kind: "coding", depends_on: ["plan"] },
    { id: "slice-c", kind: "coding", depends_on: ["plan"] },
    { id: "gates", kind: "verify", depends_on: ["slice-a", "slice-b", "slice-c"] },
    { id: "decision", kind: "review", depends_on: ["gates"] },
  ] as const

  it("keeps unordered writers parallel and injects one aggregation node", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver three disjoint slices",
      blocks: [...parallelRoute],
    })
    const byID = new Map(nodes.map((node) => [node.id, node]))

    expect(byID.get("slice-a")?.depends_on).toEqual(["plan"])
    expect(byID.get("slice-b")?.depends_on).toEqual(["plan"])
    expect(byID.get("slice-c")?.depends_on).toEqual(["plan"])

    const aggregate = byID.get("decision--aggregate")
    expect(aggregate).toMatchObject({
      worker_type: "explore",
      required: true,
      report_to_parent: false,
      depends_on: ["slice-a", "slice-b", "slice-c"],
    })
    expect(aggregate?.output_schema).toEqual(
      expect.objectContaining({ required: expect.arrayContaining(["changed_files", "fingerprint"]) }),
    )
    expect(aggregate?.input_mapping).toEqual({
      slice_a_changed_files: "slice-a.output.changed_files",
      slice_a_summary: "slice-a.output.summary",
      slice_b_changed_files: "slice-b.output.changed_files",
      slice_b_summary: "slice-b.output.summary",
      slice_c_changed_files: "slice-c.output.changed_files",
      slice_c_summary: "slice-c.output.summary",
    })
    // #347: the contract must make the worker reconcile the declared
    // write-sets against the workspace's actual git status — undeclared
    // edits fail loudly instead of escaping the union+fingerprint binding,
    // and the fingerprint covers the actually-changed set.
    expect(aggregate?.prompt_template.inline).toContain("overlapping paths")
    expect(aggregate?.prompt_template.inline).toContain("git status --porcelain")
    expect(aggregate?.prompt_template.inline).toContain("undeclared paths")

    expect(byID.get("gates")?.depends_on).toEqual(["decision--aggregate"])
    const decision = byID.get("decision")
    expect(decision?.review).toEqual({
      phase: "diff",
      implementation_node_id: "decision--aggregate",
      verification_node_id: "gates",
    })
    expect(decision?.input_mapping).toMatchObject({
      implementation_changed_files: "decision--aggregate.output.changed_files",
      implementation_fingerprint: "decision--aggregate.output.fingerprint",
      verification: "gates.output",
    })
  })

  it("aggregates a partially ordered writer set without losing any writer", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver a partially ordered change",
      blocks: [
        { id: "inner", kind: "coding" },
        { id: "outer", kind: "coding", depends_on: ["inner"] },
        { id: "side", kind: "coding" },
        { id: "gates", kind: "verify", depends_on: ["outer", "side"] },
        { id: "decision", kind: "review", depends_on: ["gates"] },
      ],
    })
    const byID = new Map(nodes.map((node) => [node.id, node]))

    expect(byID.get("outer")?.depends_on).toEqual(["inner"])
    expect(byID.get("decision--aggregate")?.depends_on).toEqual(["inner", "outer", "side"])
    expect(byID.get("gates")?.depends_on).toEqual(["decision--aggregate"])
  })

  it("keeps total-ordered writer chains byte-identical without an aggregator", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver a chained change",
      blocks: [
        { id: "first", kind: "coding" },
        { id: "second", kind: "coding", depends_on: ["first"] },
        { id: "gates", kind: "verify", depends_on: ["second"] },
        { id: "decision", kind: "review", depends_on: ["gates"] },
      ],
    })
    const byID = new Map(nodes.map((node) => [node.id, node]))

    expect(nodes.some((node) => node.id.endsWith("--aggregate"))).toBe(false)
    expect(byID.get("gates")?.depends_on).toEqual(["second"])
    expect(byID.get("gates")?.input_mapping).toBeUndefined()
    const decision = byID.get("decision")
    expect(decision?.review).toEqual({
      phase: "diff",
      implementation_node_id: "second",
      verification_node_id: "gates",
    })
    expect(decision?.input_mapping).toMatchObject({
      implementation_changed_files: "second.output.changed_files",
      implementation_fingerprint: "second.output.fingerprint",
    })
  })

  it("rewires verify onto the aggregator while preserving non-writer dependencies", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver with prior evidence",
      blocks: [
        { id: "map", kind: "explore" },
        { id: "slice-a", kind: "coding" },
        { id: "slice-b", kind: "coding" },
        { id: "gates", kind: "verify", depends_on: ["map", "slice-a", "slice-b"] },
        { id: "decision", kind: "review", depends_on: ["gates"] },
      ],
    })
    const gates = nodes.find((node) => node.id === "gates")
    expect(gates?.depends_on).toEqual(["map", "decision--aggregate"])
  })

  it("binds the implementation fingerprint into the rewired verify node", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver three disjoint slices",
      blocks: [...parallelRoute],
    })
    expect(nodes.find((node) => node.id === "gates")?.input_mapping).toEqual({
      implementation_changed_files: "decision--aggregate.output.changed_files",
      implementation_fingerprint: "decision--aggregate.output.fingerprint",
    })
  })

  it("rejects an author block that collides with an aggregator id", () => {
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Colliding aggregator id",
        blocks: [
          { id: "slice-a", kind: "coding" },
          { id: "slice-b", kind: "coding" },
          { id: "decision--aggregate", kind: "verify" },
          { id: "gates", kind: "verify", depends_on: ["slice-a", "slice-b"] },
          { id: "decision", kind: "review", depends_on: ["gates"] },
        ],
      }),
    ).toThrow("duplicate node ids: decision--aggregate")
  })
})
