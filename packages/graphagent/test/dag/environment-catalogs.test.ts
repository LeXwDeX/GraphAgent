// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { DagEnvironmentCatalogs } from "@/dag/environment-catalogs"
import { DagValidation } from "@/dag/validation"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const open = Permission.fromConfig({ "*": "allow" })
const readOnly = Permission.merge(
  open,
  Permission.fromConfig({ "*": "deny", read: "allow", grep: "allow", glob: "allow", bash: "allow" }),
)

const info = (name: string, permission: Agent.Info["permission"], contract?: Agent.Info["contract"]): Agent.Info => ({
  name,
  mode: "subagent",
  permission,
  options: {},
  ...(contract ? { contract } : {}),
})

const catalog: Agent.Info[] = [
  info("build", open),
  info("general", Permission.merge(open, Permission.fromConfig({ todowrite: "deny" }))),
  // plan keeps an edit allow-list for its plan file and is a read-only profile.
  info("plan", Permission.merge(open, Permission.fromConfig({ edit: { "*": "deny", ".agents/plans/*.md": "allow" } }))),
  info("explore", readOnly, { visibility: "public", output: { artifact: "code_findings", task: false } }),
  info("auditor", Permission.merge(readOnly, Permission.fromConfig({ edit: "deny" }))),
  // A read-only agent that a user rule re-opened: a blanket deny, then `edit: allow`.
  info("reopened", Permission.merge(readOnly, Permission.fromConfig({ edit: "allow" })), { visibility: "public" }),
  // #1158: composers. `surveyor` can expand into the public read-only explore; `stuck` only into the re-opened agent.
  info("surveyor", readOnly, {
    role: "composer",
    output: { artifact: "survey_report" },
    compose: { pattern: "fan_out", dispatch: ["explore", "reopened"], fallback: "explore" },
  }),
  info("stuck", readOnly, {
    role: "composer",
    compose: { pattern: "fan_out", dispatch: ["reopened"], fallback: "reopened" },
  }),
]

// The loader only lists the catalog; every other method is out of scope here.
const agents: Agent.Interface = {
  permissionPolicy: () => Effect.die("not used"),
  get: () => Effect.die("not used"),
  list: () => Effect.succeed(catalog),
  defaultInfo: () => Effect.die("not used"),
  defaultAgent: () => Effect.die("not used"),
  generate: () => Effect.die("not used"),
}

const it = testEffect(ProviderTest.fake().layer)

const load = Effect.gen(function* () {
  const provider = yield* Provider.Service
  return yield* DagEnvironmentCatalogs.makeCatalogLoader(agents, provider)({ directory: process.cwd() })
})

describe("DAG environment catalogs", () => {
  it.effect("worker_types lists every agent in the catalog", () =>
    Effect.gen(function* () {
      const environment = yield* load
      expect([...(environment.worker_types ?? [])].toSorted()).toEqual(
        ["auditor", "build", "explore", "general", "plan", "reopened", "stuck", "surveyor"].toSorted(),
      )
    }),
  )

  it.effect("writer_types holds exactly the agents whose rules let them edit files", () =>
    Effect.gen(function* () {
      const environment = yield* load
      expect([...(environment.writer_types ?? [])].toSorted()).toEqual(["build", "general", "reopened"])
    }),
  )

  // #1158: the same load carries the composers, judged against this catalog.
  it.effect("composers holds every composer, and says which of them can run", () =>
    Effect.gen(function* () {
      const composers = (yield* load).composers
      expect([...(composers?.composers.keys() ?? [])].toSorted()).toEqual(["stuck", "surveyor"])
      expect(composers?.agents.has("explore")).toBe(true)
      const surveyor = composers ? DagCompose.resolve(composers, "surveyor") : undefined
      expect(surveyor?.available).toBe(true)
      // reopened writes now, so only explore is left to dispatch to.
      if (surveyor?.available) expect(surveyor.composer.dispatch.map((worker) => worker.name)).toEqual(["explore"])
      const stuck = composers ? DagCompose.resolve(composers, "stuck") : undefined
      expect(stuck?.available).toBe(false)
      if (stuck && !stuck.available) expect(stuck.reason).toContain('composer "stuck" is unavailable')
    }),
  )
})

// #1158 PR4a: the model check asks for the tier a node's role calls for, the same one the loop runs it on. The
// advanced tier here names a model the provider does not have, so a node resolves exactly when its role is standard.
describe("DAG environment catalogs: model resolution follows the node role", () => {
  const tiers = { dag: { model: { advanced: "ghost/ghost", standard: "openai/gpt-5.2" } } }

  const prepare = Effect.gen(function* () {
    const test = yield* TestInstance
    const provider = yield* Provider.Service
    const environment = yield* DagEnvironmentCatalogs.makeCatalogLoader(agents, provider)({ directory: test.directory })
    const blocks: ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0][] = [
      { id: "map", kind: "explore", required: true },
      { id: "design", kind: "plan", required: false },
      { id: "build", kind: "coding" },
    ]
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver the change",
      blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block)),
    }).concat(
      {
        id: "hand-required",
        name: "hand required",
        worker_type: "general",
        depends_on: [],
        required: true,
        prompt_template: { inline: "work" },
      },
      {
        id: "hand-optional",
        name: "hand optional",
        worker_type: "general",
        depends_on: [],
        required: false,
        prompt_template: { inline: "work" },
      },
    )
    return { environment, nodes, directory: test.directory }
  })

  it.instance(
    "resolves a node against the tier its definition calls for",
    () =>
      Effect.gen(function* () {
        const { environment, nodes } = yield* prepare
        const resolves = (id: string) => {
          const node = nodes.find((candidate) => candidate.id === id)!
          return environment.resolveModel!({
            id,
            worker_type: node.worker_type,
            required: node.required ?? false,
            definition: node,
            graph: nodes,
          })
        }
        // Exploring and writing are standard (which resolves) even when required; judging is advanced (ghost) even when optional.
        expect(yield* resolves("map")).toBe(true)
        expect(yield* resolves("build")).toBe(true)
        expect(yield* resolves("design")).toBe(false)
        // A hand-written node follows required, as it always has.
        expect(yield* resolves("hand-required")).toBe(false)
        expect(yield* resolves("hand-optional")).toBe(true)
      }),
    { config: tiers },
  )

  it.instance(
    "reaches the same answer through the environment diagnostics of a graph",
    () =>
      Effect.gen(function* () {
        const { environment, nodes, directory } = yield* prepare
        const diagnostics = yield* DagValidation.environmentDiagnostics({ nodes, directory, catalogs: environment })
        expect(
          diagnostics
            .filter((entry) => entry.code === DagValidation.DIAGNOSTIC_CODES.modelUnavailable)
            .map((entry) => entry.path),
        ).toEqual(["nodes[design]", "nodes[hand-required]"])
      }),
    { config: tiers },
  )
})
