// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { DagSection } from "@/config/dag-section"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { DagConfig } from "@/dag/config"
import type { NodeConfig } from "@/dag/dag"
import { DagFanOut } from "@/dag/fan-out"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { composerOf, catalog } from "./compose-fixtures"

let dir: string
let projectDir: string
let globalDir: string
const originalConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
const originalHome = process.env.GRAPHAGENT_TEST_HOME
const originalDisableProjectConfig = process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG

beforeEach(async () => {
  // realpath keeps the resolved root comparable with git's real toplevel on
  // macOS, where /var is a symlink to /private/var.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-config-")))
  projectDir = path.join(dir, "project")
  globalDir = path.join(dir, "global")
  await fs.mkdir(projectDir, { recursive: true })
  // Redirect the user-level config dir (Global.Path.config reads the env) so
  // the tests never touch the real one.
  process.env.GRAPHAGENT_CONFIG_DIR = globalDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
  else process.env.GRAPHAGENT_TEST_HOME = originalHome
  if (originalDisableProjectConfig === undefined) delete process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG
  else process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG = originalDisableProjectConfig
  await fs.rm(dir, { recursive: true, force: true })
})

const writeFile = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const writeProjectSettings = (root: string, value: unknown, name = "settings.json") =>
  writeFile(path.join(root, ".agents", name), JSON.stringify(value, null, 2))

const section = (directory: string) => Effect.runPromise(DagSection.dagSection(directory))

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

describe("DagSection.dagSection", () => {
  it("reads the user-level dag section from graphagent.jsonc with comments and trailing commas", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.jsonc"),
      `{
        // model tiers
        "dag": {
          "model": { "advanced": "prov/big", "standard": "prov/small", },
          "thinking_depth": "high",
        },
      }`,
    )
    expect(await section(projectDir)).toEqual({
      model: { advanced: "prov/big", standard: "prov/small" },
      thinking_depth: "high",
    })
  })

  it("lets project settings override user values field by field", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({
        dag: { model: { advanced: "user/big", standard: "user/small" }, thinking_depth: "low" },
      }),
    )
    await writeProjectSettings(projectDir, { dag: { model: { standard: "project/small" } } })
    expect(await section(projectDir)).toEqual({
      model: { advanced: "user/big", standard: "project/small" },
      thinking_depth: "low",
    })
  })

  it("expands {env:} variables in dag values like the main config loader", async () => {
    process.env.DAG_SECTION_TEST_MODEL = "prov/env-model"
    try {
      await writeFile(
        path.join(globalDir, "graphagent.json"),
        JSON.stringify({ dag: { model: { standard: "{env:DAG_SECTION_TEST_MODEL}" } } }),
      )
      expect(await section(projectDir)).toEqual({ model: { standard: "prov/env-model" } })
    } finally {
      delete process.env.DAG_SECTION_TEST_MODEL
    }
  })

  it("ignores project settings when GRAPHAGENT_DISABLE_PROJECT_CONFIG is set", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({ dag: { model: { advanced: "user/big", standard: "user/small" } } }),
    )
    await writeProjectSettings(projectDir, {
      dag: { model: { standard: "project/small" }, thinking_depth: "high" },
    })
    process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG = "1"
    // The user layer survives; no project value leaks through.
    expect(await section(projectDir)).toEqual({ model: { advanced: "user/big", standard: "user/small" } })
  })

  it("applies settings.local.json over settings.json", async () => {
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "low" } })
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "max" } }, "settings.local.json")
    expect(await section(projectDir)).toEqual({ thinking_depth: "max" })
  })

  it("resolves the project root from a nested directory", async () => {
    await writeProjectSettings(projectDir, { dag: { model: { standard: "root/model" } } })
    const nested = path.join(projectDir, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    expect(await section(nested)).toEqual({ model: { standard: "root/model" } })
  })

  it("stops at a linked worktree's own toplevel instead of reading the main checkout", async () => {
    const main = path.join(dir, "repo")
    const linked = path.join(dir, "linked")
    await fs.mkdir(main, { recursive: true })
    git(main, "init")
    git(main, "config", "user.email", "test@graphagent.test")
    git(main, "config", "user.name", "Test")
    git(main, "commit", "--allow-empty", "-m", "init")
    git(main, "worktree", "add", "--detach", linked, "HEAD")
    await writeProjectSettings(main, { dag: { model: { standard: "main/model" } } })

    expect(await section(main)).toEqual({ model: { standard: "main/model" } })

    const nested = path.join(linked, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    expect(await section(nested)).toEqual({})

    await writeProjectSettings(linked, { dag: { model: { advanced: "worktree/model" } } })
    expect(await section(nested)).toEqual({ model: { advanced: "worktree/model" } })
  })

  it("never treats $HOME as a project root", async () => {
    const home = path.join(dir, "home")
    process.env.GRAPHAGENT_TEST_HOME = home
    await writeProjectSettings(home, { dag: { model: { standard: "home/model" } } })
    const nested = path.join(home, "work")
    await fs.mkdir(nested, { recursive: true })
    try {
      expect(await section(home)).toEqual({})
      expect(await section(nested)).toEqual({})
    } finally {
      if (originalHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = originalHome
    }
  })

  it("ignores an invalid section without failing the round", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({ dag: { model: { standard: "user/model" } } }),
    )
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "ultra" } })
    // The invalid project layer is skipped; the valid user layer survives.
    expect(await section(projectDir)).toEqual({ model: { standard: "user/model" } })

    await fs.rm(path.join(projectDir, ".agents"), { recursive: true })
    await writeFile(path.join(globalDir, "graphagent.json"), JSON.stringify({ dag: { thinking_depth: "ultra" } }))
    expect(await section(projectDir)).toEqual({})
  })

  it("is a pure read: no file is created in the config or project directories", async () => {
    await fs.mkdir(globalDir, { recursive: true })
    await writeProjectSettings(projectDir, { dag: { model: { standard: "project/model" } } })

    expect(await section(projectDir)).toEqual({ model: { standard: "project/model" } })
    expect(await fs.readdir(globalDir)).toEqual([])
    expect(await fs.readdir(path.join(projectDir, ".agents"))).toEqual(["settings.json"])
    // No legacy dag.jsonc is seeded anywhere.
    expect((await fs.readdir(projectDir)).sort()).toEqual([".agents"])
  })
})

describe("DagConfig.tierModel", () => {
  const info: DagConfig.Dag = { model: { advanced: "prov/big", standard: "prov/small" } }

  it("routes required nodes to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes review workers to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "review-arch" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes ordinary workers to the standard tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
  })

  it("uses a single configured tier as the unified default", () => {
    const only = { model: { standard: "prov/small" } }
    expect(DagConfig.tierModel(only, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
    const advancedOnly = { model: { advanced: "prov/big" } }
    expect(DagConfig.tierModel(advancedOnly, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  // An empty tier (what uncommenting a placeholder `"advanced": ""` line
  // produces) is unconfigured: the other tier remains the unified default
  // instead of critical/required nodes silently falling through to the
  // worker-agent or parent-session model.
  it("falls back past an empty tier to the configured one", () => {
    const emptyAdvanced = { model: { advanced: "", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(emptyAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(DagConfig.tierModel(emptyAdvanced, { required: false, workerType: "review" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const emptyStandard = { model: { advanced: "anthropic/claude", standard: "" } }
    expect(DagConfig.tierModel(emptyStandard, { required: false, workerType: "build" })).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    })
  })

  it("treats a whitespace-only tier as unconfigured and trims tier components", () => {
    const blankAdvanced = { model: { advanced: " / ", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(blankAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const padded = { model: { standard: " openai / gpt-5 " } }
    expect(DagConfig.tierModel(padded, { required: false, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  it("keeps only the first slash as the provider separator", () => {
    const nested = { model: { standard: "local-proxy-compatible/qwen3.8-max-preview" } }
    expect(DagConfig.tierModel(nested, { required: false, workerType: "explore" })).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "qwen3.8-max-preview",
    })
  })

  it("returns undefined for missing or malformed refs", () => {
    expect(DagConfig.tierModel({}, { required: true, workerType: "build" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "no-slash" } }, { required: false, workerType: "x" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "prov/" } }, { required: false, workerType: "x" })).toBeUndefined()
  })
})
// #1158 PR4a: the tier follows what the node is for. `required` is failure semantics and no longer decides the tier
// of a node that has a role; a node with no role (a hand-written one) keeps the older rule.
describe("DagConfig.tierOf", () => {
  const OBJECTIVE = "Deliver the change"
  const blocks: ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0][] = [
    { id: "map", kind: "explore" },
    { id: "plan", kind: "plan", depends_on: ["map"] },
    { id: "experiment", kind: "prototype", depends_on: ["map"] },
    { id: "bug", kind: "debug", depends_on: ["map"] },
    { id: "build", kind: "coding", depends_on: ["plan", "bug"], fan_out: "plan" },
    { id: "check", kind: "verify", depends_on: ["build", "experiment"] },
    { id: "gate", kind: "review", depends_on: ["check"], skeptics: 1 },
    { id: "report", kind: "synthesize", depends_on: ["gate"] },
  ]
  const route = DagBlocks.compileWorkflowBlocks({
    objective: OBJECTIVE,
    blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block)),
  })
  const byID = (nodes: readonly NodeConfig[], id: string) => {
    const found = nodes.find((node) => node.id === id)
    if (!found) throw new Error(`no node ${id}`)
    return found
  }
  const tierOfNode = (graph: readonly NodeConfig[], id: string, required?: boolean) => {
    const definition = byID(graph, id)
    return DagConfig.tierOf({
      required: required ?? definition.required ?? false,
      workerType: definition.worker_type,
      definition,
      graph,
    })
  }

  it.each([
    ["an explore block", "map", "standard"],
    ["a plan block", "plan", "advanced"],
    ["a prototype writer", "experiment", "standard"],
    ["a debug block's evidence node", "bug--evidence", "standard"],
    ["a debug block's diagnosis", "bug", "advanced"],
    ["a coding writer", "build", "standard"],
    ["a verify block", "check", "advanced"],
    ["a review lane", "gate--standards", "advanced"],
    ["a skeptic lane", "gate--skeptic-1", "advanced"],
    ["a review decision", "gate", "advanced"],
    ["a synthesize block", "report", "advanced"],
    ["the aggregator of parallel writers", "gate--aggregate", "standard"],
  ] as const)("puts %s (%s) on the %s tier", (_label, id, expected) => {
    expect(tierOfNode(route, id)).toBe(expected)
  })

  it("never lets required decide the tier of a block-compiled node", () => {
    for (const node of route) {
      const tiers = [true, false].map((required) => tierOfNode(route, node.id, required))
      expect(new Set(tiers).size, `${node.id} (${node.block})`).toBe(1)
    }
  })

  it("keeps a worker that judges on the advanced tier wherever it sits", () => {
    for (const workerType of ["auditor", "review", "review-arch"]) {
      for (const block of ["explore", "coding", "debug"] as const) {
        const definition = { id: "x", block }
        expect(DagConfig.tierOf({ required: false, workerType, definition }), `${block} on ${workerType}`).toBe(
          "advanced",
        )
      }
    }
    // A worker override on a judging block changes nothing either.
    expect(DagConfig.tierOf({ required: false, workerType: "general", definition: { id: "x", block: "plan" } })).toBe(
      "advanced",
    )
  })

  it("puts the generated fan-out writers on the standard tier and keeps the writer's required", () => {
    const writer = byID(route, "build")
    const expansion = DagFanOut.planFanOut(
      writer,
      {
        summary: "s",
        packages: [
          { id: "api", instruction: "api", write_set: ["src/api"] },
          { id: "ui", instruction: "ui", write_set: ["src/ui"] },
        ],
      },
      new Set(),
    )
    if (expansion.kind !== "expand") throw new Error("expected an expansion")
    const graph = [...route.filter((node) => node.id !== "build"), ...expansion.nodes]
    expect(expansion.nodes.map((node) => [node.id, node.required, tierOfNode(graph, node.id)])).toEqual([
      ["build--api", true, "standard"],
      ["build--ui", true, "standard"],
      // The aggregator is a helper the engine generated: standard, though it is as required as its writers.
      ["build", true, "standard"],
    ])
  })

  describe("a compose expansion", () => {
    const expand = (survey: { required?: boolean } = {}, items: unknown[]) => {
      const nodes = DagCompose.compileNodes(
        DagBlocks.compileWorkflowBlocks({
          objective: OBJECTIVE,
          blocks: [new DagBlocks.WorkflowBlock({ id: "survey", kind: "compose", worker_type: "surveyor", ...survey })],
        }),
        catalog(),
        DagCompose.DEFAULT_LIMITS,
      ).nodes
      const result = DagCompose.planExpansion({
        slot: byID(nodes, "survey"),
        composer: composerOf("surveyor"),
        limits: DagCompose.DEFAULT_LIMITS,
        source: { status: "completed", output: { rationale: "r", items, not_planned: [] } },
        existingNodeIDs: new Set(nodes.map((node) => node.id)),
      })
      return { compiled: nodes, expansion: result }
    }
    const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
      id,
      agent,
      instruction: `Look into ${id}`,
      ...extra,
    })

    it("puts the split node, the slot and the join node on the advanced tier", () => {
      const { compiled, expansion } = expand({}, [item("code", "explore"), item("official", "researcher")])
      expect(byID(compiled, "survey--split").generated_helper).toBe("split")
      // The split node is optional and the slot is too: the tier does not come from required.
      expect(byID(compiled, "survey--split").required).toBe(false)
      expect(tierOfNode(compiled, "survey--split")).toBe("advanced")
      expect(byID(compiled, "survey").expand).toBe("survey--split")
      expect(tierOfNode(compiled, "survey")).toBe("advanced")
      expect(tierOfNode(compiled, "survey", true)).toBe("advanced")
      const graph = [byID(compiled, "survey--split"), ...expansion.nodes]
      expect(byID(graph, "survey").join).toBeDefined()
      expect(tierOfNode(graph, "survey")).toBe("advanced")
    })

    it("puts the children on the standard tier, required or not", () => {
      const { compiled, expansion } = expand({ required: true }, [
        item("code", "explore"),
        item("official", "researcher", { required: true }),
      ])
      const graph = [byID(compiled, "survey--split"), ...expansion.nodes]
      expect(expansion.kind).toBe("expand")
      // A required item of a required block compiles to a required child, which is still a standard-tier worker.
      expect(byID(graph, "survey--official").required).toBe(true)
      expect(tierOfNode(graph, "survey--official")).toBe("standard")
      expect(byID(graph, "survey--code").required).toBe(false)
      expect(tierOfNode(graph, "survey--code")).toBe("standard")
    })

    it("puts the one fallback worker of a degraded expansion on the standard tier", () => {
      const { compiled } = expand({ required: true }, [])
      const degraded = DagCompose.degrade(byID(compiled, "survey"), composerOf("surveyor"), "the plan has no items")
      const graph = [byID(compiled, "survey--split"), ...degraded.nodes]
      expect(byID(graph, "survey--fallback").required).toBe(true)
      expect(tierOfNode(graph, "survey--fallback")).toBe("standard")
      expect(tierOfNode(graph, "survey")).toBe("advanced")
    })

    it("keeps a child that is an auditor on the advanced tier, since judging work is advanced wherever it sits", () => {
      const { compiled, expansion } = expand({}, [item("security", "auditor"), item("code", "explore")])
      const graph = [byID(compiled, "survey--split"), ...expansion.nodes]
      expect(tierOfNode(graph, "survey--security")).toBe("advanced")
      expect(tierOfNode(graph, "survey--code")).toBe("standard")
    })

    it("tells a child by the join node that names it, not by its id", () => {
      const { compiled, expansion } = expand({}, [item("code", "explore")])
      const graph = [byID(compiled, "survey--split"), ...expansion.nodes]
      expect(DagConfig.isComposeChild(graph, "survey--code")).toBe(true)
      expect(DagConfig.isComposeChild(graph, "survey")).toBe(false)
      expect(DagConfig.isComposeChild(graph, "elsewhere")).toBe(false)
      expect(DagConfig.isComposeChild(undefined, "survey--code")).toBe(false)
      // A node that looks like a child, but no join names it, is a hand-written node.
      const stray: NodeConfig = { ...byID(graph, "survey--code"), id: "survey--stray", required: true }
      expect(tierOfNode([...graph, stray], "survey--stray")).toBe("advanced")
      expect(tierOfNode([...graph, { ...stray, required: false }], "survey--stray")).toBe("standard")
    })

    it("puts a compose block that was not compiled into a split and a slot on the advanced tier", () => {
      const block = DagBlocks.compileWorkflowBlocks({
        objective: OBJECTIVE,
        blocks: [new DagBlocks.WorkflowBlock({ id: "survey", kind: "compose", worker_type: "surveyor" })],
      })
      expect(tierOfNode(block, "survey")).toBe("advanced")
    })
  })

  describe("a hand-written node", () => {
    const hand = (overrides: Partial<NodeConfig> = {}): NodeConfig => ({
      id: "hand",
      name: "hand",
      worker_type: "general",
      depends_on: [],
      prompt_template: { inline: "work" },
      ...overrides,
    })

    it("keeps the older rule: required takes the advanced tier", () => {
      expect(tierOfNode([hand({ required: true })], "hand")).toBe("advanced")
      expect(tierOfNode([hand({ required: false })], "hand")).toBe("standard")
      expect(tierOfNode([hand({ required: false, worker_type: "plan" })], "hand")).toBe("standard")
      expect(tierOfNode([hand({ required: true, worker_type: "explore" })], "hand")).toBe("advanced")
    })

    it("takes review and auditor workers to the advanced tier without being required", () => {
      expect(tierOfNode([hand({ worker_type: "review-arch" })], "hand", false)).toBe("advanced")
      expect(tierOfNode([hand({ worker_type: "auditor" })], "hand", false)).toBe("advanced")
    })

    it("has no role when the caller knows only the worker", () => {
      expect(DagConfig.tierOf({ required: true, workerType: "build" })).toBe("advanced")
      expect(DagConfig.tierOf({ required: false, workerType: "build" })).toBe("standard")
    })
  })

  it("picks the configured model of the tier a role calls for, and falls back across tiers", () => {
    const both: DagConfig.Dag = { model: { advanced: "prov/big", standard: "prov/small" } }
    const build = byID(route, "build")
    const plan = byID(route, "plan")
    const pick = (info: DagConfig.Dag, definition: NodeConfig) =>
      DagConfig.tierModel(info, {
        required: definition.required ?? false,
        workerType: definition.worker_type,
        definition,
        graph: route,
      })
    // The writer is required by default and still takes the standard model;
    // the plan takes the advanced one, optional or not.
    expect(build.required).toBe(true)
    expect(pick(both, build)).toEqual({ providerID: "prov", modelID: "small" })
    expect(pick(both, { ...plan, required: false })).toEqual({ providerID: "prov", modelID: "big" })
    // One configured tier serves every role.
    expect(pick({ model: { advanced: "prov/big" } }, build)).toEqual({ providerID: "prov", modelID: "big" })
    expect(pick({ model: { standard: "prov/small" } }, plan)).toEqual({ providerID: "prov", modelID: "small" })
    expect(pick({}, build)).toBeUndefined()
  })
})
