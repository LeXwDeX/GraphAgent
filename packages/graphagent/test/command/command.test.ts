// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { BUILTIN_SKILLS } from "@/skill/builtin"
import { SessionPrompt } from "@/session/prompt"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const dagAuto = BUILTIN_SKILLS.find((skill) => skill.name === "dag-auto")
if (!dagAuto) throw new Error("missing dag-auto built-in skill")

const dagAutoSkill: Skill.Info = {
  name: "dag-auto",
  description: dagAuto.description,
  location: "/builtin/dag-auto.md",
  content: dagAuto.content,
  hookSource: "builtin",
}

/** Real Skill + Command layers: /dag-auto is promoted from the built-in
 * skill registry rather than registered explicitly. */
const realLayers = Layer.mergeAll(
  Command.layer.pipe(
    Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({ command: {} } as never) })),
    Layer.provide(Layer.mock(MCP.Service, { prompts: () => Effect.succeed({}) })),
    Layer.provide(Skill.defaultLayer),
  ),
  CrossSpawnSpawner.defaultLayer,
  testInstanceStoreLayer,
)
const real = testEffect(realLayers)

function commandLayer(
  commands: Record<
    string,
    {
      template: string
      description?: string
      agent?: string
      subtask?: boolean
      execution?: "foreground" | "background" | "auto"
    }
  > = {},
  skills: Skill.Info[] = [],
  mcp: Layer.Layer<MCP.Service> = Layer.mock(MCP.Service, {
    prompts: () => Effect.succeed({}),
  }),
) {
  return Layer.mergeAll(
    Command.layer.pipe(
      Layer.provide(
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({ command: commands } as never),
        }),
      ),
      Layer.provide(mcp),
      Layer.provide(
        Layer.mock(Skill.Service, {
          all: () => Effect.succeed(skills),
        }),
      ),
    ),
    testInstanceStoreLayer,
  )
}

const it = testEffect(commandLayer())
const overridden = testEffect(
  commandLayer(
    {
      "dag-auto": {
        description: "Custom DAG auto",
        template: "Custom task:\n$ARGUMENTS",
      },
    },
    [dagAutoSkill],
  ),
)
const withBackgroundCommand = testEffect(
  commandLayer({
    "deep-check": {
      description: "Configured background check",
      template: "Check $ARGUMENTS",
      execution: "background",
    },
    "quick-check": {
      description: "Configured foreground check",
      template: "Check $ARGUMENTS",
      execution: "foreground",
    },
    "plain-check": {
      description: "Configured check without a declaration",
      template: "Check $ARGUMENTS",
    },
  }),
)
const withSkillCommands = testEffect(
  commandLayer({}, [
    dagAutoSkill,
    {
      name: "visible-skill",
      description: "Visible skill.",
      location: "/skills/visible/SKILL.md",
      content: "Visible.",
      // #1040: the real loader now always records a classification, hooks or
      // not; a hookless skill is never left with an undefined one.
      hookSource: "user",
    },
    {
      name: "reference-only",
      description: "Reference-only skill.",
      location: "/skills/reference-only/SKILL.md",
      content: "Reference only.",
      hidden: true,
    },
  ]),
)

describe("legacy command registry", () => {
  it.instance("lists MEMORY as a controller command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("memory")).toMatchObject({
        name: "memory",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      })
    }),
  )

  // #1072: `/remind` is answered by the server without a model turn, like `/memory`
  // and `/dag-mode`: an empty template, one `$ARGUMENTS` hint, no agent or subtask.
  it.instance("lists remind as a controller command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const remind = yield* commands.get("remind")

      expect(remind).toMatchObject({
        name: "remind",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      })
      expect(remind?.description).toContain("list")
      expect(remind?.description).toContain("cancel <id>")
      expect(remind?.agent).toBeUndefined()
      expect(remind?.subtask).toBeUndefined()
      expect(Command.Default.REMIND).toBe("remind")
    }),
  )

  it.instance("does not register the retired trust command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("trust")).toBeUndefined()
    }),
  )

  it.instance("registers import-claude as an interactive command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const command = yield* commands.get("import-claude")

      expect(command).toMatchObject({
        name: "import-claude",
        description: "Review Claude Code config and convert it into .agents/",
        source: "command",
        hints: [],
      })
      expect(command?.subtask).toBeUndefined()
      expect(command?.template).toContain("# Import Claude Configuration")
      expect(yield* commands.get("import-claude-hooks")).toBeUndefined()
    }),
  )

  it.instance("registers review as a background subtask run by the review agent", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const command = yield* commands.get("review")

      expect(command).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        agent: "review",
        subtask: true,
        execution: "background",
      })
      // #1357: the declaration is `execution`; the boolean it replaced is not part of the registry any more.
      expect(command).not.toHaveProperty("background")
    }),
  )

  withBackgroundCommand.instance("keeps the execution declaration of a configured command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("deep-check")).toMatchObject({
        name: "deep-check",
        description: "Configured background check",
        execution: "background",
        source: "command",
      })
      expect((yield* commands.get("quick-check"))?.execution).toBe("foreground")
      expect((yield* commands.get("plain-check"))?.execution).toBeUndefined()
      expect((yield* commands.get("review"))?.execution).toBe("background")
    }),
  )

  withSkillCommands.instance("promotes the dag-auto skill into its own command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const command = yield* commands.get("dag-auto")

      expect(command).toMatchObject({
        name: "dag-auto",
        description: dagAuto.description,
        source: "skill",
        hints: [],
      })
      expect(command?.template).toBe(dagAuto.content)
      for (const name of ["dag-blocks", "dag-nodes", "dag-recovery", "dag-patterns", "dag-policy"]) {
        expect(yield* commands.get(name)).toBeUndefined()
      }
      expect(yield* commands.get("workflow")).toBeUndefined()
    }),
  )

  real.live("loads dag-auto through the real built-in skill registry", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const commands = yield* Command.Service
          const command = yield* commands.get("dag-auto")
          expect(command).toMatchObject({
            name: "dag-auto",
            description: dagAuto.description,
            source: "skill",
            hints: [],
          })
          expect(command?.template).toBe(dagAuto.content)
          for (const name of ["dag-blocks", "dag-nodes", "dag-recovery", "dag-patterns", "dag-policy"]) {
            expect(yield* commands.get(name)).toBeUndefined()
          }
        }),
      { git: true },
    ),
  )

  withSkillCommands.instance("registers visible skills as commands but keeps hidden skills reference-only", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("visible-skill")).toMatchObject({ name: "visible-skill", source: "skill" })
      expect(yield* commands.get("reference-only")).toBeUndefined()
    }),
  )

  // #1040: the command-shell trust gate (`project/trust/command-shell.ts`)
  // reads this provenance off the exact `Info` object `get` returns, to fail
  // closed on a project-owned skill it cannot otherwise enumerate.
  withSkillCommands.instance("keeps a skill-promoted command's trust provenance out of its public shape", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const cmd = yield* commands.get("visible-skill")
      if (!cmd) throw new Error("expected visible-skill command")
      expect(Command.skillCommandOrigin(cmd)).toEqual({ source: "user", location: "/skills/visible/SKILL.md" })
      expect(cmd).not.toHaveProperty("hookSource")
      expect(cmd).not.toHaveProperty("location")
    }),
  )

  testEffect(
    commandLayer({}, [
      {
        name: "project-skill",
        description: "Project-owned skill.",
        location: "/repo/vendor/skills/project-skill/SKILL.md",
        content: "Run !`git tag -l`.",
        hookSource: "project",
      },
    ]),
  ).instance("carries a project skill's hookSource for the command-shell trust gate", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const cmd = yield* commands.get("project-skill")
      if (!cmd) throw new Error("expected project-skill command")
      expect(Command.skillCommandOrigin(cmd)).toEqual({
        source: "project",
        location: "/repo/vendor/skills/project-skill/SKILL.md",
      })
    }),
  )

  it.instance("retires the platform-delivery commands", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("dag-init")).toBeUndefined()
      expect(yield* commands.get("dag-flow")).toBeUndefined()
      expect(yield* commands.get("dag-template-update")).toBeUndefined()
    }),
  )

  // #1031 M1: dispatch uses entry identity to tell the built-in `/dag-mode`
  // behaviour from a user template registered under the same name.
  it.instance("marks built-in registry entries", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      for (const name of [
        Command.Default.DAG_MODE,
        Command.Default.REMIND,
        Command.Default.MEMORY,
        Command.Default.REVIEW,
      ]) {
        const entry = yield* commands.get(name)
        if (!entry) throw new Error(`expected built-in command: ${name}`)
        expect(Command.isBuiltin(entry)).toBe(true)
      }
    }),
  )

  overridden.instance("leaves a user override of a built-in name unmarked", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const override = yield* commands.get("dag-auto")
      if (!override) throw new Error("expected configured dag-auto command")
      expect(override.template).toBe("Custom task:\n$ARGUMENTS")
      expect(Command.isBuiltin(override)).toBe(false)

      const builtin = yield* commands.get(Command.Default.DAG_MODE)
      if (!builtin) throw new Error("expected built-in dag-mode command")
      expect(Command.isBuiltin(builtin)).toBe(true)
    }),
  )

  overridden.instance("allows configured dag-auto commands to override the built-in", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("dag-auto")).toMatchObject({
        description: "Custom DAG auto",
        template: "Custom task:\n$ARGUMENTS",
      })
    }),
  )

  it.effect("appends complete multi-line command arguments to the skill body", () =>
    Effect.sync(() => {
      const input = "Investigate auth\nThen run the focused tests"
      const expanded = SessionPrompt.expandCommandTemplate(dagAuto.content, input)

      expect(expanded).toContain(input)
      expect(expanded.endsWith(input)).toBe(true)
      expect(expanded).not.toContain("$ARGUMENTS")
    }),
  )

  it.effect("offers optional DAG references while preserving requested scope", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(
        dagAuto.content,
        "Use @security-reviewer to review this project. Do not modify files.",
      )

      expect(expanded).toContain('workflow({params:{action:"spec",operation:"list"}})')
      expect(expanded).toContain("Saved workflows are optional references")
      expect(expanded).toContain("ultra-flow-route")
      expect(expanded).toContain("not the default")
      expect(expanded).toContain("Use @security-reviewer to review this project. Do not modify files.")
      expect(expanded.replace(/\s+/g, " ")).toContain(
        "explicit request for direct work or no DAG takes precedence",
      )
      expect(expanded).not.toContain("Template-first for every route")
      expect(expanded).not.toContain("dag-init")
      expect(expanded).not.toContain("`gh ")
      expect(expanded).not.toContain("Ordered merge")
    }),
  )

  it.effect("keeps the blank-arguments form valid", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(dagAuto.content, "")

      expect(expanded).toBe(dagAuto.content)
      expect(expanded).not.toContain("$ARGUMENTS")
    }),
  )
})

// Issue #1575: the real MCP service sits under the Command layer, so an mcp.json that cannot be read reaches
// `mcp.prompts()` as it does in the application. It used to fail the MCP state and, through it, the whole list.
const withRealMcp = testEffect(
  commandLayer({ "user-check": { template: "Check $ARGUMENTS", description: "A user command" } }, [], MCP.defaultLayer),
)

const writeProjectMcp = (text: string) => (directory: string) =>
  Effect.promise(async () => {
    const file = path.join(directory, ".agents", "mcp.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

describe("command registry with an mcp.json that cannot be read", () => {
  for (const [kind, text] of [
    ["a syntax error", "{ not json"],
    ["the removed V1 shape", JSON.stringify({ old: { type: "local", command: ["echo"] } })],
  ] as const) {
    withRealMcp.instance(
      `still lists the built-in and the user commands: ${kind}`,
      () =>
        Effect.gen(function* () {
          const commands = yield* Command.Service
          const names = (yield* commands.list()).map((command) => command.name)

          expect(names).toEqual(
            expect.arrayContaining([
              Command.Default.REVIEW,
              Command.Default.MEMORY,
              Command.Default.DAG_MODE,
              "user-check",
            ]),
          )
          expect((yield* commands.get("user-check"))?.source).toBe("command")
          const review = yield* commands.get(Command.Default.REVIEW)
          if (!review) throw new Error("expected built-in review command")
          expect(Command.isBuiltin(review)).toBe(true)
          expect((yield* commands.list()).filter((command) => command.source === "mcp")).toEqual([])
        }),
      { init: writeProjectMcp(text) },
    )
  }
})
