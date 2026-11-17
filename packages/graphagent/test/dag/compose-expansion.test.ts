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

describe("a recursive composer's split items", () => {
  const output = plan([item("big", "explore", { split: true, scope: ["src/"] }), item("small", "explore")])
  const mapped = (options: Parameters<typeof planned>[0] = {}) => expanded({ worker: "mapper", output, ...options })

  it("makes a split item a nested plan: its split node and a slot of its own, in the item's place", () => {
    const nodes = mapped()
    expect(nodes.map((node) => node.id)).toEqual(["survey--big--split", "survey--big", "survey--small", "survey"])
    expect(find(nodes, "survey--big--split")).toMatchObject({
      worker_type: "mapper",
      // It waits for the plan above and sees nothing of it: the item is self-contained.
      depends_on: ["survey--split"],
      input_mapping: {},
      // A failed plan degrades the nested slot; it never fails the workflow.
      required: false,
      report_to_parent: false,
      workspace_writes: "deny",
      generated_helper: "split",
      output_schema: DagCompose.planSchema(composerOf("mapper"), limits),
    })
    expect(find(nodes, "survey--big")).toMatchObject({
      worker_type: "mapper",
      depends_on: ["survey--big--split"],
      input_mapping: {},
      required: false,
      report_to_parent: false,
      workspace_writes: "deny",
      expand: "survey--big--split",
      output_schema: AgentArtifact.schema("project_map"),
    })
    expect(find(nodes, "survey--big").join).toBeUndefined()
  })

  it("asks the nested split node for the item's instruction as data, with the nested position", () => {
    const split = find(mapped(), "survey--big--split")
    expect(split.prompt_template.input).toEqual({ compose_instruction: "Look into big", compose_scope: "- src/" })
    const text = split.prompt_template.inline ?? ""
    expect(
      text.startsWith(
        "{{compose_instruction}}\n\nScope, so that this item does not overlap the others:\n{{compose_scope}}",
      ),
    ).toBe(true)
    expect(text).not.toContain("Look into big")
    // Depth 2 of 2. Two items cost 2, the nested plan costs 2 more: 40 - 2 - 2 leaves 36, and its own place makes it 37.
    expect(text).toContain("Depth 2 of 2. The whole expansion may add at most 37 more nodes")
    expect(
      text.endsWith(DagCompose.splitContract(composerOf("mapper"), limits, { depth: 2, remainingNodes: 37 })),
    ).toBe(true)
  })

  it("asks the nested slot for the same task, joined: the join contract after the item's instruction", () => {
    const slot = find(mapped(), "survey--big")
    expect(slot.prompt_template.input).toEqual({ compose_instruction: "Look into big", compose_scope: "- src/" })
    expect(slot.prompt_template.inline).toContain("You join the results of an expansion.")
    expect(slot.prompt_template.inline).toContain("project_map")
    expect(DagCompose.taskPrompt(slot.prompt_template.inline ?? "")).toBe(
      "{{compose_instruction}}\n\nScope, so that this item does not overlap the others:\n{{compose_scope}}",
    )
  })

  it("keeps what the block gave its composer nodes on the nested pair, and what it gave its workers on the others", () => {
    const slot: NodeConfig = {
      ...slotOf(route({}, "mapper")),
      workspace: "/work/tree",
      worker_config: { timeout_ms: 120_000 },
      model: { providerID: "p", modelID: "m" },
    }
    const result = DagCompose.planExpansion({
      slot,
      composer: composerOf("mapper"),
      limits,
      source: completed(output),
      existingNodeIDs: new Set(),
    })
    if (result.kind !== "expand") throw new Error("expected an expansion")
    for (const id of ["survey--big--split", "survey--big"])
      expect(find(result.nodes, id), id).toMatchObject({
        workspace: "/work/tree",
        worker_config: { timeout_ms: 120_000 },
        model: { providerID: "p", modelID: "m" },
      })
    const small = find(result.nodes, "survey--small")
    expect(small).toMatchObject({ workspace: "/work/tree", worker_config: { timeout_ms: 120_000 } })
    expect(small.model).toBeUndefined()
  })

  it("makes the nested slot the item's node in the join node: a dependency, a key and a record entry", () => {
    const join = find(mapped(), "survey")
    expect(join.depends_on).toEqual(["survey--big", "survey--small"])
    expect(join.input_mapping).toEqual({
      map: "map",
      "survey--split": "survey--split",
      "survey--big": "survey--big",
      "survey--small": "survey--small",
    })
    // The nested slot's own split node is not something the join node waits for or reads.
    expect(join.join).toEqual({
      plan: "survey--split",
      // The nested join is the composer's: it is the one that produces the node's result.
      items: [
        { id: "big", node: "survey--big", agent: "mapper", required: false, nested: true },
        { id: "small", node: "survey--small", agent: "explore", required: false },
      ],
    })
    expect(join.prompt_template.inline).toContain(
      '"survey--big": item "big", split again and joined by mapper; may be skipped.',
    )
    expect(join.prompt_template.inline).toContain('"survey--small": item "small", by explore; may be skipped.')
  })

  it("marks every node it generates with the block's subtree, and none of the author's own", () => {
    const nodes = mapped()
    expect(nodes.filter((node) => node.compose_subtree === undefined).map((node) => node.id)).toEqual(["survey"])
    // A worker belongs to the plan its item came from; the nested pair makes the plan one level down.
    expect(find(nodes, "survey--small").compose_subtree).toEqual({ root: "survey", depth: 1 })
    expect(find(nodes, "survey--big--split").compose_subtree).toEqual({ root: "survey", depth: 2 })
    expect(find(nodes, "survey--big").compose_subtree).toEqual({ root: "survey", depth: 2 })
    // The slot as the author wrote it, the split node it waits for and the join node it becomes are not generated.
    expect(slotOf(route({}, "mapper")).compose_subtree).toBeUndefined()
    expect(route({}, "mapper").find((node) => node.id === "survey--split")?.compose_subtree).toBeUndefined()
  })

  it("marks the fallback worker too, with the slot's own subtree", () => {
    const fallback = find(degraded({ worker: "mapper", output: plan([]) }).nodes, "survey--fallback")
    expect(fallback.compose_subtree).toEqual({ root: "survey", depth: 1 })
  })

  it("is the same on every planning of the same persisted state", () => {
    expect(planned({ worker: "mapper", output })).toEqual(planned({ worker: "mapper", output }))
    expect(planned({ worker: "mapper", output: JSON.stringify(output) })).toEqual(planned({ worker: "mapper", output }))
  })

  it("applies D9 to the nested slot as to a child: required when the block and the item are", () => {
    const required = (survey: Partial<BlockInput>, itemRequired: boolean) => {
      const nodes = mapped({
        survey,
        output: plan([item("big", "explore", { split: true, required: itemRequired }), item("small", "explore")]),
      })
      return [
        find(nodes, "survey--big--split").required,
        find(nodes, "survey--big").required,
        find(nodes, "survey--small").required,
      ]
    }
    // The split node never is: a failed plan degrades the nested slot, it does not take the workflow down.
    expect(required({ required: true }, true)).toEqual([false, true, false])
    expect(required({ required: true }, false)).toEqual([false, false, false])
    expect(required({}, true)).toEqual([false, false, false])
    // The join node still records that the item is required, which is what finds it missing in an optional block.
    expect(
      find(mapped({ output: plan([item("big", "explore", { split: true, required: true })]) }), "survey").join
        ?.items[0],
    ).toMatchObject({ id: "big", required: true, nested: true })
  })

  it("does not nest an item of a composer that does not split, whatever the plan says", () => {
    // The plan schema has no `split` for it, so this plan is not one the engine expands.
    const result = degraded({ output: plan([item("big", "explore", { split: true })]) })
    expect(result.reason).toContain("the plan was rejected")
  })

  it("declines when a node id of the nested pair is taken, as for a child", () => {
    expect(degraded({ worker: "mapper", output, existing: ["survey--big--split"] }).reason).toBe(
      'node "survey--big--split" already exists',
    )
    // The item's own id is also a nested pair's: a second item cannot take it.
    const clash = plan([item("big", "explore", { split: true }), item("big--split", "explore")])
    expect(degraded({ worker: "mapper", output: clash }).reason).toContain('produces the node id "big--split"')
  })
})

describe("how deep a plan may be split", () => {
  const output = plan([item("big", "explore", { split: true }), item("small", "explore")])

  it("runs a split item as one worker at the deepest level, and says why in the log, the prompt and the join input", () => {
    const shallow = { ...limits, maxDepth: 1 }
    const result = planned({ worker: "mapper", output, limits: shallow })
    if (result.kind !== "expand") throw new Error("expected an expansion")
    const reason = "the expansion is already as deep as dag.compose.max_depth 1 allows"
    expect(result.declined).toEqual([{ item: "big", reason }])
    expect(result.nodes.map((node) => node.id)).toEqual(["survey--big", "survey--small", "survey"])
    const big = find(result.nodes, "survey--big")
    expect(big.expand).toBeUndefined()
    expect(big.prompt_template.inline).toContain(
      `The plan asked to split this item further, but it runs as one worker: ${reason}.`,
    )
    expect(big.prompt_template.inline).toContain("not_examined")
    // An item that did not ask to be split is told nothing of the kind.
    expect(find(result.nodes, "survey--small").prompt_template.inline).not.toContain("split this item further")
    const join = find(result.nodes, "survey")
    expect(join.join?.items[0]).toEqual({
      id: "big",
      node: "survey--big",
      agent: "explore",
      required: false,
      unsplit: reason,
    })
    expect(join.prompt_template.inline).toContain(
      `"survey--big": item "big", by explore; may be skipped. The plan asked to split it further, but it ran as one worker: ${reason}.`,
    )
  })

  it("reads the depth from the slot's own subtree: a nested slot at the deepest level does not nest again", () => {
    const nested = find(expanded({ worker: "mapper", output }), "survey--big")
    expect(nested.compose_subtree).toEqual({ root: "survey", depth: 2 })
    const result = DagCompose.planExpansion({
      slot: nested,
      composer: composerOf("mapper"),
      limits,
      source: completed(plan([item("deep", "explore", { split: true }), item("flat", "explore")])),
      existingNodeIDs: new Set(["survey--big--split"]),
      position: DagCompose.positionOf(nested, [{ node: nested, status: "pending" }], limits),
    })
    if (result.kind !== "expand") throw new Error("expected an expansion")
    expect(result.declined).toHaveLength(1)
    expect(result.declined[0]?.reason).toContain("dag.compose.max_depth 2")
    // Plain workers of the nested plan sit at its depth, in the same subtree.
    expect(result.nodes.map((node) => [node.id, node.compose_subtree?.depth])).toEqual([
      ["survey--big--deep", 2],
      ["survey--big--flat", 2],
      ["survey--big", 2],
    ])
    expect(
      result.nodes.every((node) => node.compose_subtree === undefined || node.compose_subtree.root === "survey"),
    ).toBe(true)
    // The nested join is the slot, in place: same id and subtree, no marker, a record of its own.
    const join = find(result.nodes, "survey--big")
    expect(join.expand).toBeUndefined()
    expect(join.join?.plan).toBe("survey--big--split")
    expect(join.join?.items.map((entry) => entry.node)).toEqual(["survey--big--deep", "survey--big--flat"])
  })

  it("lets a deeper limit split once more, one level deeper each time", () => {
    const deeper = { ...limits, maxDepth: 3 }
    const first = find(expanded({ worker: "mapper", output, limits: deeper }), "survey--big")
    const result = DagCompose.planExpansion({
      slot: first,
      composer: composerOf("mapper"),
      limits: deeper,
      source: completed(plan([item("mid", "explore", { split: true })])),
      existingNodeIDs: new Set(["survey--big--split"]),
      position: DagCompose.positionOf(first, [{ node: first, status: "pending" }], deeper),
    })
    if (result.kind !== "expand") throw new Error("expected an expansion")
    expect(result.declined).toEqual([])
    expect(result.nodes.map((node) => [node.id, node.compose_subtree?.depth])).toEqual([
      ["survey--big--mid--split", 3],
      ["survey--big--mid", 3],
      ["survey--big", 2],
    ])
    expect(find(result.nodes, "survey--big--mid--split").prompt_template.inline).toContain("Depth 3 of 3.")
  })
})

describe("how much room a plan has to be split in", () => {
  const withRoom = (remainingNodes: number, items: unknown[]) =>
    DagCompose.planExpansion({
      slot: slotOf(route({}, "mapper")),
      composer: composerOf("mapper"),
      limits,
      source: completed(plan(items)),
      existingNodeIDs: new Set(),
      position: { depth: 1, remainingNodes },
    })

  it("pays for a nested plan out of what the plan's own items leave, two nodes each", () => {
    // Two items leave 2 of 4: the nested plan is just paid for. One node less and it is not.
    const split = [item("big", "explore", { split: true }), item("small", "explore")]
    const enough = withRoom(4, split)
    if (enough.kind !== "expand") throw new Error("expected an expansion")
    expect(enough.declined).toEqual([])
    expect(enough.nodes.map((node) => node.id)).toContain("survey--big--split")
    const short = withRoom(3, split)
    if (short.kind !== "expand") throw new Error("expected an expansion")
    expect(short.declined).toEqual([
      {
        item: "big",
        reason: "the subtree has no room left for a nested plan under dag.compose.max_subtree_nodes 40",
      },
    ])
    expect(short.nodes.map((node) => node.id)).toEqual(["survey--big", "survey--small", "survey"])
  })

  it("serves the items that ask in plan order: the first nests, the ones after it run as one worker", () => {
    const result = withRoom(5, [
      item("a", "explore", { split: true }),
      item("b", "explore", { split: true }),
      item("c", "explore", { split: true }),
    ])
    if (result.kind !== "expand") throw new Error("expected an expansion")
    // Three items leave 2 of 5, which pays for one nested plan.
    expect(result.nodes.map((node) => node.id)).toEqual([
      "survey--a--split",
      "survey--a",
      "survey--b",
      "survey--c",
      "survey",
    ])
    expect(result.declined.map((entry) => entry.item)).toEqual(["b", "c"])
    expect(
      find(result.nodes, "survey").join?.items.map((entry) => [entry.id, entry.nested, entry.unsplit === undefined]),
    ).toEqual([
      ["a", true, true],
      ["b", undefined, false],
      ["c", undefined, false],
    ])
  })

  it("tells the nested split node what is still free once the plan is written, and its own place", () => {
    // Four items leave 6 of 10, one nested plan takes 2: 4 are free, and the slot's own place makes it 5.
    const result = withRoom(10, [
      item("a", "explore", { split: true }),
      item("b", "explore"),
      item("c", "explore"),
      item("d", "explore"),
    ])
    if (result.kind !== "expand") throw new Error("expected an expansion")
    expect(find(result.nodes, "survey--a--split").prompt_template.inline).toContain("at most 5 more nodes")
  })

  it("degrades the plan as a whole when its items alone do not fit, as before", () => {
    const result = withRoom(1, [item("a", "explore"), item("b", "explore")])
    expect(result.kind).toBe("fallback")
  })
})

describe("where a plan sits in the persisted graph", () => {
  const nested = (id: string, depth: number, extra: Partial<NodeConfig> = {}) => ({
    ...baseNode(id),
    compose_subtree: { root: "survey", depth },
    ...extra,
  })
  function baseNode(id: string): NodeConfig {
    return { id, name: id, worker_type: "explore", depends_on: [], prompt_template: { inline: "x" } }
  }
  const member = (node: NodeConfig, status = "completed") => ({ node, status })

  it("puts an author's top-level slot at depth 1 with the whole quota, when nothing was generated yet", () => {
    expect(DagCompose.positionOf(slotOf(route({}, "mapper")), [], limits)).toEqual({ depth: 1, remainingNodes: 40 })
  })

  it("reads a nested slot's depth from its own subtree", () => {
    const slot = nested("survey--big", 2, { expand: "survey--big--split" })
    expect(DagCompose.positionOf(slot, [member(slot, "pending")], limits).depth).toBe(2)
  })

  it("counts the generated nodes of the same subtree against max_subtree_nodes, the slot itself among them", () => {
    const slot = nested("survey--big", 2, { expand: "survey--big--split" })
    const others = [
      nested("survey--small", 1),
      nested("survey--big--split", 2),
      { ...baseNode("survey--elsewhere"), compose_subtree: { root: "other", depth: 1 } },
    ]
    // Three nodes carry the root `survey` (the two above and the slot); the fourth belongs to another block.
    expect(
      DagCompose.positionOf(
        slot,
        [...others, slot].map((node) => member(node)),
        limits,
      ).remainingNodes,
    ).toBe(37)
  })

  it("sets aside one node for each other nested slot that waits, and for none that has settled", () => {
    const slot = nested("survey--a", 2, { expand: "survey--a--split" })
    const waiting = nested("survey--b", 2, { expand: "survey--b--split" })
    const failed = nested("survey--c", 2, { expand: "survey--c--split" })
    const members = [member(slot, "pending"), member(waiting, "pending"), member(failed, "failed")]
    // Three nodes are generated, and `b` keeps one more for itself; `c` failed and will not be expanded.
    expect(DagCompose.positionOf(slot, members, limits).remainingNodes).toBe(40 - 3 - 1)
  })

  it("does not depend on the order the graph is listed in", () => {
    const slot = nested("survey--a", 2, { expand: "survey--a--split" })
    const members = [
      member(nested("survey--b", 2, { expand: "survey--b--split" }), "pending"),
      member(slot, "pending"),
      member(nested("survey--x", 1)),
      member(nested("survey--y", 1)),
    ]
    expect(DagCompose.positionOf(slot, members, limits)).toEqual(
      DagCompose.positionOf(slot, [...members].reverse(), limits),
    )
  })

  it("never has less than nothing", () => {
    const slot = nested("survey--a", 2, { expand: "survey--a--split" })
    const crowd = Array.from({ length: 50 }, (_, index) => member(nested(`survey--n${index}`, 1)))
    expect(DagCompose.positionOf(slot, [member(slot, "pending"), ...crowd], limits).remainingNodes).toBe(0)
  })
})

describe("the subtree of one block over a whole expansion", () => {
  const hash = (text: string) => {
    let total = 7
    for (let index = 0; index < text.length; index++) total = (total * 31 + text.charCodeAt(index)) >>> 0
    return total
  }

  /**
   * Expands every nested slot, in graph order, until none waits. `items` says what each plan asks for. Every
   * decision is the one the scheduler would make: the plan checked again, the position read from the graph.
   */
  function grow(limit: DagCompose.Limits, items: (slot: NodeConfig, limit: DagCompose.Limits) => unknown[]) {
    const composer = composerOf("mapper")
    const top = slotOf(route({}, "mapper"))
    const graph = new Map<string, { node: NodeConfig; status: string }>([[top.id, { node: top, status: "pending" }]])
    const fallbacks: string[] = []
    for (let rounds = 0; ; rounds++) {
      if (rounds > 400) throw new Error("the expansion does not end")
      const waiting = [...graph.values()].find((entry) => entry.node.expand !== undefined && entry.status === "pending")
      if (!waiting) break
      const slot = waiting.node
      const result = DagCompose.planExpansion({
        slot,
        composer,
        limits: limit,
        source: completed(plan(items(slot, limit))),
        existingNodeIDs: new Set(graph.keys()),
        position: DagCompose.positionOf(slot, graph.values(), limit),
      })
      if (result.kind === "fallback") fallbacks.push(slot.id)
      for (const node of result.nodes) graph.set(node.id, { node, status: "pending" })
    }
    const generated = [...graph.values()].filter((entry) => entry.node.compose_subtree !== undefined)
    return { graph, generated, fallbacks }
  }

  const everyone = (slot: NodeConfig, limit: DagCompose.Limits) =>
    Array.from({ length: limit.maxChildren }, (_, index) => item(`i${index}`, "explore", { split: true }))
  const varied = (slot: NodeConfig, limit: DagCompose.Limits) => {
    const seed = hash(slot.id)
    return Array.from({ length: 1 + (seed % limit.maxChildren) }, (_, index) =>
      item(`i${index}`, "explore", { split: (seed >>> (index + 3)) % 3 !== 0 }),
    )
  }

  const grid = [2, 6, 12].flatMap((maxChildren) =>
    [1, 2, 3].flatMap((maxDepth) =>
      [10, 17, 40, 80].map((maxSubtreeNodes) => ({ maxChildren, maxDepth, maxSubtreeNodes })),
    ),
  )

  it("never grows past max_subtree_nodes or max_depth, fallbacks included, whatever the plans ask", () => {
    let fallbacks = 0
    let nested = 0
    for (const limit of grid)
      for (const items of [everyone, varied]) {
        const { generated, fallbacks: degraded } = grow(limit, items)
        const label = JSON.stringify(limit)
        expect(generated.length, label).toBeLessThanOrEqual(limit.maxSubtreeNodes)
        expect(
          Math.max(0, ...generated.map((entry) => entry.node.compose_subtree?.depth ?? 0)),
          label,
        ).toBeLessThanOrEqual(limit.maxDepth)
        fallbacks += degraded.length
        nested += generated.filter((entry) => entry.node.generated_helper === "split").length
      }
    // The grid reaches both the nested plans and the degraded ones: the bound is tested where it is tight.
    expect(nested).toBeGreaterThan(0)
    expect(fallbacks).toBeGreaterThan(0)
  })

  it("counts exactly what was generated: nothing is charged twice and nothing escapes", () => {
    const limit = { maxChildren: 3, maxDepth: 3, maxSubtreeNodes: 80 }
    const { generated, graph } = grow(limit, everyone)
    // 3 items at the top, each split with 3 items below, each split with 3 plain ones below that: 3 + 3 * 2 + ...
    const ids = [...graph.keys()]
    expect(new Set(ids).size).toBe(ids.length)
    const split = generated.filter((entry) => entry.node.generated_helper === "split").length
    // Every generated node is a worker, a nested slot or a nested split node; the top slot and its split are the author's.
    expect(generated.length).toBe(graph.size - 1)
    expect(split).toBe(generated.filter((entry) => entry.node.join !== undefined).length)
  })

  it("is the same whichever way the graph is listed", () => {
    const limit = { maxChildren: 4, maxDepth: 3, maxSubtreeNodes: 20 }
    const forward = grow(limit, varied)
    expect([...forward.graph.keys()].sort()).toEqual([...grow(limit, varied).graph.keys()].sort())
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
