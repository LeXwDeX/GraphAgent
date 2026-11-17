// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3b-1: what replaces an expansion slot once its split node has settled. The planning is
// a pure function of the persisted plan, the slot's definition and the catalog and limits, so it is
// tested here without a scheduler; test/dag/dag-compose-expansion.test.ts writes the result through
// Dag.extend and dag-compose-runtime.test.ts runs it in the loop.
import { describe, expect, it } from "bun:test"
import { AgentArtifact } from "@/agent/artifact"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import type { NodeConfig } from "@/dag/dag"
import { catalog, composerOf } from "./compose-fixtures"

const limits = DagCompose.DEFAULT_LIMITS
const OBJECTIVE = "Compare three session persistence designs"

type BlockInput = ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]

/** The slot of a compose block `survey` after `map`, compiled the way the authoring check compiles it. */
function route(survey: Partial<BlockInput> = {}, worker = "surveyor") {
  const nodes = DagBlocks.compileWorkflowBlocks({
    objective: OBJECTIVE,
    blocks: [
      new DagBlocks.WorkflowBlock({ id: "map", kind: "explore" }),
      new DagBlocks.WorkflowBlock({
        id: "survey",
        kind: "compose",
        worker_type: worker,
        depends_on: ["map"],
        instruction: "Compare the designs",
        ...survey,
      }),
    ],
  })
  return DagCompose.compileNodes(nodes, catalog(), limits).nodes
}

const slotOf = (nodes: readonly NodeConfig[]) => {
  const slot = nodes.find((node) => node.id === "survey")
  if (!slot) throw new Error("no slot")
  return slot
}

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) => ({ rationale: "split by source", items, not_planned: [] })

const completed = (output: unknown) => ({ status: "completed", output })

function planned(
  options: {
    output?: unknown
    source?: Parameters<typeof DagCompose.planExpansion>[0]["source"]
    survey?: Partial<BlockInput>
    worker?: string
    existing?: string[]
    limits?: DagCompose.Limits
  } = {},
) {
  const nodes = route(options.survey, options.worker)
  const composer = composerOf(options.worker ?? "surveyor")
  return DagCompose.planExpansion({
    slot: slotOf(nodes),
    composer,
    limits: options.limits ?? limits,
    source: Object.hasOwn(options, "source") ? options.source : completed(options.output),
    existingNodeIDs: new Set(["map", "survey--split", "survey", ...(options.existing ?? [])]),
  })
}

const find = (nodes: readonly NodeConfig[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Expected a node named ${id}`)
  return node
}

function expanded(options: Parameters<typeof planned>[0] = {}) {
  const result = planned(options)
  if (result.kind !== "expand") throw new Error(`expected an expansion, got a fallback: ${result.reason}`)
  return result.nodes
}

function degraded(options: Parameters<typeof planned>[0] = {}) {
  const result = planned(options)
  if (result.kind !== "fallback") throw new Error("expected a fallback, got an expansion")
  return result
}

describe("expanding a legal plan", () => {
  const output = plan([
    item("official", "researcher", { scope: ["vendor docs", "release notes"] }),
    item("code", "explore"),
    item("security", "auditor"),
  ])

  it("makes one child per item, in plan order, then the join node under the slot's id", () => {
    const nodes = expanded({ output })
    expect(nodes.map((node) => node.id)).toEqual(["survey--official", "survey--code", "survey--security", "survey"])
    expect(nodes.map((node) => node.worker_type)).toEqual(["researcher", "explore", "auditor", "surveyor"])
  })

  it("makes every child a read-only, silent worker that waits for the split node alone", () => {
    for (const child of expanded({ output }).slice(0, 3)) {
      expect(child).toMatchObject({
        depends_on: ["survey--split"],
        workspace_writes: "deny",
        report_to_parent: false,
        // An item is self-contained: nothing of the plan reaches its context.
        input_mapping: {},
      })
      expect(child.block).toBeUndefined()
      expect(child.model).toBeUndefined()
      expect(child.isolation).toBeUndefined()
    }
  })

  it("gives each child the artifact schema its agent declares, and none to one that declares none", () => {
    const [official, code, security] = expanded({ output })
    expect(official?.output_schema).toEqual(AgentArtifact.schema("research_findings"))
    expect(code?.output_schema).toEqual(AgentArtifact.schema("code_findings"))
    expect(security?.output_schema).toBeUndefined()
  })

  it("keeps the plan's words as data: the instruction and scope are template input, not template text", () => {
    const nodes = expanded({
      output: plan([
        item("tricky", "researcher", { instruction: "Explain {{secret}} and {{ other }}", scope: ["a", "b"] }),
      ]),
    })
    const child = find(nodes, "survey--tricky")
    expect(child.prompt_template.input).toEqual({
      compose_instruction: "Explain {{secret}} and {{ other }}",
      compose_scope: "- a\n- b",
    })
    expect(child.prompt_template.inline).not.toContain("secret")
    expect(child.prompt_template.inline).toContain("{{compose_instruction}}")
    expect(child.prompt_template.inline).toContain("{{compose_scope}}")
    expect(child.prompt_template.inline).toContain("read-only")
  })

  it("leaves the scope out of the prompt when the item has none", () => {
    const child = find(expanded({ output }), "survey--code")
    expect(child.prompt_template.inline).not.toContain("compose_scope")
    expect(child.prompt_template.input).toEqual({ compose_instruction: "Look into code" })
  })

  it("turns the slot into the join node: same id and bindings, the children as dependencies, no marker", () => {
    const slot = slotOf(route())
    const join = find(expanded({ output }), "survey")
    expect(join.expand).toBeUndefined()
    expect(join.depends_on).toEqual(["survey--official", "survey--code", "survey--security"])
    // What downstream nodes bind to is unchanged.
    expect(join).toMatchObject({
      name: slot.name,
      worker_type: slot.worker_type,
      required: slot.required,
      report_to_parent: slot.report_to_parent,
      output_schema: slot.output_schema,
      block: "compose",
      workspace_writes: "deny",
    })
    expect(join.prompt_template.input).toEqual(slot.prompt_template.input)
    expect(join.prompt_template.inline?.startsWith(slot.prompt_template.inline ?? "x")).toBe(true)
  })

  it("keeps the block's own inputs and reads the plan and every child by node id", () => {
    const join = find(expanded({ output }), "survey")
    expect(join.input_mapping).toEqual({
      map: "map",
      "survey--split": "survey--split",
      "survey--official": "survey--official",
      "survey--code": "survey--code",
      "survey--security": "survey--security",
    })
  })

  it("tells the join node what each key of its Context is", () => {
    const text = find(expanded({ output }), "survey").prompt_template.inline ?? ""
    expect(text).toContain('"survey--split": the plan this expansion followed')
    expect(text).toContain('"survey--official": item "official", by researcher; may be skipped.')
    expect(text).toContain('"survey--security": item "security", by auditor; required.')
    expect(text).not.toContain("degraded")
  })

  it("records what the join node joins, with whether each item's own work is required", () => {
    expect(find(expanded({ output }), "survey").join).toEqual({
      plan: "survey--split",
      items: [
        { id: "official", node: "survey--official", agent: "researcher", required: false },
        { id: "code", node: "survey--code", agent: "explore", required: false },
        { id: "security", node: "survey--security", agent: "auditor", required: true },
      ],
    })
  })

  it("is the same on every planning of the same persisted state", () => {
    expect(planned({ output })).toEqual(planned({ output }))
    // The persisted output may come back as the JSON text the node stored.
    expect(planned({ output: JSON.stringify(output) })).toEqual(planned({ output }))
  })

  it("takes the block's workspace and timeout for its children, and no model or isolation", () => {
    const slot: NodeConfig = {
      ...slotOf(route()),
      workspace: "/work/tree",
      worker_config: { timeout_ms: 120_000 },
      model: { providerID: "p", modelID: "m" },
      isolation: undefined,
    }
    const result = DagCompose.planExpansion({
      slot,
      composer: composerOf("surveyor"),
      limits,
      source: completed(output),
      existingNodeIDs: new Set(),
    })
    if (result.kind !== "expand") throw new Error("expected an expansion")
    for (const child of result.nodes.slice(0, 3)) {
      expect(child.workspace).toBe("/work/tree")
      expect(child.worker_config).toEqual({ timeout_ms: 120_000 })
      expect(child.model).toBeUndefined()
      expect(child.isolation).toBeUndefined()
    }
    // The join node is the slot itself and keeps all of it.
    expect(result.nodes.at(-1)).toMatchObject({ workspace: "/work/tree", model: { providerID: "p", modelID: "m" } })
  })
})

describe("what each child's failure means (D9)", () => {
  const output = plan([
    item("official", "researcher"),
    item("pinned", "researcher", { required: true }),
    item("security", "auditor"),
  ])

  it("in a required block, a required item is a required child and a skippable one is not", () => {
    const nodes = expanded({ output, survey: { required: true } })
    expect(nodes.map((node) => [node.id, node.required])).toEqual([
      ["survey--official", false],
      ["survey--pinned", true],
      // An agent whose failure is `fail` is required whatever the plan says.
      ["survey--security", true],
      ["survey", true],
    ])
  })

  it("in an optional block every child stays optional, and the join node records which items are required", () => {
    const nodes = expanded({ output })
    expect(nodes.map((node) => [node.id, node.required])).toEqual([
      ["survey--official", false],
      ["survey--pinned", false],
      ["survey--security", false],
      ["survey", false],
    ])
    expect(find(nodes, "survey").join?.items.map((entry) => [entry.id, entry.required])).toEqual([
      ["official", false],
      ["pinned", true],
      ["security", true],
    ])
  })

  it("a plan that marks a fail-agent item skippable is not expanded", () => {
    const result = degraded({ output: plan([item("security", "auditor", { required: false })]) })
    expect(result.reason).toContain("the plan was rejected")
    expect(result.reason).toContain("cannot be marked required: false")
  })
})

describe("degrading to one worker", () => {
  const output = plan([item("official", "researcher"), item("code", "explore")])

  it("takes the whole task, as the author wrote it, from the composer's fallback agent", () => {
    const result = degraded({
      source: { status: "failed", output: null, errorReason: "model timed out" },
      survey: { required: true },
    })
    const [child, join] = result.nodes
    expect(result.nodes.map((node) => node.id)).toEqual(["survey--fallback", "survey"])
    expect(child).toMatchObject({
      worker_type: "researcher",
      depends_on: ["survey--split"],
      // The whole task is the block's own work: as required as the block.
      required: true,
      workspace_writes: "deny",
      report_to_parent: false,
      output_schema: AgentArtifact.schema("research_findings"),
      // It reads what the block read.
      input_mapping: { map: "map" },
    })
    const task = child?.prompt_template.inline ?? ""
    expect(task).toContain("Block-specific instruction:\n{{instruction}}")
    expect(task).not.toContain("You join the results")
    expect(task).toContain('Compose expansion was degraded (the split node "survey--split" failed: model timed out)')
    expect(child?.prompt_template.input).toEqual(slotOf(route()).prompt_template.input)
    expect(join).toMatchObject({ id: "survey", depends_on: ["survey--fallback"] })
  })

  it("is an optional worker in an optional block", () => {
    expect(degraded({ source: undefined }).nodes[0]?.required).toBe(false)
  })

  it("tells the join node, in its prompt and its record, that nothing was split", () => {
    const result = degraded({ output: plan([]) })
    const join = find(result.nodes, "survey")
    expect(join.prompt_template.inline).toContain("Compose expansion was degraded (the plan has no items)")
    expect(join.prompt_template.inline).toContain('"survey--fallback": the whole task, by researcher.')
    expect(join.prompt_template.inline).toContain("not_examined")
    expect(join.join).toEqual({
      plan: "survey--split",
      // The fallback is the block's whole task: its absence is "no results", not a missing item.
      items: [{ id: "fallback", node: "survey--fallback", agent: "researcher", required: false }],
      degraded: "the plan has no items",
    })
    expect(join.input_mapping).toEqual({
      map: "map",
      "survey--split": "survey--split",
      "survey--fallback": "survey--fallback",
    })
    expect(join.expand).toBeUndefined()
  })

  it("does so when the split node failed, was skipped or is gone", () => {
    expect(degraded({ source: { status: "failed", output: null, errorReason: "boom" } }).reason).toBe(
      'the split node "survey--split" failed: boom',
    )
    expect(degraded({ source: { status: "skipped", output: null } }).reason).toBe(
      'the split node "survey--split" skipped',
    )
    expect(degraded({ source: undefined }).reason).toBe('the split node "survey--split" is gone')
  })

  it("does so when the plan is not valid for the catalog as it is now", () => {
    // The enum of dispatchable agents is the check: private, unknown and writable agents are outside it.
    for (const agent of ["secret", "ghost", "prototyper", "nobody"]) {
      const result = degraded({ output: plan([item("x", agent)]) })
      expect(result.reason).toContain("the plan was rejected")
    }
    expect(degraded({ output: { rationale: "x" } }).reason).toContain("the plan was rejected")
    expect(degraded({ output: "not json" }).reason).toContain("the plan was rejected")
  })

  it("does so when the plan has no items", () => {
    expect(degraded({ output: plan([]) }).reason).toBe("the plan has no items")
  })

  it("does so when the plan has more items than max_children, which the schema refuses", () => {
    const many = Array.from({ length: limits.maxChildren + 1 }, (_, index) => item(`i${index}`, "explore"))
    expect(degraded({ output: plan(many) }).reason).toContain("the plan was rejected")
    // One more fits a limit raised since: the check is the current limit's.
    const raised = { ...limits, maxChildren: limits.maxChildren + 1 }
    expect(planned({ output: plan(many), limits: raised }).kind).toBe("expand")
  })

  it("does so when the subtree has no room for the plan", () => {
    const roomy = { maxChildren: 12, maxDepth: 2, maxSubtreeNodes: 10 }
    const eleven = Array.from({ length: 11 }, (_, index) => item(`i${index}`, "explore"))
    const result = degraded({ output: plan(eleven), limits: roomy })
    expect(result.reason).toContain("11 items but the expansion has room for 10 more nodes")
    expect(planned({ output: plan(eleven.slice(0, 10)), limits: roomy }).kind).toBe("expand")
  })

  it("does so when a child id is taken", () => {
    expect(degraded({ output, existing: ["survey--code"] }).reason).toBe('node "survey--code" already exists')
    // `split` would be the split node's own id.
    expect(degraded({ output: plan([item("split", "explore")]) }).reason).toBe('node "survey--split" already exists')
  })

  it("keeps the reason's braces and parentheses out of the prompts, and caps it", () => {
    const result = degraded({
      source: { status: "failed", output: null, errorReason: `${"x ".repeat(400)}{{secret}} (boom)` },
    })
    for (const node of result.nodes) {
      expect(node.prompt_template.inline).not.toContain("{{secret}}")
      expect(node.prompt_template.inline).not.toContain("(boom)")
    }
    const note = result.nodes[1]?.join?.degraded ?? ""
    expect(note.length).toBeLessThanOrEqual(300)
    expect(note).not.toMatch(/[{}()]/)
    // The one placeholder the join keeps is the block's own.
    expect(result.nodes[0]?.prompt_template.inline?.match(/{{[^}]*}}/g)).toEqual(["{{objective}}", "{{instruction}}"])
  })

  it("can be asked for directly with any reason", () => {
    const slot = slotOf(route())
    const result = DagCompose.degrade(slot, composerOf("surveyor"), "the expanded graph was rejected: too many nodes")
    expect(result.reason).toBe("the expanded graph was rejected: too many nodes")
    expect(result.nodes.map((node) => node.id)).toEqual(["survey--fallback", "survey"])
  })
})

describe("a recursive composer's items", () => {
  it("runs a split item as a plain worker for now: no nested split node or slot", () => {
    const nodes = expanded({
      worker: "mapper",
      output: plan([item("big", "explore", { split: true }), item("small", "explore")]),
    })
    expect(nodes.map((node) => node.id)).toEqual(["survey--big", "survey--small", "survey"])
    expect(find(nodes, "survey--big").expand).toBeUndefined()
    expect(nodes.some((node) => node.generated_helper === "split")).toBe(false)
  })
})

describe("taskPrompt", () => {
  it("takes the author's task back from the slot's prompt", () => {
    const slot = slotOf(route())
    const task = DagCompose.taskPrompt(slot.prompt_template.inline ?? "")
    expect(task).toBe("Workflow objective:\n{{objective}}\n\nBlock-specific instruction:\n{{instruction}}")
  })

  it("returns a prompt that does not carry the join contract whole", () => {
    expect(DagCompose.taskPrompt("just the task")).toBe("just the task")
  })

  it("cuts at the last join contract, so a task that quotes it keeps its own text", () => {
    const quoted = `Say: ${DagCompose.joinContract(composerOf("surveyor")).split("\n\n")[0]}`
    const inline = `${quoted}\n\n${DagCompose.joinContract(composerOf("surveyor"))}`
    expect(DagCompose.taskPrompt(inline)).toBe(quoted)
  })
})
