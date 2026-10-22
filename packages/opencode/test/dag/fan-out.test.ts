// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- block and row fixtures use `as never` shims.
import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import type { NodeConfig } from "@/dag/dag"
import { DagFanOut } from "@/dag/fan-out"
import { DagValidation } from "@/dag/validation"
import { planRecovery } from "@/dag/recovery-plan"

const route = [
  { id: "plan", kind: "plan" },
  { id: "slices", kind: "coding", depends_on: ["plan"], fan_out: "plan" },
  { id: "gates", kind: "verify", depends_on: ["slices"] },
  { id: "decision", kind: "review", depends_on: ["gates"] },
] as const

function compile(blocks: readonly Record<string, unknown>[]) {
  return DagBlocks.compileWorkflowBlocks({
    objective: "Deliver the planned change",
    blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block as never)),
  })
}

function writer(): NodeConfig {
  return compile([...route]).find((node) => node.id === "slices")!
}

const pkg = (id: string, write_set: string[]) => ({ id, instruction: `Implement ${id}`, write_set })

describe("fan_out block compilation", () => {
  it("gives the plan a work-package schema and marks the writer", () => {
    const byID = new Map(compile([...route]).map((node) => [node.id, node]))
    const plan = byID.get("plan")!
    expect(plan.output_schema).toMatchObject({ required: ["summary", "packages"] })
    expect(plan.prompt_template.inline).toContain("triple-disjoint")
    expect(byID.get("slices")).toMatchObject({ fan_out: "plan", depends_on: ["plan"] })
    // The canonical single-writer route is unchanged: downstream binds the
    // writer id, which the runtime later reuses for the aggregator.
    expect(byID.get("decision")?.review).toEqual({
      phase: "diff",
      implementation_node_id: "slices",
      verification_node_id: "gates",
    })
  })

  it("leaves plans without a fan-out writer schema-free", () => {
    const plan = compile([{ id: "plan", kind: "plan" }]).find((node) => node.id === "plan")!
    expect(plan.output_schema).toBeUndefined()
  })

  it.each([
    [
      "a non-coding block",
      [{ id: "plan", kind: "plan" }, { id: "x", kind: "explore", depends_on: ["plan"], fan_out: "plan" }],
      "only coding blocks",
    ],
    [
      "a non-plan source",
      [{ id: "map", kind: "explore" }, { id: "x", kind: "coding", depends_on: ["map"], fan_out: "map" }],
      "must name a plan block",
    ],
    [
      "a source outside depends_on",
      [{ id: "plan", kind: "plan" }, { id: "map", kind: "explore" }, { id: "x", kind: "coding", depends_on: ["map"], fan_out: "plan" }],
      "must also be listed in its depends_on",
    ],
    [
      "two writers on one plan",
      [
        { id: "plan", kind: "plan" },
        { id: "x", kind: "coding", depends_on: ["plan"], fan_out: "plan" },
        { id: "y", kind: "coding", depends_on: ["plan"], fan_out: "plan" },
      ],
      "fans out more than one writer",
    ],
  ])("rejects fan_out on %s", (_label, blocks, message) => {
    expect(() => compile(blocks)).toThrow(message)
  })

  it("passes structural validation and rejects hand-written nodes without the contract", () => {
    const nodes = compile([...route])
    expect(DagValidation.structuralDiagnostics({ nodes }).filter((d) => d.severity === "error")).toEqual([])
    const broken = nodes.map((node) =>
      node.id === "plan" ? { ...node, output_schema: undefined } : node.id === "slices" ? { ...node, depends_on: [] } : node,
    )
    const messages = DagValidation.structuralDiagnostics({ nodes: broken })
      .filter((d) => d.path === "nodes[slices].fan_out")
      .map((d) => d.message)
    expect(messages).toEqual([
      'node "slices" fan_out "plan" is not in its depends_on',
      'node "slices" fan_out source "plan" has no output_schema.properties.packages',
    ])
  })
})

describe("planFanOut", () => {
  it("expands two or more disjoint packages into writers plus an aggregator under the writer id", () => {
    const plan = DagFanOut.planFanOut(
      writer(),
      JSON.stringify({ summary: "s", packages: [pkg("api", ["src/api/"]), pkg("ui", ["./src/ui", "README.md"])] }),
      new Set(["plan", "slices", "gates"]),
    )
    expect(plan.kind).toBe("expand")
    if (plan.kind !== "expand") return
    expect(plan.writerIDs).toEqual(["slices--api", "slices--ui"])
    const byID = new Map(plan.nodes.map((node) => [node.id, node]))
    const api = byID.get("slices--api")!
    expect(api.fan_out).toBeUndefined()
    expect(api.depends_on).toEqual(["plan"])
    expect(api.output_schema).toEqual(DagBlocks.IMPLEMENTATION_SCHEMA)
    expect(api.prompt_template.inline).toContain("{{fan_out_package}}")
    expect(api.prompt_template.input?.fan_out_package).toEqual(pkg("api", ["src/api/"]))
    const aggregator = byID.get("slices")!
    expect(aggregator).toMatchObject({
      worker_type: "explore",
      depends_on: ["slices--api", "slices--ui"],
      output_schema: DagBlocks.IMPLEMENTATION_SCHEMA,
      input_mapping: {
        slices__api_changed_files: "slices--api.output.changed_files",
        slices__api_summary: "slices--api.output.summary",
        slices__ui_changed_files: "slices--ui.output.changed_files",
        slices__ui_summary: "slices--ui.output.summary",
      },
    })
    expect(aggregator.fan_out).toBeUndefined()
    expect(aggregator.prompt_template.inline).toContain("git status --porcelain")
  })

  it("trusts a planner that returns a single package and runs the writer unchanged", () => {
    const plan = DagFanOut.planFanOut(writer(), { summary: "s", packages: [pkg("all", ["src"])] }, new Set())
    expect(plan).toEqual({ kind: "single", node: { ...writer(), fan_out: undefined }, reason: undefined })
    if (plan.kind === "single") expect("fan_out" in plan.node).toBe(false)
  })

  it.each([
    ["overlapping write sets", [pkg("a", ["src/a"]), pkg("b", ["src/a/b.ts"])], 'overlap at "src/a" / "src/a/b.ts"'],
    ["a whole-tree write set", [pkg("a", ["."]), pkg("b", ["docs"])], "overlap"],
    ["duplicate ids", [pkg("a", ["x"]), pkg("a", ["y"])], 'package id "a" is duplicated'],
    ["an unsafe id", [pkg("a b", ["x"]), pkg("c", ["y"])], "must use only letters"],
    ["traversal", [pkg("a", ["../etc"]), pkg("b", ["y"])], "not a repository-relative path"],
    ["a dot-segment spelling of the same file", [pkg("a", ["src/./a.ts"]), pkg("b", ["src/a.ts"])], 'overlap at "src/a.ts" / "src/a.ts"'],
    ["repeated separators", [pkg("a", ["src//a"]), pkg("b", ["src/a/b.ts"])], 'overlap at "src/a" / "src/a/b.ts"'],
    ["an empty write set", [pkg("a", []), pkg("b", ["y"])], "declares no write_set"],
    ["a malformed package", [{ id: "a" }, pkg("b", ["y"])], "is not { id, instruction, write_set }"],
    ["normalized id collisions", [pkg("a-b", ["x"]), pkg("a_b", ["y"])], "normalize to the same input-mapping key"],
  ])("declines %s and tells the serial writer why", (_label, packages, reason) => {
    const plan = DagFanOut.planFanOut(writer(), { summary: "s", packages }, new Set())
    expect(plan.kind).toBe("single")
    if (plan.kind !== "single") return
    expect(plan.reason).toContain(reason)
    expect(plan.node.fan_out).toBeUndefined()
    expect(plan.node.prompt_template.inline).toContain("Parallel fan-out was declined")
  })

  it("gives package writers their own recovery identity and keeps the writer's on the aggregator", () => {
    const recovered = { ...writer(), recovery: { logical_node_id: "slices", attempt: 2, previous_node_id: "slices" } }
    const plan = DagFanOut.planFanOut(recovered, { packages: [pkg("a", ["x"]), pkg("b", ["y"])] }, new Set())
    expect(plan.kind).toBe("expand")
    if (plan.kind !== "expand") return
    const byID = new Map(plan.nodes.map((node) => [node.id, node]))
    expect(byID.get("slices--a")?.recovery).toBeUndefined()
    expect(byID.get("slices--b")?.recovery).toBeUndefined()
    expect(byID.get("slices")?.recovery).toEqual(recovered.recovery)
  })

  it("declines when a writer id is already taken", () => {
    const plan = DagFanOut.planFanOut(
      writer(),
      { packages: [pkg("a", ["x"]), pkg("b", ["y"])] },
      new Set(["slices--a"]),
    )
    expect(plan.kind === "single" && plan.reason).toContain('node "slices--a" already exists')
  })

  it("declines when the source produced no packages", () => {
    const plan = DagFanOut.planFanOut(writer(), "not json", new Set())
    expect(plan.kind === "single" && plan.reason).toContain('"plan" produced no packages list')
  })

  it("keeps braces in planner text out of the declined prompt", () => {
    const plan = DagFanOut.planFanOut(
      writer(),
      { packages: [pkg("{{x}}", ["a"]), pkg("b", ["b"])] },
      new Set(),
    )
    expect(plan.kind === "single" && plan.node.prompt_template.inline).not.toContain("{{x}}")
  })
})

describe("fan_out recovery", () => {
  it("re-points fan_out at the recovered plan attempt", () => {
    const config = { name: "fan-out", nodes: compile([...route]) }
    const row = (id: string, status: string, dependsOn: string[]) =>
      ({
        id,
        workflowId: "dag_1",
        name: id,
        workerType: "build",
        status,
        required: true,
        dependsOn,
        superseded: false,
      }) as never
    const plan = planRecovery(
      config,
      config.nodes.map((node) => row(node.id, node.id === "plan" ? "failed" : "skipped", node.depends_on)),
      ["plan"],
      2,
      3,
    )
    const writerNode = plan.config.nodes.find((node) => node.recovery?.logical_node_id === "slices")
    expect(writerNode?.fan_out).toBe("plan__attempt_2_r2")
    expect(writerNode?.depends_on).toEqual(["plan__attempt_2_r2"])
  })
})
