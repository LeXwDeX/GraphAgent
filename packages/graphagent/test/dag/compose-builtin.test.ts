// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR4b: the built-in composers `surveyor` and `mapper`, taken from the real agent catalog instead of the
// fixtures the other compose tests use. Their contracts must resolve to usable composers, a compose block naming
// either must compile, the plan schema each asks its split node for must follow its pattern, and the prompts the
// engine builds around them (the split and the join prompt) are pinned by snapshot, so a change to a dispatched
// agent's description or to the composer contract reaches review as a diff.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Agent } from "@/agent/agent"
import { AgentArtifact } from "@/agent/artifact"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { DagConfig } from "@/dag/config"
import type { NodeConfig } from "@/dag/dag"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { isRecord } from "@/util/record"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Agent.layer.pipe(
    Layer.provideMerge(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const limits = DagCompose.DEFAULT_LIMITS
const OBJECTIVE = "Compare three session persistence designs"

/** The effective agent catalog as the Agent service builds it, and the composer catalog the authoring check derives. */
const loaded = Effect.gen(function* () {
  const agents = yield* Agent.Service.use((svc) => svc.list())
  return { agents, catalog: DagCompose.catalogFrom(agents) }
})

const usable = (catalog: DagCompose.Catalog, name: string): DagCompose.Composer => {
  const resolution = DagCompose.resolve(catalog, name)
  if (!resolution.available) throw new Error(`expected ${name} to be usable: ${resolution.reason}`)
  return resolution.composer
}

/** What a compose block `block` of the composer `worker` compiles to, with the catalog at hand. */
const compileBlock = (catalog: DagCompose.Catalog, worker: string, extra: Record<string, unknown> = {}) =>
  DagCompose.compileNodes(
    DagBlocks.compileWorkflowBlocks({
      objective: OBJECTIVE,
      blocks: [
        new DagBlocks.WorkflowBlock({
          id: "block",
          kind: "compose",
          worker_type: worker,
          instruction: "Compare the designs",
          ...extra,
        }),
      ],
    }),
    catalog,
    limits,
  )

/** `value` as an object, or a failure: the plan schema is a plain JSON schema, read down to the schema of one item. */
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("expected an object")
  return value
}

const find = (nodes: readonly NodeConfig[], id: string) => {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Expected a node named ${id}`)
  return node
}

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) => ({ rationale: "split by what has to be found out", items, not_planned: [] })

describe("the built-in composers in the real agent catalog", () => {
  it.instance("are the only composers, and both resolve to usable ones", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      expect([...catalog.composers.keys()].toSorted()).toEqual(["mapper", "surveyor"])
      for (const name of ["surveyor", "mapper"]) expect(DagCompose.resolve(catalog, name).available, name).toBe(true)
      // A worker is not a composer, whatever its contract says.
      for (const name of ["researcher", "explore", "auditor", "architect", "prototyper"]) {
        expect(DagCompose.isComposer(catalog, name), name).toBe(false)
        expect(DagCompose.resolve(catalog, name).available, name).toBe(false)
      }
    }),
  )

  it.instance(
    "the surveyor fans out to the researcher and explore, falls back to the researcher, joins a survey_report",
    () =>
      Effect.gen(function* () {
        const { catalog } = yield* loaded
        const surveyor = usable(catalog, "surveyor")
        expect(surveyor.pattern).toBe("fan_out")
        expect(surveyor.fallback).toBe("researcher")
        expect(surveyor.artifact).toBe("survey_report")
        // Both are public, read-only and may be skipped; each hands back its own artifact.
        expect(surveyor.dispatch.map((worker) => [worker.name, worker.artifact, worker.failure])).toEqual([
          ["researcher", "research_findings", "skip"],
          ["explore", "code_findings", "skip"],
        ])
        expect(surveyor.dispatch.every((worker) => (worker.description ?? "").length > 0)).toBe(true)
      }),
  )

  it.instance("the mapper splits recursively over explore, falls back to explore, joins a project_map", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const mapper = usable(catalog, "mapper")
      expect(mapper.pattern).toBe("recursive_split")
      expect(mapper.fallback).toBe("explore")
      expect(mapper.artifact).toBe("project_map")
      expect(mapper.dispatch.map((worker) => [worker.name, worker.artifact, worker.failure])).toEqual([
        ["explore", "code_findings", "skip"],
      ])
    }),
  )

  it.instance("are read-only profiles to the DAG's static catalogs, and so never writers", () =>
    Effect.gen(function* () {
      for (const name of ["surveyor", "mapper"]) {
        expect(DagBlocks.isReadOnlyProfile(name), name).toBe(true)
        expect(DagBlocks.isReadOnlyWorker(name), name).toBe(true)
        expect(DagBlocks.workspaceWritesOf(undefined, name), name).toBe("deny")
        // Even as a hand-written node the engine would not have to compile, a composer is no writer.
        const node: NodeConfig = {
          id: "n",
          name: "n",
          worker_type: name,
          depends_on: [],
          prompt_template: { inline: "x" },
        }
        expect(DagBlocks.isWriterNode(node), name).toBe(false)
      }
    }),
  )
})

describe("the plan each built-in composer asks its split node for", () => {
  /** The `items` array of a plan schema: its ceiling, and the properties one item may have. */
  const items = (schema: Record<string, unknown>) => {
    const list = record(record(schema.properties).items)
    return { maxItems: list.maxItems, properties: record(record(list.items).properties) }
  }

  it.instance("lets the surveyor name the researcher or explore, at most six items, and never split one", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const surveyor = usable(catalog, "surveyor")
      const schema = items(DagCompose.planSchema(surveyor, limits))
      expect(schema.maxItems).toBe(6)
      expect(record(schema.properties.agent).enum).toEqual(["researcher", "explore"])
      expect(schema.properties.split).toBeUndefined()
      expect(
        DagCompose.checkPlan(plan([item("docs", "researcher"), item("repo", "explore")]), surveyor, limits).ok,
      ).toBe(true)
      // An agent outside `dispatch`, one that is private and one that does not exist are schema violations.
      for (const agent of ["architect", "auditor", "prototyper", "mapper", "ghost"]) {
        const checked = DagCompose.checkPlan(plan([item("docs", agent)]), surveyor, limits)
        expect(checked.ok, agent).toBe(false)
      }
      // `split` belongs to a recursive composer: here it is an unknown field.
      expect(DagCompose.checkPlan(plan([item("docs", "researcher", { split: true })]), surveyor, limits).ok).toBe(false)
    }),
  )

  it.instance("lets the mapper name explore alone, at most six items, and split an item once more", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const mapper = usable(catalog, "mapper")
      const schema = items(DagCompose.planSchema(mapper, limits))
      expect(schema.maxItems).toBe(6)
      expect(record(schema.properties.agent).enum).toEqual(["explore"])
      expect(record(schema.properties.split)).toMatchObject({ type: "boolean" })
      expect(
        DagCompose.checkPlan(plan([item("api", "explore", { split: true }), item("web", "explore")]), mapper, limits)
          .ok,
      ).toBe(true)
      for (const agent of ["researcher", "architect", "surveyor", "ghost"]) {
        expect(DagCompose.checkPlan(plan([item("api", agent)]), mapper, limits).ok, agent).toBe(false)
      }
      // More than `dag.compose.max_children` items is refused.
      const many = Array.from({ length: 7 }, (_, index) => item(`module-${index}`, "explore"))
      expect(DagCompose.checkPlan(plan(many), mapper, limits).ok).toBe(false)
    }),
  )

  it.instance("takes `dag.compose.max_children` from the limits it is given", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const surveyor = usable(catalog, "surveyor")
      const small = DagCompose.limits({ compose: { max_children: 2 } })
      expect(items(DagCompose.planSchema(surveyor, small)).maxItems).toBe(2)
      const three = plan([item("a", "researcher"), item("b", "researcher"), item("c", "explore")])
      expect(DagCompose.checkPlan(three, surveyor, small).ok).toBe(false)
      expect(DagCompose.checkPlan(three, surveyor, limits).ok).toBe(true)
    }),
  )
})

describe("a compose block of a built-in composer, compiled with the real catalog", () => {
  for (const [composer, artifact] of [
    ["surveyor", "survey_report"],
    ["mapper", "project_map"],
  ] as const) {
    it.instance(`compiles a ${composer} block to a split node and an expansion slot`, () =>
      Effect.gen(function* () {
        const { catalog } = yield* loaded
        const compiled = compileBlock(catalog, composer)
        expect(compiled.problems).toEqual([])
        expect(compiled.nodes.map((node) => node.id)).toEqual(["block--split", "block"])
        const split = find(compiled.nodes, "block--split")
        const slot = find(compiled.nodes, "block")
        // The split node is the composer asked for the plan its contract allows; the slot waits for it and carries the marker.
        expect(split).toMatchObject({
          worker_type: composer,
          generated_helper: "split",
          required: false,
          workspace_writes: "deny",
          output_schema: DagCompose.planSchema(usable(catalog, composer), limits),
        })
        expect(slot).toMatchObject({
          worker_type: composer,
          expand: "block--split",
          depends_on: ["block--split"],
          workspace_writes: "deny",
          output_schema: AgentArtifact.schema(artifact),
        })
        expect(slot.join).toBeUndefined()
      }),
    )
  }

  it.instance("reports a composer the catalog cannot run, naming the agent and the cause", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      // A worker, an agent that does not exist, and a composer-looking name that is not one.
      const worker = compileBlock(catalog, "researcher")
      expect(worker.problems.map((problem) => problem.message)).toEqual([
        'compose block "block": agent "researcher" is not a composer',
      ])
      const ghost = compileBlock(catalog, "cartographer")
      expect(ghost.problems.map((problem) => problem.message)).toEqual([
        'compose block "block": agent "cartographer" does not exist',
      ])
    }),
  )

  it.instance(
    "refuses the mapper at validate time once a user override lets explore write, and still runs the surveyor",
    () =>
      Effect.gen(function* () {
        const { catalog } = yield* loaded
        const mapper = compileBlock(catalog, "mapper")
        expect(mapper.problems).toHaveLength(1)
        const message = mapper.problems[0]?.message ?? ""
        expect(message).toContain('compose block "block": composer "mapper" is unavailable')
        expect(message).toContain('agent "explore" was overridden to allow writing files')
        // The block is left as authored, one node, for the caller to report.
        expect(mapper.nodes.map((node) => node.id)).toEqual(["block"])
        // The surveyor still has the researcher, which the override did not touch.
        const surveyor = compileBlock(catalog, "surveyor")
        expect(surveyor.problems).toEqual([])
        expect(usable(catalog, "surveyor").dispatch.map((worker) => worker.name)).toEqual(["researcher"])
      }),
    { config: { agent: { explore: { permission: { edit: "allow" } } } } },
  )
})

describe("the tier of the nodes a built-in composer makes", () => {
  const tierOf = (graph: readonly NodeConfig[], id: string) => {
    const definition = find(graph, id)
    return DagConfig.tierOf({
      required: definition.required ?? false,
      workerType: definition.worker_type,
      definition,
      graph,
    })
  }

  /** The graph after the slot of `block` has been expanded with `output`, the split node and the join node included. */
  const expandedGraph = (catalog: DagCompose.Catalog, worker: string, output: unknown, extra = {}) => {
    const compiled = compileBlock(catalog, worker, extra)
    const slot = find(compiled.nodes, "block")
    const result = DagCompose.planExpansion({
      slot,
      composer: usable(catalog, worker),
      limits,
      source: { status: "completed", output },
      existingNodeIDs: new Set(compiled.nodes.map((node) => node.id)),
    })
    if (result.kind !== "expand") throw new Error(`expected an expansion: ${result.reason}`)
    return { compiled: compiled.nodes, graph: [find(compiled.nodes, "block--split"), ...result.nodes] }
  }

  it.instance("puts the surveyor's split node, slot and join node on advanced, and its workers on standard", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { compiled, graph } = expandedGraph(
        catalog,
        "surveyor",
        plan([item("docs", "researcher"), item("repo", "explore", { required: true })]),
        { required: true },
      )
      expect(tierOf(compiled, "block--split")).toBe("advanced")
      expect(tierOf(compiled, "block")).toBe("advanced")
      // The join node is the slot after the expansion.
      expect(find(graph, "block").join).toBeDefined()
      expect(tierOf(graph, "block")).toBe("advanced")
      // A required child of a required block is still a standard-tier worker: `required` is failure semantics only.
      expect(find(graph, "block--repo").required).toBe(true)
      for (const id of ["block--docs", "block--repo"]) expect(tierOf(graph, id), id).toBe("standard")
    }),
  )

  it.instance("puts the mapper's nested split node and slot on advanced too, and every worker below on standard", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { graph } = expandedGraph(
        catalog,
        "mapper",
        plan([item("api", "explore", { split: true }), item("web", "explore")]),
      )
      // The item that asks to be split again becomes a nested split node and a nested slot, both composer nodes.
      expect(find(graph, "block--api--split").generated_helper).toBe("split")
      expect(find(graph, "block--api").expand).toBe("block--api--split")
      for (const id of ["block--split", "block", "block--api--split", "block--api"])
        expect(tierOf(graph, id), id).toBe("advanced")
      expect(tierOf(graph, "block--web")).toBe("standard")
    }),
  )

  it.instance("puts the fallback worker of a degraded expansion on standard, as the other workers", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const compiled = compileBlock(catalog, "surveyor", { required: true })
      const degraded = DagCompose.degrade(
        find(compiled.nodes, "block"),
        usable(catalog, "surveyor"),
        "the plan has no items",
      )
      const graph = [find(compiled.nodes, "block--split"), ...degraded.nodes]
      expect(find(graph, "block--fallback").worker_type).toBe("researcher")
      expect(tierOf(graph, "block--fallback")).toBe("standard")
      expect(tierOf(graph, "block")).toBe("advanced")
    }),
  )
})

// The prompts are what the model is told, and they are built from the composer's contract and the descriptions of the
// agents it dispatches to, so a change to any of them is a change to the model's input. The snapshots are the review
// surface; the assertions beside them say what each prompt must hold whatever its wording. What each composer's own
// system prompt says is pinned in test/agent/composer-agents.test.ts.
describe("built-in composer prompts", () => {
  const prompts = (catalog: DagCompose.Catalog, worker: string) => {
    const compiled = compileBlock(catalog, worker)
    return {
      split: find(compiled.nodes, "block--split").prompt_template.inline ?? "",
      join: find(compiled.nodes, "block").prompt_template.inline ?? "",
    }
  }

  it.instance("surveyor split prompt: what it may dispatch to, and no recursion", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { split } = prompts(catalog, "surveyor")
      expect(split).toContain("- researcher: produces research_findings; the plan can go on without it.")
      expect(split).toContain("- explore: produces code_findings; the plan can go on without it.")
      expect(split).toContain("At most 6 items.")
      expect(split).toContain("Depth 1 of 2.")
      expect(split).not.toContain("split: set true")
      expect(split).not.toContain("- auditor:")
      expect(split).toMatchSnapshot()
    }),
  )

  it.instance("surveyor join prompt: the survey_report, and every gap in not_examined", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { join } = prompts(catalog, "surveyor")
      expect(join).toContain("You join the results of an expansion.")
      expect(join).toContain("Return the survey_report artifact.")
      expect(join).toContain("a missing result is never covered work")
      expect(join).toMatchSnapshot()
    }),
  )

  it.instance("mapper split prompt: one dispatch target, and the recursive split", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { split } = prompts(catalog, "mapper")
      expect(split).toContain("- explore: produces code_findings; the plan can go on without it.")
      expect(split).not.toContain("- researcher:")
      expect(split).toContain("- split: set true on an item that is still too large for one worker")
      expect(split).toContain("Depth 1 of 2.")
      expect(split).toMatchSnapshot()
    }),
  )

  it.instance("mapper join prompt: the project_map", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const { join } = prompts(catalog, "mapper")
      expect(join).toContain("Return the project_map artifact.")
      expect(join).toMatchSnapshot()
    }),
  )

  it.instance("mapper nested split prompt: one level down, with what is left of the room", () =>
    Effect.gen(function* () {
      const { catalog } = yield* loaded
      const mapper = usable(catalog, "mapper")
      const compiled = compileBlock(catalog, "mapper")
      const result = DagCompose.planExpansion({
        slot: find(compiled.nodes, "block"),
        composer: mapper,
        limits,
        source: {
          status: "completed",
          output: plan([item("api", "explore", { split: true }), item("web", "explore")]),
        },
        existingNodeIDs: new Set(compiled.nodes.map((node) => node.id)),
      })
      if (result.kind !== "expand") throw new Error("expected an expansion")
      const nested = find(result.nodes, "block--api--split").prompt_template.inline ?? ""
      // The item's own words are template input, never template text; the plan above stays out of its context.
      expect(nested).toContain("{{compose_instruction}}")
      expect(nested).toContain("Depth 2 of 2.")
      expect(nested).toContain("- split: set true")
      expect(nested).toMatchSnapshot()
    }),
  )
})
