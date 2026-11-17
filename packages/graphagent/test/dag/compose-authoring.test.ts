// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158: what the Workflow Authoring Check does with a compose block and with a node whose worker is a composer.
// The check compiles both with the agent catalog at hand, reports a composer that cannot be used and why, and
// submits the compiled graph as it is: the split node and the expansion slot the scheduler expands at run time.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagCompose } from "@/dag/compose"
import type { DagValidation } from "@/dag/validation"
import { agent, agents, writerRules } from "./compose-fixtures"

const environment = (list = agents()): DagValidation.EnvironmentCatalogs => ({
  worker_types: new Set([...list.map((entry) => entry.name), "plan", "build", "general"]),
  composers: DagCompose.catalogFrom(list),
})

type Source = { objective: string; blocks: unknown[] } | { nodes: unknown[] }

function prepare(input: {
  action?: "start" | "extend" | "replan"
  graph: Source
  profile?: DagValidation.Profile
  catalogs?: DagValidation.EnvironmentCatalogs
  review_gate?: "strict" | "standard"
}) {
  const action = input.action ?? "start"
  const graph = {
    name: "compose-check",
    ...input.graph,
    ...(input.review_gate ? { review_gate: input.review_gate } : {}),
  }
  const value = action === "start" ? { config: graph } : action === "replan" ? { fragment: graph } : input.graph
  return Effect.runPromise(
    WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed(input.catalogs ?? environment()) }).prepare({
      action,
      source: { kind: "inline", value, source: "compose-check" },
      profile: input.profile ?? "environment",
      ...(action === "extend" ? { known_dependencies: ["map"] } : {}),
    }),
  )
}

const OBJECTIVE = "Compare three session persistence designs"
const blocks = (...extra: Record<string, unknown>[]) => ({
  objective: OBJECTIVE,
  blocks: [{ id: "map", kind: "explore" }, ...extra],
})
const survey = { id: "survey", kind: "compose", worker_type: "surveyor", depends_on: ["map"], instruction: "Compare" }
const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message)

describe("a compose block under the environment profile", () => {
  it("compiles and is submitted: nothing about the graph is wrong, and the split node and slot are what is prepared", async () => {
    const result = await prepare({ graph: blocks(survey) })
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    // The graph that was checked is the compiled one, split node and slot included.
    expect(result.nodes.map((node) => [node.id, node.worker_type, node.depends_on, node.has_output_schema])).toEqual([
      ["map", "explore", [], false],
      ["survey--split", "surveyor", ["map"], true],
      ["survey", "surveyor", ["survey--split"], true],
    ])
    const prepared = result.prepared?.nodes
    expect(prepared?.map((node) => node.id)).toEqual(["map", "survey--split", "survey"])
    // The marker the scheduler expands by travels with the prepared graph, and only on the slot.
    expect(prepared?.find((node) => node.id === "survey")?.expand).toBe("survey--split")
    expect(prepared?.filter((node) => node.expand !== undefined)).toHaveLength(1)
    expect(prepared?.find((node) => node.id === "survey--split")?.generated_helper).toBe("split")
  })

  it("is no write escalation under the strict gate, where it is accepted like any other read-only block", async () => {
    const result = await prepare({ graph: blocks(survey), review_gate: "strict" })
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.prepared?.nodes.map((node) => node.id)).toEqual(["map", "survey--split", "survey"])
  })

  it("lets the blocks after it depend on it", async () => {
    const result = await prepare({
      graph: blocks(survey, { id: "decide", kind: "synthesize", depends_on: ["survey"] }),
    })
    expect(result.errors).toEqual([])
    expect(result.nodes.find((node) => node.id === "decide")?.depends_on).toEqual(["survey"])
  })

  it("is accepted in an extend and in a replan fragment as well", async () => {
    const extend = await prepare({ action: "extend", graph: { objective: OBJECTIVE, blocks: [survey] } })
    expect(extend.errors).toEqual([])
    expect(extend.prepared?.nodes.map((node) => node.id)).toEqual(["survey--split", "survey"])
    const replan = await prepare({ action: "replan", graph: blocks(survey) })
    expect(replan.errors).toEqual([])
    expect(replan.prepared?.nodes.map((node) => node.id)).toEqual(["map", "survey--split", "survey"])
  })

  it("still refuses what a compose block cannot carry, naming the block", async () => {
    const lenses = await prepare({ graph: blocks({ ...survey, lenses: ["standards"] }) })
    expect(lenses.errors.map((error) => error.code)).toEqual(["block.compile_failed"])
    expect(messages(lenses)[0]).toContain('Block "survey" declares lenses, which only review blocks support')
    const plan = { id: "plan", kind: "plan", depends_on: ["map"] }
    const fanOut = await prepare({ graph: blocks(plan, { ...survey, fan_out: "plan" }) })
    expect(messages(fanOut)[0]).toContain('Block "survey" uses fan_out, which only coding blocks support')
  })
})

describe("a node whose worker is a composer, under the environment profile", () => {
  const node = {
    id: "survey",
    name: "Survey",
    worker_type: "surveyor",
    depends_on: [],
    prompt_template: { inline: "Compare the designs", input: {} },
  }

  it("compiles to the same split node and slot, and is submitted", async () => {
    const result = await prepare({ graph: { nodes: [node] } })
    expect(result.errors).toEqual([])
    expect(result.nodes.map((entry) => entry.id)).toEqual(["survey--split", "survey"])
    expect(result.prepared?.nodes.find((entry) => entry.id === "survey")?.expand).toBe("survey--split")
  })

  it("is an ordinary node when its worker is not a composer", async () => {
    const result = await prepare({ graph: { nodes: [{ ...node, worker_type: "researcher" }] } })
    expect(result.valid).toBe(true)
    expect(result.nodes.map((entry) => entry.id)).toEqual(["survey"])
    expect(result.prepared?.nodes.some((entry) => entry.expand !== undefined)).toBe(false)
  })
})

describe("validate says why a compose block cannot be used", () => {
  it("reports a missing worker_type as a compile failure that names the block", async () => {
    const { worker_type: _worker, ...bare } = survey
    const result = await prepare({ graph: blocks(bare) })
    expect(result.errors.map((error) => error.code)).toEqual(["block.compile_failed"])
    expect(messages(result)[0]).toContain('Block "survey" (compose) requires worker_type')
  })

  it("reports a worker_type that is not a composer, naming the agent", async () => {
    const result = await prepare({ graph: blocks({ ...survey, worker_type: "researcher" }) })
    expect(result.valid).toBe(false)
    expect(result.prepared).toBeUndefined()
    expect(result.errors.find((error) => error.path === "config.blocks[survey].worker_type")).toMatchObject({
      code: "dag.invalid",
      message: 'compose block "survey": agent "researcher" is not a composer',
    })
    // The block could not be compiled, so it stays the one node it was and the check is the only thing between it
    // and a start.
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "survey"])
  })

  it("reports a worker_type that is no agent at all", async () => {
    const result = await prepare({ graph: blocks({ ...survey, worker_type: "ghost" }) })
    expect(messages(result)).toContain('compose block "survey": agent "ghost" does not exist')
    expect(result.errors.some((error) => error.code === "worker.unknown")).toBe(true)
  })

  it("reports a composer the effective catalog makes unavailable, naming the agent that did and why", async () => {
    // A user-level explore.md that lets explore write: public no more, so mapper has nothing to dispatch to.
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    const result = await prepare({
      graph: blocks({ id: "map-repo", kind: "compose", worker_type: "mapper" }),
      catalogs: environment(reopened),
    })
    const found = result.errors.find((error) => error.path === "config.blocks[map-repo].worker_type")
    expect(found?.message).toContain('compose block "map-repo": composer "mapper" is unavailable')
    expect(found?.message).toContain('agent "explore"')
    expect(found?.message).toContain("can write files")
    // The same block is usable while the catalog is untouched.
    const usable = await prepare({ graph: blocks({ id: "map-repo", kind: "compose", worker_type: "mapper" }) })
    expect(usable.errors).toEqual([])
  })

  it("reports an unavailable composer behind a node the same way", async () => {
    const reopened = agents().map((entry) =>
      entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
    )
    const result = await prepare({
      graph: {
        nodes: [
          { id: "map-repo", name: "Map", worker_type: "mapper", depends_on: [], prompt_template: { inline: "Map" } },
        ],
      },
      catalogs: environment(reopened),
    })
    expect(messages(result).join("\n")).toContain('node "map-repo": composer "mapper" is unavailable')
  })

  it("refuses a composer node that uses a prompt asset, and one that carries fan_out or review", async () => {
    const node = { id: "survey", name: "Survey", worker_type: "surveyor", depends_on: [] }
    const asset = await prepare({ graph: { nodes: [{ ...node, prompt_template: { id: "survey-prompt" } }] } })
    expect(messages(asset).join("\n")).toContain("cannot run with a prompt asset")
    const fanOut = await prepare({
      graph: { nodes: [{ ...node, prompt_template: { inline: "x" }, fan_out: "plan" }] },
    })
    expect(messages(fanOut).join("\n")).toContain("cannot carry fan_out")
  })

  it("refuses an input alias in the namespace the expansion binds its own nodes under", async () => {
    const result = await prepare({
      graph: {
        nodes: [
          { id: "map", name: "Map", worker_type: "explore", depends_on: [], prompt_template: { inline: "Map" } },
          {
            id: "survey",
            name: "Survey",
            worker_type: "surveyor",
            depends_on: ["map"],
            input_mapping: { "survey--code": "map" },
            prompt_template: { inline: "Compare the designs in {{survey--code}}" },
          },
        ],
      },
    })
    expect(messages(result).join("\n")).toContain('input alias "survey--code" is reserved')
    expect(result.valid).toBe(false)
  })
})

describe("under the portable profile", () => {
  it("has no catalog, so a compose block compiles to its one node and the check does not judge its composer", async () => {
    const result = await prepare({ graph: blocks(survey), profile: "portable" })
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "survey"])
    // Nothing expands: whether the composer is usable is for the start, which compiles under the environment profile.
    expect(result.prepared?.nodes.some((node) => node.expand !== undefined)).toBe(false)
  })

  it("accepts a compose block naming an agent it cannot resolve, which the environment profile refuses", async () => {
    const graph = blocks({ ...survey, worker_type: "ghost" })
    expect((await prepare({ graph, profile: "portable" })).valid).toBe(true)
    expect((await prepare({ graph })).valid).toBe(false)
  })

  it("still reports a missing worker_type", async () => {
    const { worker_type: _worker, ...bare } = survey
    const result = await prepare({ graph: blocks(bare), profile: "portable" })
    expect(result.errors.map((error) => error.code)).toEqual(["block.compile_failed"])
  })

  it("does not judge a node's worker: whether it is a composer is the environment's to say", async () => {
    const result = await prepare({
      graph: {
        nodes: [
          { id: "survey", name: "Survey", worker_type: "surveyor", depends_on: [], prompt_template: { inline: "x" } },
        ],
      },
      profile: "portable",
    })
    expect(result.valid).toBe(true)
    expect(result.nodes.map((node) => node.id)).toEqual(["survey"])
  })
})

describe("an environment that carries no composer catalog", () => {
  // It cannot compile the block, and the one node left would run the composer on the task statement with nothing to
  // expand, so the profile that starts workflows reports it instead of submitting it.
  const catalogs = { worker_types: new Set(["explore", "plan", "surveyor"]) }

  it("reports the compose block it could not compile and prepares nothing", async () => {
    const result = await prepare({ graph: blocks(survey), catalogs })
    expect(result.valid).toBe(false)
    expect(result.prepared).toBeUndefined()
    expect(result.errors.map((error) => [error.code, error.path])).toEqual([["dag.invalid", "config.blocks[survey]"]])
    expect(messages(result)[0]).toContain(
      'compose block "survey" cannot be compiled: the environment has no agent catalog',
    )
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "survey"])
  })

  it("lets the same graph through under the portable profile, which has no catalog by design", async () => {
    const result = await prepare({ graph: blocks(survey), catalogs, profile: "portable" })
    expect(result.valid).toBe(true)
  })

  it("leaves a graph without compose blocks alone", async () => {
    const result = await prepare({ graph: blocks({ id: "plan", kind: "plan", depends_on: ["map"] }), catalogs })
    expect(result.valid).toBe(true)
  })
})

describe("a graph without composers", () => {
  it("is unaffected: same nodes, valid, prepared", async () => {
    const result = await prepare({
      graph: blocks({ id: "plan", kind: "plan", depends_on: ["map"] }),
      catalogs: environment(),
    })
    expect(result.valid).toBe(true)
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "plan"])
    expect(result.prepared?.nodes.map((node) => node.id)).toEqual(["map", "plan"])
    expect(result.prepared?.nodes.some((node) => node.expand !== undefined)).toBe(false)
  })
})
