import { describe, expect } from "bun:test"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { Effect, Layer } from "effect"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { SessionPrompt } from "@/session/prompt"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function commandLayer(commands: Record<string, { template: string; description?: string }> = {}) {
  return Layer.mergeAll(
    Command.layer.pipe(
      Layer.provide(
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({ command: commands } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(MCP.Service, {
          prompts: () => Effect.succeed({}),
        }),
      ),
      Layer.provide(
        Layer.mock(Skill.Service, {
          all: () => Effect.succeed([]),
        }),
      ),
    ),
    testInstanceStoreLayer,
  )
}

const it = testEffect(commandLayer())
const overridden = testEffect(
  commandLayer({
    "dag-auto": {
      description: "Custom DAG auto",
      template: "Custom task:\n$ARGUMENTS",
    },
  }),
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

  it.instance("does not register the retired trust command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("trust")).toBeUndefined()
    }),
  )

  it.instance("registers the canonical dag-auto command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const command = yield* commands.get("dag-auto")

      expect(command).toMatchObject({
        name: "dag-auto",
        description: CommandPlugin.DagAutoDescription,
        source: "command",
        template: CommandPlugin.DagAutoContent,
        hints: ["$ARGUMENTS"],
      })
      expect(yield* commands.get("workflow")).toBeUndefined()
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

  overridden.instance("allows configured dag-auto commands to override the built-in", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("dag-auto")).toMatchObject({
        description: "Custom DAG auto",
        template: "Custom task:\n$ARGUMENTS",
      })
    }),
  )

  it.effect("preserves complete multi-line command arguments", () =>
    Effect.sync(() => {
      const input = "Investigate auth\nThen run the focused tests"
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagAutoContent, input)

      expect(expanded).toContain(`Arguments: ${input}`)
      expect(expanded).not.toContain("$ARGUMENTS")
    }),
  )

  it.effect("offers optional DAG references while preserving requested scope", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(
        CommandPlugin.DagAutoContent,
        "Use @security-reviewer to review this project. Do not modify files.",
      )

      expect(expanded).toContain('workflow(action="list")')
      expect(expanded).toContain("Saved workflows are optional references")
      expect(expanded).toContain("ultra-flow-route")
      expect(expanded).toContain("not the default")
      expect(expanded).toContain("Use @security-reviewer to review this project. Do not modify files.")
      expect(expanded).toContain("explicit request for direct work or no DAG takes precedence")
      expect(expanded).not.toContain("Template-first for every route")
      expect(expanded).not.toContain("dag-init")
      expect(expanded).not.toContain("`gh ")
      expect(expanded).not.toContain("Ordered merge")
    }),
  )

  it.effect("keeps the blank-arguments form valid", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagAutoContent, "")

      expect(expanded).toContain("Arguments:")
      expect(expanded).not.toContain("$ARGUMENTS")
    }),
  )
})
