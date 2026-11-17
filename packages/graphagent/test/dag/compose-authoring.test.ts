// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3a: what the Workflow Authoring Check does with a compose block and
// with a node whose worker is a composer. The check compiles both with the agent
// catalog at hand, reports a composer that cannot be used and why, and, until the
// runtime can expand an expansion slot, refuses to submit the graph.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagCompose } from "@/dag/compose"
import type { DagValidation } from "@/dag/validation"
import { agent, agents, writerRules } from "./compose-fixtures"

const GATE = "compose 的运行时展开尚未启用（#1158 PR3b）"

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
  it("compiles, and is refused only by the gate: nothing else about the graph is wrong", async () => {
    const result = await prepare({ graph: blocks(survey) })
    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => [error.code, error.path])).toEqual([["dag.invalid", "config.blocks[survey]"]])
    expect(messages(result)[0]).toContain(GATE)
    expect(messages(result)[0]).toContain('compose block "survey"')
    // The graph that was checked is the compiled one, split node and slot included.
    expect(result.nodes.map((node) => [node.id, node.worker_type, node.depends_on, node.has_output_schema])).toEqual([
      ["map", "explore", [], false],
      ["survey--split", "surveyor", ["map"], true],
      ["survey", "surveyor", ["survey--split"], true],
    ])
    expect(result.prepared).toBeUndefined()
  })

  it("is refused under the strict gate for the gate alone, not for being a write-capable worker", async () => {
    const result = await prepare({ graph: blocks(survey), review_gate: "strict" })
    expect(messages(result)).toHaveLength(1)
    expect(messages(result)[0]).toContain(GATE)
  })

  it("lets the blocks after it depend on it", async () => {
    const result = await prepare({
      graph: blocks(survey, { id: "decide", kind: "synthesize", depends_on: ["survey"] }),
    })
    expect(messages(result)).toHaveLength(1)
    expect(result.nodes.find((node) => node.id === "decide")?.depends_on).toEqual(["survey"])
  })

  it("is refused in an extend and in a replan fragment as well", async () => {
    const extend = await prepare({ action: "extend", graph: { objective: OBJECTIVE, blocks: [survey] } })
    expect(messages(extend)).toHaveLength(1)
    expect(messages(extend)[0]).toContain(GATE)
    const replan = await prepare({ action: "replan", graph: blocks(survey) })
    expect(messages(replan)).toHaveLength(1)
    expect(messages(replan)[0]).toContain(GATE)
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

  it("compiles to the same split node and slot, and is refused by the gate alone", async () => {
    const result = await prepare({ graph: { nodes: [node] } })
    expect(result.errors.map((error) => [error.code, error.path])).toEqual([["dag.invalid", "nodes[survey]"]])
    expect(messages(result)[0]).toContain(GATE)
    expect(messages(result)[0]).toContain('composer node "survey"')
    expect(result.nodes.map((entry) => entry.id)).toEqual(["survey--split", "survey"])
  })

  it("is an ordinary node when its worker is not a composer", async () => {
    const result = await prepare({ graph: { nodes: [{ ...node, worker_type: "researcher" }] } })
    expect(result.valid).toBe(true)
    expect(result.nodes.map((entry) => entry.id)).toEqual(["survey"])
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
    expect(result.errors.find((error) => error.path === "config.blocks[survey].worker_type")).toMatchObject({
      code: "dag.invalid",
      message: 'compose block "survey": agent "researcher" is not a composer',
    })
    // The block was not compiled, so the gate refuses it as well.
    expect(messages(result).some((message) => message.includes(GATE))).toBe(true)
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
    expect(usable.errors.some((error) => error.path === "config.blocks[map-repo].worker_type")).toBe(false)
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
})

describe("under the portable profile", () => {
  it("has no catalog, so a compose block compiles to its one node and is refused by the gate alone", async () => {
    const result = await prepare({ graph: blocks(survey), profile: "portable" })
    expect(result.errors.map((error) => [error.code, error.path])).toEqual([["dag.invalid", "config.blocks[survey]"]])
    expect(messages(result)[0]).toContain(GATE)
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "survey"])
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
  it("leaves the compose block as one node and lets the gate refuse it", async () => {
    const result = await prepare({
      graph: blocks(survey),
      catalogs: { worker_types: new Set(["explore", "surveyor"]) },
    })
    expect(result.errors.map((error) => error.path)).toEqual(["config.blocks[survey]"])
    expect(result.nodes.map((node) => node.id)).toEqual(["map", "survey"])
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
