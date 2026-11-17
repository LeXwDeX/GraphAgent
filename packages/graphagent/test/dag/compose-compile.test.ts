// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3a: a compose block, or a node whose worker is a composer, compiles to
// a split node and an expansion slot; the submission gate keeps such a graph from
// being submitted until the runtime can expand the slot.
import { describe, expect, it } from "bun:test"
import { WorkflowRuntime } from "@graphagent/core/dag/core/scheduling"
import { Result, Schema } from "effect"
import { AgentArtifact } from "@/agent/artifact"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import type { NodeConfig } from "@/dag/dag"
import { DagValidation } from "@/dag/validation"
import { ToolJsonSchema } from "@/tool/json-schema"
import { WorkflowParameters } from "@/tool/workflow"
import { CompactBlock, CompactNode, DraftGraph } from "@/tool/workflow/schema"
import { agent, agents, catalog, compose, composerOf, writerRules } from "./compose-fixtures"

const limits = DagCompose.DEFAULT_LIMITS
const OBJECTIVE = "Compare three session persistence designs"

type BlockInput = ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]

const compileBlocks = (blocks: BlockInput[], options: DagBlocks.WorkflowBlockCompileOptions = {}) =>
  DagBlocks.compileWorkflowBlocks(
    { objective: OBJECTIVE, blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block)) },
    options,
  )

const survey: BlockInput = {
  id: "survey",
  kind: "compose",
  worker_type: "surveyor",
  instruction: "Compare the designs",
}
const route: BlockInput[] = [
  { id: "map", kind: "explore" },
  { ...survey, depends_on: ["map"] },
]

const find = (nodes: readonly NodeConfig[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Expected a node named ${id}`)
  return node
}

const TASK = "Workflow objective:\n{{objective}}\n\nBlock-specific instruction:\n{{instruction}}"

describe("a compose block, before the catalog is at hand", () => {
  it("compiles to one node that carries the task statement and nothing else", () => {
    const nodes = compileBlocks(route)
    expect(nodes.map((node) => node.id)).toEqual(["map", "survey"])
    expect(find(nodes, "survey")).toEqual({
      id: "survey",
      name: "survey: compose",
      worker_type: "surveyor",
      depends_on: ["map"],
      required: false,
      report_to_parent: false,
      prompt_template: { inline: TASK, input: { objective: OBJECTIVE, instruction: "Compare the designs" } },
      workspace_writes: "deny",
      block: "compose",
    })
  })

  it("needs a worker_type, which names the composer", () => {
    expect(() => compileBlocks([{ id: "survey", kind: "compose" }])).toThrow(
      'Block "survey" (compose) requires worker_type: the composer agent that plans its expansion',
    )
    expect(() => compileBlocks([{ id: "survey", kind: "compose", worker_type: "  " }])).toThrow("requires worker_type")
  })

  it("rejects the fields only other kinds have", () => {
    expect(() => compileBlocks([{ ...survey, lenses: ["standards"] }])).toThrow("only review blocks support")
    expect(() => compileBlocks([{ ...survey, fan_out: "map" }])).toThrow("only coding blocks support")
  })

  it("is not a writer, and naming a composer is not a write escalation under the strict gate", () => {
    expect(DagBlocks.nonWriterWorkerOverride("compose", "surveyor")).toBeUndefined()
    expect(DagBlocks.nonWriterWorkerOverride("compose", "build")).toBeUndefined()
    const strict = { review_gate: "strict" as const }
    expect(() => compileBlocks(route, strict)).not.toThrow()
  })

  it("keeps a strict route with a writer valid: the writer still needs its review, the compose block needs none", () => {
    const strict = { review_gate: "strict" as const, acceptance: [{ id: "AC1", text: "The survey is cited" }] }
    const build: BlockInput = { id: "build", kind: "coding", depends_on: ["survey"] }
    const reviewed: BlockInput[] = [
      ...route,
      build,
      { id: "check", kind: "verify", depends_on: ["build"] },
      { id: "decision", kind: "review", depends_on: ["check"], lenses: ["standards", "completeness"] },
    ]
    expect(() => compileBlocks(reviewed, strict)).not.toThrow()
    expect(() => compileBlocks([...route, build], strict)).toThrow('Writer block "build" has no downstream review gate')
  })

  it("is not a writer before the catalog compiles it either", () => {
    expect(DagBlocks.isWriterNode(find(compileBlocks(route), "survey"))).toBe(false)
  })

  it("is optional by default, and the author can make it required or have it report", () => {
    expect(find(compileBlocks([survey]), "survey")).toMatchObject({ required: false, report_to_parent: false })
    expect(find(compileBlocks([{ ...survey, required: true, report_to_parent: true }]), "survey")).toMatchObject({
      required: true,
      report_to_parent: true,
    })
  })

  it("follows a review gate the way every other block does", () => {
    const nodes = compileBlocks([
      { id: "check", kind: "verify" },
      { id: "decision", kind: "review", depends_on: ["check"] },
      { ...survey, depends_on: ["decision"] },
    ])
    expect(find(nodes, "survey")).toMatchObject({
      condition: 'decision.output.verdict == "ACCEPT"',
      skip_ok: true,
      depends_on: ["decision"],
    })
  })
})

describe("compiling a compose block into a split node and an expansion slot", () => {
  const compile = (blocks: BlockInput[] = route, found = catalog(), given = limits) =>
    DagCompose.compileNodes(compileBlocks(blocks), found, given)

  it("makes the split node, the slot and leaves the rest as it was", () => {
    const { nodes, problems } = compile()
    expect(problems).toEqual([])
    expect(nodes.map((node) => node.id)).toEqual(["map", "survey--split", "survey"])
    expect(find(nodes, "map")).toEqual(find(compileBlocks(route), "map"))
  })

  it("compiles the split node: the composer, asked for the plan, optional so a failed plan still reaches the slot", () => {
    const split = find(compile().nodes, "survey--split")
    const surveyor = composerOf("surveyor")
    expect(split).toEqual({
      id: "survey--split",
      name: "survey: compose: plan the expansion",
      worker_type: "surveyor",
      depends_on: ["map"],
      required: false,
      report_to_parent: false,
      prompt_template: {
        inline: `${TASK}\n\n${DagCompose.splitContract(surveyor, limits, { depth: 1, remainingNodes: 40 })}`,
        input: { objective: OBJECTIVE, instruction: "Compare the designs" },
      },
      output_schema: DagCompose.planSchema(surveyor, limits),
      workspace_writes: "deny",
      block: "compose",
      generated_helper: "split",
    })
  })

  it("compiles the expansion slot: the join node already written, marked, waiting for the split node alone", () => {
    const slot = find(compile().nodes, "survey")
    const surveyor = composerOf("surveyor")
    expect(slot).toEqual({
      id: "survey",
      name: "survey: compose",
      worker_type: "surveyor",
      depends_on: ["survey--split"],
      required: false,
      report_to_parent: false,
      prompt_template: {
        inline: `${TASK}\n\n${DagCompose.joinContract(surveyor)}`,
        input: { objective: OBJECTIVE, instruction: "Compare the designs" },
      },
      // The bindings the block was written with stay valid: map is upstream of the split node.
      input_mapping: { map: "map" },
      output_schema: AgentArtifact.schema("survey_report"),
      workspace_writes: "deny",
      block: "compose",
      expand: "survey--split",
    })
  })

  it("marks only the slot, and the marker names the split node", () => {
    const { nodes } = compile()
    expect(nodes.filter((node) => node.expand !== undefined).map((node) => [node.id, node.expand])).toEqual([
      ["survey", "survey--split"],
    ])
    expect(DagCompose.splitID("survey")).toBe("survey--split")
  })

  it("keeps what is bound to the block bound to the slot", () => {
    const nodes = compile([...route, { id: "decide", kind: "synthesize", depends_on: ["survey"] }]).nodes
    expect(find(nodes, "decide").depends_on).toEqual(["survey"])
  })

  it("gives the slot the block's required and report_to_parent, and the split node neither", () => {
    const { nodes } = compile([{ ...survey, required: true, report_to_parent: true }])
    expect(find(nodes, "survey")).toMatchObject({ required: true, report_to_parent: true })
    expect(find(nodes, "survey--split")).toMatchObject({ required: false, report_to_parent: false })
  })

  it("carries timeout, and a review gate's condition goes to the split node with the skip allowance on both", () => {
    const nodes = compile([
      { id: "check", kind: "verify" },
      { id: "decision", kind: "review", depends_on: ["check"] },
      { ...survey, depends_on: ["decision"], worker_config: { timeout_ms: 90_000 } },
    ]).nodes
    const condition = 'decision.output.verdict == "ACCEPT"'
    expect(find(nodes, "survey--split")).toMatchObject({
      condition,
      skip_ok: true,
      worker_config: { timeout_ms: 90_000 },
    })
    // The slot waits for the split node alone, so the condition it could not read is not copied; a skipped
    // split node cascades the skip, and skip_ok keeps a required slot from failing the workflow for it.
    expect(find(nodes, "survey")).toMatchObject({ skip_ok: true, worker_config: { timeout_ms: 90_000 } })
    expect(find(nodes, "survey")).not.toHaveProperty("condition")
  })

  it("puts the limits in the plan schema and in the prompt", () => {
    const { nodes } = compile(route, catalog(), { maxChildren: 3, maxDepth: 3, maxSubtreeNodes: 25 })
    const split = find(nodes, "survey--split")
    expect(split.output_schema).toMatchObject({ properties: { items: { maxItems: 3 } } })
    expect(split.prompt_template.inline).toContain("At most 3 items")
    expect(split.prompt_template.inline).toContain("Depth 1 of 3")
    expect(split.prompt_template.inline).toContain("at most 25 more nodes")
  })

  it("compiles a recursive_split composer with the split flag in its plan", () => {
    const { nodes } = compile([{ id: "map-repo", kind: "compose", worker_type: "mapper" }])
    expect(JSON.stringify(find(nodes, "map-repo--split").output_schema)).toContain('"split"')
    expect(find(nodes, "map-repo").output_schema).toEqual(AgentArtifact.schema("project_map"))
    const fanOut = compile(route).nodes
    expect(JSON.stringify(find(fanOut, "survey--split").output_schema)).not.toContain('"split"')
  })

  it("leaves the slot without an output schema when the composer declares no artifact", () => {
    const list = agents().map((entry) =>
      entry.name === "surveyor"
        ? agent("surveyor", {
            contract: {
              role: "composer",
              compose: compose("fan_out", ["researcher", "explore"], "researcher"),
            },
          })
        : entry,
    )
    const { nodes } = compile(route, catalog(list))
    expect(find(nodes, "survey")).not.toHaveProperty("output_schema")
    expect(find(nodes, "survey").prompt_template.inline).not.toContain("artifact.")
  })

  it("is no writer: neither node counts as one, whatever the composer's own rules say", () => {
    const writing = agents().map((entry) =>
      entry.name === "surveyor" ? agent("surveyor", { permission: writerRules, contract: entry.contract }) : entry,
    )
    for (const found of [catalog(), catalog(writing)]) {
      const { nodes } = compile(route, found)
      for (const id of ["survey--split", "survey"]) {
        expect(find(nodes, id)).toMatchObject({ workspace_writes: "deny" })
        expect(DagBlocks.isWriterNode(find(nodes, id))).toBe(false)
      }
    }
  })

  it("leaves a block of another kind alone when it names a composer as its worker", () => {
    // That is an ordinary worker override; compose is the block that plans.
    const nodes = compileBlocks([{ id: "look", kind: "explore", worker_type: "surveyor" }])
    const result = DagCompose.compileNodes(nodes, catalog(), limits)
    expect(result.nodes).toEqual(nodes)
    expect(result.problems).toEqual([])
    expect(DagCompose.gate(result.nodes)).toEqual([])
  })

  it("compiles two compose blocks side by side", () => {
    const { nodes } = compile([
      { ...survey, id: "one" },
      { ...survey, id: "two", worker_type: "mapper" },
    ])
    expect(nodes.map((node) => node.id)).toEqual(["one--split", "one", "two--split", "two"])
  })

  it("compiles the same node twice to the same result, and never splits a node it produced", () => {
    const first = compile()
    const again = DagCompose.compileNodes(first.nodes, catalog(), limits)
    expect(again.nodes).toEqual(first.nodes)
    expect(again.problems).toEqual([])
  })

  it("returns every node as it was when there is no catalog to resolve against", () => {
    const nodes = compileBlocks(route)
    const result = DagCompose.compileNodes(nodes, undefined, limits)
    expect(result.nodes).toEqual(nodes)
    expect(result.problems).toEqual([])
  })

  it("leaves a block-compiled graph without compose blocks exactly as it was", () => {
    const plain = compileBlocks([
      { id: "map", kind: "explore" },
      { id: "plan", kind: "plan", depends_on: ["map"] },
      { id: "build", kind: "coding", depends_on: ["plan"] },
    ])
    expect(DagCompose.compileNodes(plain, catalog(), limits).nodes).toEqual(plain)
  })
})

describe("compiling a node whose worker is a composer", () => {
  const authored = (extra: Partial<NodeConfig> = {}): NodeConfig => ({
    id: "survey",
    name: "Survey the designs",
    worker_type: "surveyor",
    depends_on: ["map"],
    prompt_template: { inline: "Compare the designs found in {{map}}", input: { audience: "maintainers" } },
    ...extra,
  })
  const upstream: NodeConfig = {
    id: "map",
    name: "Map",
    worker_type: "explore",
    depends_on: [],
    prompt_template: { inline: "Map it" },
  }
  const compile = (node: NodeConfig, found = catalog()) => DagCompose.compileNodes([upstream, node], found, limits)

  it("compiles to the same split node and slot a block does", () => {
    const { nodes, problems } = compile(authored())
    expect(problems).toEqual([])
    expect(nodes.map((node) => node.id)).toEqual(["map", "survey--split", "survey"])
    const surveyor = composerOf("surveyor")
    expect(find(nodes, "survey--split")).toEqual({
      id: "survey--split",
      name: "Survey the designs: plan the expansion",
      worker_type: "surveyor",
      depends_on: ["map"],
      required: false,
      report_to_parent: false,
      prompt_template: {
        inline: `Compare the designs found in {{map}}\n\n${DagCompose.splitContract(surveyor, limits, { depth: 1, remainingNodes: 40 })}`,
        input: { audience: "maintainers" },
      },
      output_schema: DagCompose.planSchema(surveyor, limits),
      workspace_writes: "deny",
      generated_helper: "split",
    })
    expect(find(nodes, "survey")).toEqual({
      id: "survey",
      name: "Survey the designs",
      worker_type: "surveyor",
      depends_on: ["survey--split"],
      prompt_template: {
        inline: `Compare the designs found in {{map}}\n\n${DagCompose.joinContract(surveyor)}`,
        input: { audience: "maintainers" },
      },
      input_mapping: { map: "map" },
      output_schema: AgentArtifact.schema("survey_report"),
      workspace_writes: "deny",
      expand: "survey--split",
    })
  })

  it("carries the node's own bindings, its required, its output contract and its workspace", () => {
    const { nodes } = compile(
      authored({
        required: true,
        report_to_parent: true,
        input_mapping: { findings: "map.output.summary" },
        output_schema: { type: "object", properties: { verdict: { type: "string" } } },
        workspace: "/work/tree",
        worker_config: { timeout_ms: 5000 },
      }),
    )
    const slot = find(nodes, "survey")
    expect(slot).toMatchObject({
      required: true,
      report_to_parent: true,
      input_mapping: { findings: "map.output.summary" },
      output_schema: { type: "object", properties: { verdict: { type: "string" } } },
      workspace: "/work/tree",
      worker_config: { timeout_ms: 5000 },
    })
    expect(find(nodes, "survey--split")).toMatchObject({
      required: false,
      input_mapping: { findings: "map.output.summary" },
      workspace: "/work/tree",
      worker_config: { timeout_ms: 5000 },
    })
    // The plan schema is the split node's, whatever contract the authored node asked of its result.
    expect(find(nodes, "survey--split").output_schema).toEqual(DagCompose.planSchema(composerOf("surveyor"), limits))
  })

  it("does not copy a node's definition by reference", () => {
    const node = authored({ worker_config: { timeout_ms: 1 }, input_mapping: { a: "map" } })
    const { nodes } = compile(node)
    expect(find(nodes, "survey").worker_config).not.toBe(node.worker_config)
    expect(find(nodes, "survey--split").input_mapping).not.toBe(node.input_mapping)
    expect(find(nodes, "survey").prompt_template.input).not.toBe(node.prompt_template.input)
  })

  it("does not touch a node whose worker is not a composer", () => {
    const worker = authored({ worker_type: "researcher" })
    expect(compile(worker).nodes).toEqual([upstream, worker])
  })

  it("does not read a replan fragment's restart or cancel of a live composer node as a new composer node", () => {
    for (const flag of [{ restart: true }, { cancel: true }]) {
      const node = authored(flag)
      expect(compile(node).nodes).toEqual([upstream, node])
    }
  })
})

describe("the composer nodes it cannot compile", () => {
  const reopened = () =>
    agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
  const problems = (blocks: BlockInput[], found = catalog()) =>
    DagCompose.compileNodes(compileBlocks(blocks), found, limits)

  it("names the agent and the cause when worker_type is not a composer", () => {
    const result = problems([{ ...survey, worker_type: "researcher" }])
    expect(result.problems).toEqual([
      {
        node: "survey",
        path: "config.blocks[survey].worker_type",
        message: 'compose block "survey": agent "researcher" is not a composer',
        hint: expect.stringContaining('role "composer"'),
      },
    ])
    // The block stays as it was, so the graph can be shown with the error.
    expect(result.nodes.map((node) => node.id)).toEqual(["survey"])
  })

  it("names the agent when worker_type does not exist", () => {
    const result = problems([{ ...survey, worker_type: "ghost" }])
    expect(result.problems.map((problem) => problem.message)).toEqual([
      'compose block "survey": agent "ghost" does not exist',
    ])
  })

  it("explains an unavailable composer, which agent made it so and why", () => {
    const result = problems([{ ...survey, worker_type: "mapper" }], catalog(reopened()))
    expect(result.problems).toHaveLength(1)
    const message = result.problems[0]?.message
    expect(message).toContain('compose block "survey": composer "mapper" is unavailable')
    expect(message).toContain('agent "explore"')
    expect(message).toContain("can write files")
    expect(result.nodes.map((node) => node.id)).toEqual(["survey"])
  })

  it("explains an unusable fallback", () => {
    const list = agents().map((entry) =>
      entry.name === "surveyor"
        ? agent("surveyor", {
            contract: { role: "composer", compose: compose("fan_out", ["explore", "secret"], "secret") },
          })
        : entry,
    )
    const result = problems(route, catalog(list))
    expect(result.problems[0]?.message).toContain('fallback "secret" cannot be expanded')
  })

  it("uses the effective catalog: the same block is fine until an override reopens explore", () => {
    const block: BlockInput[] = [{ id: "map-repo", kind: "compose", worker_type: "mapper" }]
    expect(problems(block).problems).toEqual([])
    expect(problems(block, catalog(reopened())).problems).toHaveLength(1)
  })

  it("explains a node form composer the same way, with the node's own path", () => {
    const node: NodeConfig = {
      id: "survey",
      name: "Survey",
      worker_type: "mapper",
      depends_on: [],
      prompt_template: { inline: "Map it" },
    }
    const result = DagCompose.compileNodes([node], catalog(reopened()), limits)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({ node: "survey", path: "nodes[survey].worker_type" })
    expect(result.problems[0]?.message).toContain('node "survey": composer "mapper" is unavailable')
    expect(result.nodes).toEqual([node])
  })

  it("refuses a composer node that uses a prompt asset, and one that carries fan_out or review", () => {
    const base: NodeConfig = {
      id: "survey",
      name: "Survey",
      worker_type: "surveyor",
      depends_on: [],
      prompt_template: { inline: "x" },
    }
    const asset = DagCompose.compileNodes([{ ...base, prompt_template: { id: "survey-prompt" } }], catalog(), limits)
    expect(asset.problems[0]?.message).toContain("cannot run with a prompt asset")
    const fanOut = DagCompose.compileNodes([{ ...base, fan_out: "plan" }], catalog(), limits)
    expect(fanOut.problems[0]?.message).toContain("cannot carry fan_out")
    const review = DagCompose.compileNodes([{ ...base, review: { phase: "design" } }], catalog(), limits)
    expect(review.problems[0]?.message).toContain("cannot carry review")
  })
})

describe("the submission gate", () => {
  const { nodes } = DagCompose.compileNodes(compileBlocks(route), catalog(), limits)

  it("refuses a graph with an expansion slot, once per compose block, and says why", () => {
    const found = DagCompose.gate(nodes)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ node: "survey", path: "config.blocks[survey]" })
    expect(found[0]?.message).toContain("compose 的运行时展开尚未启用（#1158 PR3b）")
    expect(found[0]?.message).toContain('compose block "survey"')
  })

  it("refuses a compose block that could not be compiled, so it never runs as an ordinary node", () => {
    const unexpanded = compileBlocks(route)
    expect(DagCompose.gate(unexpanded).map((problem) => problem.node)).toEqual(["survey"])
  })

  it("refuses a composer node too, naming the node", () => {
    const node: NodeConfig = {
      id: "survey",
      name: "Survey",
      worker_type: "surveyor",
      depends_on: [],
      prompt_template: { inline: "x" },
    }
    const compiled = DagCompose.compileNodes([node], catalog(), limits).nodes
    const found = DagCompose.gate(compiled)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ node: "survey", path: "nodes[survey]" })
    expect(found[0]?.message).toContain('composer node "survey"')
  })

  it("lets every other graph through", () => {
    const plain = compileBlocks([
      { id: "map", kind: "explore" },
      { id: "plan", kind: "plan", depends_on: ["map"], fan_out: undefined },
      { id: "build", kind: "coding", depends_on: ["plan"] },
    ])
    expect(DagCompose.gate(plain)).toEqual([])
  })
})

describe("why the gate exists", () => {
  it("the scheduler core knows nothing of the marker: the slot is ready as soon as its split node completes", () => {
    const { nodes } = DagCompose.compileNodes(compileBlocks(route), catalog(), limits)
    const runtime = new WorkflowRuntime(
      nodes.map((node) => ({
        id: node.id,
        dependsOn: node.depends_on,
        required: node.required ?? false,
        status: "pending" as const,
      })),
      8,
    )
    runtime.markSatisfied("map")
    expect(runtime.getReadyNodes()).toEqual(["survey--split"])
    runtime.markSatisfied("survey--split")
    // Nothing here holds the slot back. Only the loop's admission seam could, the way it replaces a fan_out
    // writer before spawning it, and that seam is the runtime half of #1158.
    expect(runtime.getReadyNodes()).toEqual(["survey"])
  })
})

describe("the expansion marker is not model-writable", () => {
  it("is not a field of the authoring node schema, and a node that carries it is refused", () => {
    expect(Object.keys(DagValidation.NodeSchema.fields)).not.toContain("expand")
    const decode = Schema.decodeUnknownResult(DagValidation.NodeSchema, DagValidation.STRICT_PARSE_OPTIONS)
    const node = { id: "a", name: "a", worker_type: "explore", depends_on: [], prompt_template: { inline: "x" } }
    expect(Result.isSuccess(decode(node))).toBe(true)
    expect(Result.isFailure(decode({ ...node, expand: "a--split" }))).toBe(true)
    // The compiler's own helper marker is no more writable.
    expect(Result.isFailure(decode({ ...node, generated_helper: "split" }))).toBe(true)
  })

  it("is not on the wire the model calls the tool through", () => {
    expect(Object.keys(CompactNode.fields)).not.toContain("expand")
    expect(Object.keys(CompactBlock.fields)).not.toContain("expand")
    expect(Object.keys(DraftGraph.fields)).not.toContain("expand")
    const wire = JSON.stringify(ToolJsonSchema.fromSchema(WorkflowParameters))
    expect(wire).not.toContain("expand")
    expect(wire).not.toContain("generated_helper")
  })

  it("keeps compose off the wire until the runtime can expand it, while files may already use it", () => {
    const wireKinds = (() => {
      const kind = CompactBlock.fields.kind
      return Object.values(JSON.parse(JSON.stringify(ToolJsonSchema.fromSchema(kind))).enum ?? [])
    })()
    expect(wireKinds).not.toContain("compose")
    expect(DagBlocks.WORKFLOW_BLOCK_KINDS).toContain("compose")
    expect([...DagBlocks.WORKFLOW_BLOCK_KINDS].filter((kind) => !wireKinds.includes(kind))).toEqual(["compose"])
  })
})
