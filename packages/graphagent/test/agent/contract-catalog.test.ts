// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { AgentContract } from "../../src/agent/contract"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { DagBlocks } from "../../src/dag/blocks"
import { DagEnvironmentCatalogs } from "../../src/dag/environment-catalogs"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
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

const load = <A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) => Agent.Service.use(fn)

const render = (part: unknown) => (typeof part === "string" ? part : JSON.stringify(part))

/** Runs `effect` and returns the warnings the catalog logged while it ran. */
const warnings = <A>(effect: Effect.Effect<A, never, Agent.Service>) =>
  Effect.gen(function* () {
    const lines: string[] = []
    const logger = Logger.make((options) => {
      if (options.logLevel !== "Warn") return
      const parts: unknown[] = Array.isArray(options.message) ? options.message : [options.message]
      lines.push(parts.map(render).join(" "))
    })
    const result = yield* effect.pipe(Effect.withLogger(logger))
    return { result, lines }
  })

const effectiveByName = (agents: Agent.Info[]) =>
  Object.fromEntries(agents.map((agent) => [agent.name, AgentContract.effective(agent)]))

it.instance("built-in agents carry the contracts the Issue assigns them", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const declared = Object.fromEntries(agents.map((agent) => [agent.name, agent.contract]))

    // `explore` keeps free-text task calls: its artifact is for composed runs (`output.task: false`).
    expect(declared.explore).toEqual({
      role: "worker",
      visibility: "public",
      output: { artifact: "code_findings", task: false },
    })
    // The auditor's output is the DAG review lane's schema (#1031), not a catalog artifact.
    expect(declared.auditor).toEqual({ role: "worker", visibility: "public", failure: "fail" })
    expect(declared.review).toEqual({ role: "worker", visibility: "private" })
    expect(declared.researcher).toEqual({
      role: "worker",
      visibility: "public",
      output: { artifact: "research_findings" },
    })
    expect(declared.architect).toEqual({
      role: "worker",
      visibility: "public",
      output: { artifact: "architecture_proposal" },
    })
    // The prototyper writes, so it is private; its failure is derived, not declared.
    expect(declared.prototyper).toEqual({ role: "worker", visibility: "private", output: { artifact: "prototype" } })
    // Everything else declares nothing and takes the defaults.
    for (const name of ["build", "plan", "general", "compaction", "title", "summary"]) {
      expect(declared[name]).toBeUndefined()
    }
  }),
)

it.instance("effective contract snapshot of the built-in catalog", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    expect(effectiveByName(agents)).toEqual({
      build: { role: "worker", visibility: "private", failure: "fail" },
      general: { role: "worker", visibility: "private", failure: "fail" },
      // plan edits only its own plan file and is a read-only profile for the DAG.
      plan: { role: "worker", visibility: "private", failure: "skip" },
      explore: {
        role: "worker",
        visibility: "public",
        failure: "skip",
        output: { artifact: "code_findings", task: false },
      },
      review: { role: "worker", visibility: "private", failure: "skip" },
      auditor: { role: "worker", visibility: "public", failure: "fail" },
      // The other workers leave `output.task` out, so task calls owe their artifact: the effective view says so.
      researcher: {
        role: "worker",
        visibility: "public",
        failure: "skip",
        output: { artifact: "research_findings", task: true },
      },
      architect: {
        role: "worker",
        visibility: "public",
        failure: "skip",
        output: { artifact: "architecture_proposal", task: true },
      },
      // A writer: its failure is the workflow's failure.
      prototyper: {
        role: "worker",
        visibility: "private",
        failure: "fail",
        output: { artifact: "prototype", task: true },
      },
      compaction: { role: "worker", visibility: "private", failure: "skip" },
      title: { role: "worker", visibility: "private", failure: "skip" },
      summary: { role: "worker", visibility: "private", failure: "skip" },
    })
  }),
)

it.instance("a clean catalog logs no contract diagnostics", () =>
  Effect.gen(function* () {
    const { result, lines } = yield* warnings(load((svc) => svc.list()))
    expect(AgentContract.diagnose(result)).toEqual([])
    expect(lines.filter((line) => line.includes("contract") || line.includes("public"))).toEqual([])
  }),
)

it.instance(
  "a user override inherits the built-in contract and rewrites it field by field",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      const review = yield* load((svc) => svc.get("review"))
      const auditor = yield* load((svc) => svc.get("auditor"))
      // `failure` is added; role, visibility and the artifact, with its opt-out of task calls, are inherited.
      expect(explore?.contract).toEqual({
        role: "worker",
        visibility: "public",
        failure: "fail",
        output: { artifact: "code_findings", task: false },
      })
      // `visibility` is rewritten; the inherited role stays.
      expect(review?.contract).toEqual({ role: "worker", visibility: "public" })
      expect(AgentContract.effective(review!).visibility).toBe("public")
      // An override that never mentions the contract keeps it whole.
      expect(auditor?.contract).toEqual({ role: "worker", visibility: "public", failure: "fail" })
    }),
  {
    config: {
      agent: {
        explore: { contract: { failure: "fail" } },
        review: { contract: { visibility: "public" } },
        auditor: { description: "Custom auditor" },
      },
    },
  },
)

it.instance(
  "a configured agent declares a full contract, and the key never leaks into options",
  () =>
    Effect.gen(function* () {
      const panel = yield* load((svc) => svc.get("panel"))
      expect(panel?.contract).toEqual({
        role: "composer",
        visibility: "private",
        output: { artifact: "survey_report" },
        compose: { pattern: "fan_out", dispatch: ["explore", "auditor"], fallback: "explore" },
      })
      expect(panel?.options).not.toHaveProperty("contract")
      expect(AgentContract.isComposer(panel!)).toBe(true)
      const agents = yield* load((svc) => svc.list())
      expect(AgentContract.composerAvailability(agents, "panel")).toEqual({
        available: true,
        dispatch: ["explore", "auditor"],
      })
    }),
  {
    config: {
      agent: {
        panel: {
          mode: "subagent",
          description: "Fans a question out to read-only workers",
          contract: {
            role: "composer",
            visibility: "private",
            output: { artifact: "survey_report" },
            compose: { pattern: "fan_out", dispatch: ["explore", "auditor"], fallback: "explore" },
          },
        },
      },
    },
  },
)

it.instance("an agent markdown file declares its contract in the frontmatter", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, ".agents", "agents", "triage.md"),
        `---\ndescription: Triage worker\nmode: subagent\npermission:\n  "*": deny\n  read: allow\ncontract:\n  role: worker\n  visibility: public\n  failure: fail\n---\nTriage prompt\n`,
      ),
    )
    const triage = yield* load((svc) => svc.get("triage"))
    if (!triage) throw new Error("Expected the triage agent")
    expect(triage.contract).toEqual({ role: "worker", visibility: "public", failure: "fail" })
    expect(triage.options).not.toHaveProperty("contract")
    // Read-only under its own rules, so the declared public visibility holds.
    expect(AgentContract.effective(triage)).toEqual({ role: "worker", visibility: "public", failure: "fail" })
  }),
)

it.instance(
  "a user override that restates explore's output owes the artifact to task calls again",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      if (!explore) throw new Error("Expected the explore agent")
      // `output` is replaced as a unit: the opt-out was part of the built-in declaration, so it goes with it.
      expect(explore.contract?.output).toEqual({ artifact: "code_findings" })
      expect(AgentContract.effective(explore).output).toEqual({ artifact: "code_findings", task: true })
      expect(AgentContract.taskArtifact(explore)).toBe("code_findings")
    }),
  { config: { agent: { explore: { contract: { output: { artifact: "code_findings" } } } } } },
)

it.instance(
  "a user override can keep or restore the opt-out explicitly",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      const scribe = yield* load((svc) => svc.get("scribe"))
      if (!explore || !scribe) throw new Error("Expected the agents")
      expect(AgentContract.taskArtifact(explore)).toBeUndefined()
      expect(AgentContract.effective(explore).output).toEqual({ artifact: "code_findings", task: false })
      expect(AgentContract.taskArtifact(scribe)).toBeUndefined()
      expect(AgentContract.effective(scribe).output).toEqual({ artifact: "project_map", task: false })
    }),
  {
    config: {
      agent: {
        explore: { contract: { output: { artifact: "code_findings", task: false } } },
        scribe: {
          mode: "subagent",
          description: "Maps a codebase in free text",
          contract: { output: { artifact: "project_map", task: false } },
        },
      },
    },
  },
)

it.instance(
  "an agent that declares an artifact the catalog does not hold is diagnosed and logged",
  () =>
    Effect.gen(function* () {
      const { result: agents, lines } = yield* warnings(load((svc) => svc.list()))
      const diagnostics = AgentContract.diagnose(agents)
      expect(diagnostics.map((item) => [item.agent, item.code])).toEqual([["oddity", "artifact_unknown"]])
      expect(diagnostics[0]?.message).toContain('agent "oddity"')
      expect(diagnostics[0]?.message).toContain('"no_such_type"')
      expect(diagnostics[0]?.message).toContain("code_findings")
      // The same sentence reaches the log channel when the catalog is built.
      expect(lines.some((line) => line.includes('agent "oddity" declares output artifact "no_such_type"'))).toBe(true)
    }),
  {
    config: {
      agent: {
        oddity: {
          mode: "subagent",
          description: "Declares an artifact the catalog does not have",
          contract: { output: { artifact: "no_such_type" } },
        },
      },
    },
  },
)

it.instance("a user explore.md that opens edit makes explore private and is diagnosed", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // The user-level override the Issue describes: same name as the built-in,
    // permission widened. Only the permission block and prompt are theirs.
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, ".agents", "agents", "explore.md"),
        `---\npermission:\n  edit: allow\n---\nMy explore prompt\n`,
      ),
    )

    const { result: agents, lines } = yield* warnings(load((svc) => svc.list()))
    const explore = agents.find((agent) => agent.name === "explore")
    if (!explore) throw new Error("Expected the explore agent")

    // The declaration is inherited untouched; the effective view downgrades it.
    expect(explore.contract).toEqual({
      role: "worker",
      visibility: "public",
      output: { artifact: "code_findings", task: false },
    })
    expect(AgentContract.effective(explore).visibility).toBe("private")

    const diagnostics = AgentContract.diagnose(agents)
    expect(diagnostics.map((item) => [item.agent, item.code])).toEqual([["explore", "public_writable"]])
    expect(diagnostics[0]?.message).toContain('"explore" was overridden to allow writing files')

    // The same sentence reaches the log channel when the catalog is built.
    expect(lines.some((line) => line.includes('"explore" was overridden to allow writing files'))).toBe(true)
  }),
)

it.instance(
  "a global permission that opens edit downgrades every public agent",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const effective = effectiveByName(agents)
      for (const name of ["explore", "auditor", "researcher", "architect"]) {
        expect(effective[name]?.visibility, name).toBe("private")
      }
      // The prototyper and review declared private already: nothing to diagnose for them.
      expect(AgentContract.diagnose(agents).map((item) => item.agent)).toEqual([
        "architect",
        "auditor",
        "explore",
        "researcher",
      ])
    }),
  { config: { permission: { edit: "allow" } } },
)

it.instance(
  "a composer turns unavailable when the override takes its only dispatch target away",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, ".agents", "agents", "explore.md"),
          `---\npermission:\n  edit: allow\n---\nMy explore prompt\n`,
        ),
      )
      const { result: agents, lines } = yield* warnings(load((svc) => svc.list()))
      const availability = AgentContract.composerAvailability(agents, "panel")
      expect(availability.available).toBe(false)
      if (availability.available) return
      expect(availability.reason).toContain('composer "panel" is unavailable')
      expect(availability.reason).toContain('"explore" was overridden to allow writing files')
      expect(lines.some((line) => line.includes('composer "panel" is unavailable'))).toBe(true)
      expect(AgentContract.diagnose(agents).map((item) => [item.agent, item.code])).toEqual([
        ["explore", "public_writable"],
        ["panel", "composer_unavailable"],
      ])
    }),
  {
    config: {
      agent: {
        panel: {
          mode: "subagent",
          description: "Fans a question out to explore only",
          contract: {
            role: "composer",
            compose: { pattern: "fan_out", dispatch: ["explore"], fallback: "explore" },
          },
        },
      },
    },
  },
)

it.instance(
  "the new read-only workers are expandable dispatch targets; the writer never is",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      expect(AgentContract.composerAvailability(agents, "scout")).toEqual({
        available: true,
        dispatch: ["researcher", "architect", "explore"],
      })
      const blocked = AgentContract.composerAvailability(agents, "forge")
      expect(blocked.available).toBe(false)
      if (blocked.available) return
      expect(blocked.reason).toContain('composer "forge" is unavailable')
      expect(blocked.reason).toContain('agent "prototyper" can write files')
      // Only the unusable composer is diagnosed; the built-in workers are not.
      expect(AgentContract.diagnose(agents).map((item) => [item.agent, item.code])).toEqual([
        ["forge", "composer_unavailable"],
      ])
    }),
  {
    config: {
      agent: {
        scout: {
          mode: "subagent",
          description: "Fans a question out to the read-only workers",
          contract: {
            role: "composer",
            compose: { pattern: "fan_out", dispatch: ["researcher", "architect", "explore"], fallback: "researcher" },
          },
        },
        forge: {
          mode: "subagent",
          description: "Tries to dispatch the prototyper",
          contract: {
            role: "composer",
            compose: { pattern: "fan_out", dispatch: ["prototyper"], fallback: "prototyper" },
          },
        },
      },
    },
  },
)

it.instance("the DAG's static read-only profile list covers every visible built-in agent that cannot write", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    // A built-in that cannot write but is missing from the static list would be treated as a writer by
    // the plan-agent gate, the strict gate and default isolation: register it in `READ_ONLY_PROFILES`.
    const missing = agents
      .filter((agent) => agent.native === true && agent.hidden !== true)
      .filter((agent) => !AgentContract.isWriterAgent(agent) && !DagBlocks.isReadOnlyProfile(agent.name))
      .map((agent) => agent.name)
    expect(missing).toEqual([])
    // And the other way: nothing in the list is a built-in that can write.
    const writers = agents.filter((agent) => agent.native === true && AgentContract.isWriterAgent(agent))
    expect(writers.filter((agent) => DagBlocks.isReadOnlyProfile(agent.name)).map((agent) => agent.name)).toEqual([])
  }),
)

it.instance(
  "the DAG writer catalog and the agent contract use one writer definition",
  () =>
    Effect.gen(function* () {
      const svc = yield* Agent.Service
      const test = yield* TestInstance
      const provider = yield* Provider.Service
      const environment = yield* DagEnvironmentCatalogs.makeCatalogLoader(svc, provider)({ directory: test.directory })
      const agents = yield* svc.list()
      const writers = agents.filter((agent) => AgentContract.isWriterAgent(agent)).map((agent) => agent.name)
      expect([...(environment.writer_types ?? [])].toSorted()).toEqual(writers.toSorted())
      // The reopened explore is a writer for both; the untouched read-only agents are for neither.
      expect(writers).toContain("explore")
      expect(writers).not.toContain("auditor")
      expect(writers).not.toContain("plan")
      // The prototyper's edit window is a pattern-scoped allow: it still writes. The read-only workers do not.
      expect(writers).toContain("prototyper")
      expect(writers).not.toContain("researcher")
      expect(writers).not.toContain("architect")
      // Every block's default worker is a real catalog entry, so a bare `prototype` block validates.
      for (const kind of DagBlocks.WORKFLOW_BLOCK_KINDS) {
        expect(environment.worker_types?.has(DagBlocks.defaultBlockWorker(kind)), kind).toBe(true)
      }
    }),
  { config: { agent: { explore: { permission: { edit: "allow" } } } } },
)
