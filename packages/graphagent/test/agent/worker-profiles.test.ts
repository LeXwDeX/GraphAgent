// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Agent } from "../../src/agent/agent"
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
 * The permission profiles of the first-batch workers (#1158): researcher,
 * architect and prototyper. A profile is only its rules, so each case is a
 * question put to the effective rule set the Agent service returns, the same
 * evaluation `Permission.ask` makes before any tool runs.
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

// Every key the profiles below are compared on. `edit` also stands for `write` and `apply_patch`.
const KEYS = [
  "read",
  "grep",
  "glob",
  "bash",
  "webfetch",
  "websearch",
  "lsp",
  "skill",
  "serena_initial_instructions",
  "edit",
  "task",
  "todowrite",
  "question",
  "plan_exit",
  "some_mcp_tool",
]

const profile = (agent: Agent.Info) => Object.fromEntries(KEYS.map((key) => [key, action(agent, key)]))

it.instance("the researcher reads, searches and fetches; it has no shell and cannot write", () =>
  Effect.gen(function* () {
    const researcher = yield* agentNamed("researcher")
    expect(researcher.mode).toBe("subagent")
    expect(researcher.native).toBe(true)
    expect(researcher.prompt?.length ?? 0).toBeGreaterThan(0)

    for (const allowed of ["read", "grep", "glob", "webfetch", "websearch", "skill", "serena_initial_instructions"]) {
      expect(action(researcher, allowed), allowed).toBe("allow")
    }
    // `bash` and `edit` (which `write` and `apply_patch` share) are refused outright.
    for (const denied of ["bash", "edit", "lsp", "task", "todowrite", "question", "plan_exit", "some_mcp_tool"]) {
      expect(action(researcher, denied), denied).toBe("deny")
    }
    expect(Permission.evaluate("bash", "ls -la", researcher.permission).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/index.ts", researcher.permission).action).toBe("deny")
    expect(Permission.permissionName("write")).toBe("edit")
    expect(Permission.permissionName("apply_patch")).toBe("edit")
    // Reading outside the project asks, like the other read-only workers.
    expect(Permission.evaluate("external_directory", "/some/other/path", researcher.permission).action).toBe("ask")
    expect(AgentContract.isWriterAgent(researcher)).toBe(false)
  }),
)

it.instance("the researcher's prompt covers a runtime without websearch and the limits of the role", () =>
  Effect.gen(function* () {
    const prompt = (yield* agentNamed("researcher")).prompt ?? ""
    // Without websearch it works from known addresses with webfetch, and says so under not examined.
    expect(prompt).toContain("websearch")
    expect(prompt).toContain("webfetch")
    expect(prompt).toMatch(/not available/)
    expect(prompt).toMatch(/did not examine/)
    // Every claim carries its source; disagreeing sources are reported, not resolved silently.
    expect(prompt).toMatch(/Cite every claim/)
    expect(prompt).toMatch(/disagree/)
    // The role cannot change files, and the prompt does not pretend otherwise.
    expect(prompt).toMatch(/no shell and cannot change files/)
  }),
)

it.instance("the architect's and prototyper's prompts keep to their roles", () =>
  Effect.gen(function* () {
    const architect = (yield* agentNamed("architect")).prompt ?? ""
    expect(architect).toMatch(/Do not split the work into packages/)
    expect(architect).toMatch(/lsp/)
    const prototyper = (yield* agentNamed("prototyper")).prompt ?? ""
    expect(prototyper).toContain("prototypes/<slug>/")
    expect(prototyper).toMatch(/hypothesis and the success signal/)
    expect(prototyper).toMatch(/Do not change product code/)
  }),
)

it.instance("the architect has the explore profile plus the language server, and cannot write", () =>
  Effect.gen(function* () {
    const explore = yield* agentNamed("explore")
    const architect = yield* agentNamed("architect")
    expect(architect.mode).toBe("subagent")
    expect(architect.native).toBe(true)
    expect(architect.prompt?.length ?? 0).toBeGreaterThan(0)

    expect(profile(architect)).toEqual({ ...profile(explore), lsp: "allow" })
    expect(action(architect, "lsp")).toBe("allow")
    expect(action(architect, "bash")).toBe("allow")
    expect(Permission.evaluate("edit", "src/index.ts", architect.permission).action).toBe("deny")
    expect(Permission.evaluate("edit", "prototypes/x/a.ts", architect.permission).action).toBe("deny")
    expect(
      Permission.evaluate("external_directory", "/some/other/path", architect.permission).action,
      "reads outside the project ask, as for explore",
    ).toBe("ask")
    expect(AgentContract.isWriterAgent(architect)).toBe(false)
  }),
)

it.instance(
  "the prototyper writes only under prototypes/ and may run what it builds",
  () =>
    Effect.gen(function* () {
      const prototyper = yield* agentNamed("prototyper")
      expect(prototyper.mode).toBe("subagent")
      expect(prototyper.native).toBe(true)
      expect(prototyper.prompt?.length ?? 0).toBeGreaterThan(0)

      // Inside the node workspace's prototypes/ directory an edit passes.
      for (const path of ["prototypes/lru-cache/replay.ts", "prototypes/a.ts", "prototypes/a/b/c/d.json"]) {
        expect(Permission.evaluate("edit", path, prototyper.permission).action, path).toBe("allow")
      }
      // Everywhere else it is refused: product code, tests, config, lookalike directories, other roots.
      for (const path of [
        "src/index.ts",
        "package.json",
        ".env",
        "prototypes-old/a.ts",
        "my-prototypes/a.ts",
        "docs/prototypes/a.ts",
        "../other/prototypes/a.ts",
        "/etc/hosts",
        "prototypes",
      ]) {
        expect(Permission.evaluate("edit", path, prototyper.permission).action, path).toBe("deny")
      }

      // The shell runs the prototype; shell access is not a sandbox, so the rule is bash: allow.
      expect(action(prototyper, "bash")).toBe("allow")
      expect(action(prototyper, "task")).toBe("deny")
      expect(action(prototyper, "todowrite")).toBe("deny")
      expect(action(prototyper, "question")).toBe("deny")
      expect(action(prototyper, "some_mcp_tool")).toBe("deny")
      expect(AgentContract.isWriterAgent(prototyper)).toBe(true)
    }),
  { git: true },
)

it.instance("outside the edit window the prototyper's profile is explore's", () =>
  Effect.gen(function* () {
    const explore = yield* agentNamed("explore")
    const prototyper = yield* agentNamed("prototyper")
    const { edit: _edit, ...rest } = profile(prototyper)
    const { edit: _exploreEdit, ...exploreRest } = profile(explore)
    expect(rest).toEqual(exploreRest)
  }),
)

it.instance(
  "a user who reopens edit for the researcher turns it into a writer, and its public contract with it",
  () =>
    Effect.gen(function* () {
      const researcher = yield* agentNamed("researcher")
      expect(AgentContract.isWriterAgent(researcher)).toBe(true)
      expect(AgentContract.effective(researcher).visibility).toBe("private")
      expect(AgentContract.effective(researcher).failure).toBe("fail")
    }),
  { config: { agent: { researcher: { permission: { edit: "allow" } } } } },
)

describe("the prototyper's write window follows the execution directory", () => {
  test("it is prototypes/ under the directory, named relative to the worktree", () => {
    expect(Agent.prototypeEditPattern("/repo", "/repo")).toBe("prototypes/**")
    expect(Agent.prototypeEditPattern("/repo", "/repo/packages/demo")).toBe("packages/demo/prototypes/**")
    // A directory outside the worktree has no worktree-relative name.
    expect(Agent.prototypeEditPattern("/repo", "/elsewhere")).toBe("prototypes/**")
  })

  test("in a subdirectory the files the tools ask for pass, and the root prototypes/ does not", () => {
    const rules = Permission.fromConfig({
      edit: { "*": "deny", [Agent.prototypeEditPattern("/repo", "/repo/packages/demo")]: "allow" },
    })
    // write/edit/apply_patch ask with the path relative to the worktree.
    expect(Permission.evaluate("edit", "packages/demo/prototypes/experiment.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "prototypes/experiment.ts", rules).action).toBe("deny")
    expect(Permission.evaluate("edit", "packages/demo/src/index.ts", rules).action).toBe("deny")
  })
})
