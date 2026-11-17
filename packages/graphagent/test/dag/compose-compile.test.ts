// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158: a compose block, or a node whose worker is a composer, compiles to a
// split node and an expansion slot, which the scheduler expands when the split
// node has settled. The engine's marks on those nodes are not model-writable, and
// `compose` is a block kind on the model-facing wire.
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
    expect(DagCompose.uncompiledBlocks(result.nodes)).toEqual([])
  })

  it("refuses an input alias in the namespace the expansion binds its own nodes under", () => {
    // The join node reads the split node and each child under its id; an authored `survey--code` would be overwritten
    // by the child of item `code`, and the split and the join would read the same name as different inputs.
    const node: NodeConfig = {
      id: "survey",
      name: "survey",
      worker_type: "surveyor",
      depends_on: ["map"],
      input_mapping: { "survey--code": "map" },
      prompt_template: { inline: "Compare the designs in {{survey--code}}" },
    }
    const result = DagCompose.compileNodes([node], catalog(), limits)
    expect(result.nodes).toEqual([node])
    expect(result.problems).toEqual([
      expect.objectContaining({
        node: "survey",
        path: "nodes[survey].input_mapping",
        message: expect.stringContaining('input alias "survey--code" is reserved'),
      }),
    ])
    expect(DagCompose.reservedAlias("survey", { map: "map", "survey-code": "x" })).toBeUndefined()
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

describe("a compose block the compiler had no catalog for", () => {
  const compiled = DagCompose.compileNodes(compileBlocks(route), catalog(), limits).nodes
  const unexpanded = compileBlocks(route)

  it("is reported once per block, so it never runs as the one node it still is", () => {
    const found = DagCompose.uncompiledBlocks(unexpanded)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ node: "survey", path: "config.blocks[survey]" })
    expect(found[0]?.message).toContain('compose block "survey" cannot be compiled')
    expect(found[0]?.message).toContain('composer "surveyor"')
    const two = compileBlocks([...route, { id: "second", kind: "compose", worker_type: "mapper" }])
    expect(DagCompose.uncompiledBlocks(two).map((problem) => problem.node)).toEqual(["survey", "second"])
  })

  it("reports nothing for what the compiler did compile: the split node, the slot, and every other graph", () => {
    expect(DagCompose.uncompiledBlocks(compiled)).toEqual([])
    const node: NodeConfig = {
      id: "survey",
      name: "Survey",
      worker_type: "surveyor",
      depends_on: [],
      prompt_template: { inline: "x" },
    }
    expect(DagCompose.uncompiledBlocks(DagCompose.compileNodes([node], catalog(), limits).nodes)).toEqual([])
    const plain = compileBlocks([
      { id: "map", kind: "explore" },
      { id: "plan", kind: "plan", depends_on: ["map"], fan_out: undefined },
      { id: "build", kind: "coding", depends_on: ["plan"] },
    ])
    expect(DagCompose.uncompiledBlocks(plain)).toEqual([])
  })

  it("is left to the catalog when the composer cannot be used: that is reported there, not here", () => {
    const result = DagCompose.compileNodes(compileBlocks([{ ...survey, worker_type: "researcher" }]), catalog(), limits)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.message).toContain('agent "researcher" is not a composer')
  })
})

describe("what holds an expansion slot back", () => {
  it("is not the scheduler core: the slot is ready as soon as its split node completes", () => {
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
    // Nothing here holds the slot back. Only the loop's admission seam does, the way it replaces a fan_out writer
    // before spawning it: `DagComposeExpansion.expand`, covered by dag-compose-runtime.test.ts.
    expect(runtime.getReadyNodes()).toEqual(["survey"])
  })
})

// The engine's own marks on a compose node. None of them is a field a model can write, in any schema it writes by:
// the tool's wire, the strict authoring schemas that decode the files it hands over, or a draft it asks the tool to
// write for it.
const ENGINE_MARKS = ["expand", "join", "compose_subtree", "generated_helper"] as const

/** Every property name that appears anywhere in a JSON schema, at any depth. */
function propertyNames(schema: unknown): Set<string> {
  const names = new Set<string>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && typeof child === "object" && child !== null && !Array.isArray(child))
        Object.keys(child).forEach((name) => names.add(name))
      walk(child)
    }
  }
  walk(schema)
  return names
}

const jsonSchemaOf = (schema: Schema.Top) => JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(schema)))

describe("the engine's marks on a compose node are not model-writable", () => {
  const node = { id: "a", name: "a", worker_type: "explore", depends_on: [], prompt_template: { inline: "x" } }
  const marks: Record<(typeof ENGINE_MARKS)[number], unknown> = {
    expand: "a--split",
    join: { plan: "a--split", items: [] },
    compose_subtree: { root: "a", depth: 1 },
    generated_helper: "split",
  }

  it("are not fields of the authoring schemas, and a node or block that carries one is refused", () => {
    for (const mark of ENGINE_MARKS) {
      expect(Object.keys(DagValidation.NodeSchema.fields), mark).not.toContain(mark)
      expect(Object.keys(DagBlocks.WorkflowBlock.fields), mark).not.toContain(mark)
    }
    const decodeNode = Schema.decodeUnknownResult(DagValidation.NodeSchema, DagValidation.STRICT_PARSE_OPTIONS)
    expect(Result.isSuccess(decodeNode(node))).toBe(true)
    const decodeBlock = Schema.decodeUnknownResult(DagBlocks.WorkflowBlock, DagValidation.STRICT_PARSE_OPTIONS)
    const block = { id: "survey", kind: "compose", worker_type: "surveyor" }
    expect(Result.isSuccess(decodeBlock(block))).toBe(true)
    for (const mark of ENGINE_MARKS) {
      expect(Result.isFailure(decodeNode({ ...node, [mark]: marks[mark] })), `node ${mark}`).toBe(true)
      expect(Result.isFailure(decodeBlock({ ...block, [mark]: marks[mark] })), `block ${mark}`).toBe(true)
    }
  })

  it("are refused in every document a model hands over: start, extend and replan", () => {
    const start = Schema.decodeUnknownResult(DagValidation.StartSpec, DagValidation.STRICT_PARSE_OPTIONS)
    const extend = Schema.decodeUnknownResult(DagValidation.ExtendSpec, DagValidation.STRICT_PARSE_OPTIONS)
    const replan = Schema.decodeUnknownResult(DagValidation.ReplanSpec, DagValidation.STRICT_PARSE_OPTIONS)
    const block = { id: "survey", kind: "compose", worker_type: "surveyor" }
    const config = { name: "w", objective: OBJECTIVE, blocks: [block] }
    expect(Result.isSuccess(start({ config }))).toBe(true)
    expect(Result.isSuccess(extend({ objective: OBJECTIVE, blocks: [block] }))).toBe(true)
    expect(Result.isSuccess(replan({ fragment: config }))).toBe(true)
    for (const mark of ENGINE_MARKS) {
      const marked = { ...block, [mark]: marks[mark] }
      const markedNode = { ...node, [mark]: marks[mark] }
      expect(Result.isFailure(start({ config: { ...config, blocks: [marked] } })), `start ${mark}`).toBe(true)
      expect(Result.isFailure(start({ config: { name: "w", nodes: [markedNode] } })), `start node ${mark}`).toBe(true)
      expect(Result.isFailure(extend({ objective: OBJECTIVE, blocks: [marked] })), `extend ${mark}`).toBe(true)
      expect(Result.isFailure(extend({ nodes: [markedNode] })), `extend node ${mark}`).toBe(true)
      expect(Result.isFailure(replan({ fragment: { ...config, blocks: [marked] } })), `replan ${mark}`).toBe(true)
    }
  })

  it("are no property of any schema the model sees or writes by: the tool's wire and every authoring schema", () => {
    for (const mark of ENGINE_MARKS) {
      for (const [name, fields] of Object.entries({ CompactNode, CompactBlock, DraftGraph })) {
        expect(Object.keys(fields.fields), `${name} ${mark}`).not.toContain(mark)
      }
    }
    const documents = {
      wire: ToolJsonSchema.fromSchema(WorkflowParameters),
      start: jsonSchemaOf(DagValidation.StartSpec),
      extend: jsonSchemaOf(DagValidation.ExtendSpec),
      replan: jsonSchemaOf(DagValidation.ReplanSpec),
      node: jsonSchemaOf(DagValidation.NodeSchema),
      block: jsonSchemaOf(DagBlocks.WorkflowBlock),
    }
    for (const [name, document] of Object.entries(documents)) {
      const names = propertyNames(document)
      // A schema that lists no property at all would pass every check below, so it has to list the ones that exist.
      expect(names.has("depends_on"), name).toBe(true)
      for (const mark of ENGINE_MARKS) expect(names.has(mark), `${name} ${mark}`).toBe(false)
    }
  })
})

describe("compose on the model-facing wire", () => {
  const kind = () => JSON.parse(JSON.stringify(ToolJsonSchema.fromSchema(CompactBlock.fields.kind)))

  it("is a block kind a draft can name, and the wire lists exactly the kinds the authoring schema does", () => {
    expect(kind().enum).toEqual([...DagBlocks.WORKFLOW_BLOCK_KINDS])
    expect(kind().enum).toContain("compose")
    const decode = Schema.decodeUnknownSync(WorkflowParameters, { onExcessProperty: "error" })
    const draft = {
      action: "spec",
      operation: "draft",
      config: {
        name: "survey-draft",
        objective: OBJECTIVE,
        blocks: [
          { id: "map", kind: "explore" },
          {
            id: "survey",
            kind: "compose",
            worker_type: "surveyor",
            depends_on: ["map"],
            instruction: "Compare the designs",
            required: true,
            report_to_parent: false,
            worker_config: { timeout_ms: 60000 },
          },
        ],
      },
    }
    expect(() => decode({ params: draft })).not.toThrow()
    expect(() =>
      decode({
        params: { ...draft, config: { ...draft.config, blocks: [{ id: "survey", kind: "compose", expand: "x" }] } },
      }),
    ).toThrow()
    expect(() =>
      decode({ params: { ...draft, config: { ...draft.config, blocks: [{ id: "x", kind: "synthesise" }] } } }),
    ).toThrow()
  })

  it("is described on the kind it names, which is where the model is told what it is", () => {
    const description = kind().description
    expect(description).toContain("compose")
    expect(description).toContain("worker_type")
    expect(description).toContain("composer")
    expect(description).toContain("read-only")
  })
})
