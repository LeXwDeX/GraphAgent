// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Agent } from "../../src/agent/agent"
import { AgentArtifact } from "../../src/agent/artifact"
import { AgentContract } from "../../src/agent/contract"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * The built-in composers `surveyor` and `mapper` (#1158): what they declare, what they may do, and what their
 * system prompts tell them. A composer plans an expansion and joins its results; the engine runs the workers, so
 * neither has a shell, the web or a file tool (D4). The prompts the DAG builds around them (the split and join
 * prompts) are pinned in test/dag/compose-builtin.test.ts.
 */

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

const agentNamed = (name: string) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service.use((svc) => svc.get(name))
    if (!agent) throw new Error(`Expected the ${name} agent`)
    return agent
  })

const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action

const COMPOSERS = ["surveyor", "mapper"] as const

/** The part of a prompt under the heading `# <title>`, up to the next heading. */
const section = (prompt: string, title: string) => {
  const start = prompt.indexOf(`# ${title}\n`)
  if (start === -1) throw new Error(`no "# ${title}" section`)
  const rest = prompt.slice(start + title.length + 3)
  const next = rest.search(/^# /m)
  return next === -1 ? rest : rest.slice(0, next)
}

it.instance("each composer is a native subagent that cannot be mistaken for a worker", () =>
  Effect.gen(function* () {
    for (const name of COMPOSERS) {
      const composer = yield* agentNamed(name)
      expect(composer.native, name).toBe(true)
      expect(composer.mode, name).toBe("subagent")
      expect(composer.hidden, name).toBeUndefined()
      expect(AgentContract.isComposer(composer), name).toBe(true)
      // The workflow catalog shows this line to the model that writes a compose block.
      expect(composer.description ?? "", name).toContain("compose block")
      expect(composer.description ?? "", name).toContain("never a task type")
      expect(composer.prompt?.length ?? 0, name).toBeGreaterThan(0)
    }
  }),
)

it.instance("the surveyor fans a question out to the read-only workers and joins a survey_report", () =>
  Effect.gen(function* () {
    const surveyor = yield* agentNamed("surveyor")
    expect(surveyor.contract).toEqual({
      role: "composer",
      visibility: "private",
      output: { artifact: "survey_report" },
      compose: { pattern: "fan_out", dispatch: ["researcher", "explore"], fallback: "researcher" },
    })
    expect(AgentArtifact.has("survey_report")).toBe(true)
    const agents = yield* Agent.Service.use((svc) => svc.list())
    expect(AgentContract.composerAvailability(agents, "surveyor")).toEqual({
      available: true,
      dispatch: ["researcher", "explore"],
    })
  }),
)

it.instance("the mapper splits a codebase recursively over explore and joins a project_map", () =>
  Effect.gen(function* () {
    const mapper = yield* agentNamed("mapper")
    expect(mapper.contract).toEqual({
      role: "composer",
      visibility: "private",
      output: { artifact: "project_map" },
      compose: { pattern: "recursive_split", dispatch: ["explore"], fallback: "explore" },
    })
    expect(AgentArtifact.has("project_map")).toBe(true)
    const agents = yield* Agent.Service.use((svc) => svc.list())
    expect(AgentContract.composerAvailability(agents, "mapper")).toEqual({ available: true, dispatch: ["explore"] })
  }),
)

it.instance("a composer reads the repository and nothing else: no shell, no web, no file tool, no dispatch", () =>
  Effect.gen(function* () {
    for (const name of COMPOSERS) {
      const composer = yield* agentNamed(name)
      for (const allowed of ["read", "grep", "glob", "skill", "serena_initial_instructions"]) {
        expect(action(composer, allowed), `${name} ${allowed}`).toBe("allow")
      }
      for (const denied of [
        "bash",
        "webfetch",
        "websearch",
        "edit",
        "lsp",
        "task",
        "todowrite",
        "question",
        "plan_exit",
        "some_mcp_tool",
      ]) {
        expect(action(composer, denied), `${name} ${denied}`).toBe("deny")
      }
      // `write` and `apply_patch` share the `edit` permission.
      expect(Permission.evaluate("edit", "src/index.ts", composer.permission).action, name).toBe("deny")
      expect(Permission.evaluate("edit", "prototypes/x/a.ts", composer.permission).action, name).toBe("deny")
      // Reading outside the project asks, like the other read-only workers.
      expect(Permission.evaluate("external_directory", "/some/other/path", composer.permission).action, name).toBe(
        "ask",
      )
      expect(AgentContract.isWriterAgent(composer), name).toBe(false)
      // A composer that cannot write has the defaults of a read-only agent, and is never a dispatch target.
      expect(AgentContract.effective(composer), name).toMatchObject({
        role: "composer",
        visibility: "private",
        failure: "skip",
      })
    }
  }),
)

it.instance("the surveyor's prompt plans by angle or candidate and joins by comparison", () =>
  Effect.gen(function* () {
    const prompt = (yield* agentNamed("surveyor")).prompt ?? ""
    expect(prompt).toContain("You never do the research yourself")
    const planning = section(prompt, "Planning")
    expect(planning).toContain("one angle on the question, or one candidate answer")
    expect(planning).toContain("researcher")
    expect(planning).toContain("explore")
    expect(planning).toContain("do not invent them")
    expect(planning).toContain("Mark an item required only when the conclusion cannot stand without it")
    expect(planning).toContain("not_planned")
    const joining = section(prompt, "Joining")
    expect(joining).toContain("Compare, do not concatenate")
    expect(joining).toContain("not_examined")
    expect(joining).toContain("A missing result is never covered work")
    // Each phase says nothing of the other's job.
    expect(planning).not.toContain("not_examined")
    expect(joining).not.toContain("not_planned")
    expect(prompt).toContain("Do not ask the user questions")
  }),
)

it.instance(
  "the mapper's prompt looks before it splits, splits again only what is too large, and joins by module",
  () =>
    Effect.gen(function* () {
      const prompt = (yield* agentNamed("mapper")).prompt ?? ""
      expect(prompt).toContain("You never map the modules yourself")
      const planning = section(prompt, "Planning")
      expect(planning).toContain("Look before you split")
      expect(planning).toContain("split: true")
      expect(planning).toContain("Do not split what one worker can read")
      expect(planning).toContain("not_planned")
      const joining = section(prompt, "Joining")
      expect(joining).toContain("already comes back as a project map")
      expect(joining).toContain("cross_cutting")
      expect(joining).toContain("not_examined")
      expect(joining).toContain("Do not invent modules")
      expect(prompt).toContain("Do not ask the user questions")
    }),
)

it.instance("only the mapper's prompt offers a recursive split, as only its plan schema has one", () =>
  Effect.gen(function* () {
    expect((yield* agentNamed("surveyor")).prompt ?? "").not.toContain("split: true")
    expect((yield* agentNamed("mapper")).prompt ?? "").toContain("split: true")
  }),
)

// The whole system prompt of each composer, which is what the engine's split and join prompts (pinned in
// test/dag/compose-builtin.test.ts) are read against: planning and joining are the two halves of it.
for (const name of COMPOSERS) {
  it.instance(`${name} system prompt`, () =>
    Effect.gen(function* () {
      const prompt = (yield* agentNamed(name)).prompt ?? ""
      // Both halves are there, as sections of their own.
      expect(section(prompt, "Planning").length).toBeGreaterThan(0)
      expect(section(prompt, "Joining").length).toBeGreaterThan(0)
      expect(prompt).toMatchSnapshot()
    }),
  )
}

it.instance(
  "a user who opens edit for the researcher takes the surveyor's fallback away, and the surveyor with it",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((svc) => svc.list())
      const surveyor = AgentContract.composerAvailability(agents, "surveyor")
      expect(surveyor.available).toBe(false)
      if (surveyor.available) return
      expect(surveyor.reason).toContain('composer "surveyor" is unavailable')
      expect(surveyor.reason).toContain('fallback "researcher" cannot be expanded')
      // The mapper dispatches to explore alone and is untouched.
      expect(AgentContract.composerAvailability(agents, "mapper")).toEqual({ available: true, dispatch: ["explore"] })
    }),
  { config: { agent: { researcher: { permission: { edit: "allow" } } } } },
)
