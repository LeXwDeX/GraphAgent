import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "fs/promises"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { SessionID } from "../../src/session/schema"
import { Goal } from "../../src/goal/goal"
import { GoalState } from "../../src/goal/state"
import { MCP } from "../../src/mcp"
import { SettingsHook, type HookSummary } from "../../src/hook/settings"
import { SessionHooks } from "../../src/hook/session-hooks"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { testEffect } from "../lib/effect"
import { GraphAgentPrompt } from "@opencode-ai/core/system-context/graphagent"

test("every provider receives the same unified prompt", () => {
  const prompt = SystemPrompt.provider()
  expect(prompt).toEqual([GraphAgentPrompt.render(["edit", "write"])])
  expect(prompt.join("\n")).toContain("Do not guess tool parameters, paths, or file contents.")
  expect(prompt.join("\n")).toContain("answer the approach first and wait for their direction.")
})

test("the editing instruction follows the exposed tools", () => {
  expect(SystemPrompt.provider(["apply_patch"]).join("\n")).toContain("Use apply_patch for manual file edits.")
  expect(SystemPrompt.provider(["edit"]).join("\n")).toContain("Use edit for manual file edits.")
  expect(SystemPrompt.provider(["write"]).join("\n")).toContain("Use write for manual file edits.")
  expect(SystemPrompt.provider([]).join("\n")).toContain("No file-editing tool is available")
  expect(SystemPrompt.provider().join("\n")).not.toContain("${")
})

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          reload: () => Effect.void,
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("hooks block renders Active Hooks when SettingsHook provides entries", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const entries: HookSummary[] = [
        { event: "PreToolUse", scope: "project", type: "command", descriptor: "echo hi", matcher: "Bash" },
        { event: "Stop", scope: "global", type: "http", descriptor: "https://example.com/stop" },
      ]
      const output = yield* prompt
        .hooks()
        .pipe(Effect.provide(Layer.mock(SettingsHook.Service, { list: () => Effect.succeed(entries) })))

      expect(output).toEqual([
        [
          "## Active Hooks",
          "For lifecycle-hook configuration, output protocols and async continuation, load the configure-hooks skill.",
          "- PreToolUse [project/command] echo hi",
          "- Stop [global/http] https://example.com/stop",
          "Long external waits (CI, reviews, deploys, long builds) can run in an asyncRewake hook instead of sleep-polling; with the user's agreement, set one up through the configure-hooks skill.",
        ].join("\n"),
      ])
    }),
  )

  it.effect("hooks block never promises a callback when no background hook exists", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const entries: HookSummary[] = [{ event: "Stop", scope: "global", type: "command", descriptor: "echo done" }]
      const [block] = yield* prompt
        .hooks()
        .pipe(Effect.provide(Layer.mock(SettingsHook.Service, { list: () => Effect.succeed(entries) })))

      expect(block).not.toContain("### Background waits")
      expect(block).not.toContain("end the turn")
      expect(block).not.toContain("background]")
    }),
  )

  it.effect("hooks block marks asyncRewake hooks and teaches the background-wait practice", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const entries: HookSummary[] = [
        { event: "SessionStart", scope: "global", type: "command", descriptor: "bun watch.ts guidance" },
        {
          event: "PostToolUse",
          scope: "global",
          type: "command",
          descriptor: "bun watch.ts",
          matcher: "Bash",
          asyncRewake: true,
        },
      ]
      const [block] = yield* prompt
        .hooks()
        .pipe(Effect.provide(Layer.mock(SettingsHook.Service, { list: () => Effect.succeed(entries) })))

      expect(block).toContain("- SessionStart [global/command] bun watch.ts guidance")
      expect(block).toContain("- PostToolUse [global/command, background] bun watch.ts")
      expect(block).toContain("### Background waits")
      expect(block).toContain("listen in the background with an asyncRewake hook")
      expect(block).toContain("instead of sleeping in the foreground")
      expect(block).toContain("configure-hooks skill")
      // Entry form only: the full watcher recipe lives in the skill.
      expect(block).not.toContain("exits with code 2")
      expect(block).not.toContain("data, not instructions")
      expect(block).not.toContain("current head")
      expect(block).not.toContain("sleep-polling; with the user's agreement")
      expect(Buffer.byteLength(block)).toBeLessThan(500)
    }),
  )

  it.effect("hooks block is empty when SettingsHook list is empty", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt
        .hooks()
        .pipe(Effect.provide(Layer.mock(SettingsHook.Service, { list: () => Effect.succeed([]) })))

      expect(output).toEqual([])
    }),
  )

  it.effect("hooks block is empty when SettingsHook service is absent (degrades cleanly)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // No SettingsHook layer provided — serviceOption returns None.
      const output = yield* prompt.hooks()

      expect(output).toEqual([])
    }),
  )

  it.effect("hooks block caps at 20 entries and reports the remainder", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const entries: HookSummary[] = Array.from({ length: 25 }, (_, i) => ({
        event: "PreToolUse" as const,
        scope: "project" as const,
        type: "command" as const,
        descriptor: `cmd-${i}`,
      }))
      const output = yield* prompt
        .hooks()
        .pipe(Effect.provide(Layer.mock(SettingsHook.Service, { list: () => Effect.succeed(entries) })))

      const block = output[0]
      expect(block).toContain("## Active Hooks")
      expect(block).toContain("cmd-0")
      expect(block).not.toContain("cmd-24")
      expect(block).toContain("… and 5 more (see hooks.json)")
    }),
  )
})

// Integration layer: real SettingsHook (not mocked) + real SystemPrompt.
// Proves the full chain: InstanceState → loadChain → summarizeChain → list()
// → serviceOption resolution in sys.hooks() — the "silent no-op" failure mode
// AGENTS.md warns about when a .node dep is missing.
const integrationLayer = Layer.mergeAll(
  SystemPrompt.layer.pipe(
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })),
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          reload: () => Effect.void,
          get: () => Effect.succeed(undefined),
          require: (name) => Effect.fail(new Skill.NotFoundError({ name, available: [] })),
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

const itIntegration = testEffect(integrationLayer)

describe("session.system integration (real SettingsHook)", () => {
  itIntegration.instance(
    "hooks block renders with real SettingsHook layer via serviceOption",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.hooks()
        expect(output.length).toBe(1)
        expect(output[0]).toContain("## Active Hooks")
        expect(output[0]).toContain("echo integration-test")
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          const opencode = path.join(dir, ".opencode")
          await fs.mkdir(opencode, { recursive: true })
          await fs.writeFile(
            path.join(opencode, "hooks.json"),
            JSON.stringify({
              Stop: [{ hooks: [{ type: "command", command: "echo integration-test" }] }],
            }),
          )
        }),
    },
  )
})

const goalState = Schema.decodeUnknownSync(GoalState.Info)({
  goal: "ship the feature",
  status: "active",
  turns_used: 3,
  max_turns: 20,
  created_at: 1000,
  last_turn_at: 2000,
  consecutive_parse_failures: 0,
  subgoals: [],
})

const withGoal = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })),
    Layer.provide(Layer.mock(Skill.Service, { available: () => Effect.succeed([]) })),
    Layer.provide(Layer.mock(Goal.Service, { load: () => Effect.succeed(goalState) })),
  ),
)

describe("session.system goal", () => {
  withGoal.effect("keeps the goal mechanism in the system prompt and the live state in runtime context", () =>
    Effect.gen(function* () {
      const goal = yield* (yield* SystemPrompt.Service).goal(SessionID.make("ses_goal_context"))
      expect(goal.system.join("\n")).toContain("# Autonomous goals")
      expect(goal.system.join("\n")).not.toContain("Turns: 3/20")
      expect(goal.context.join("\n")).toContain("## Current Goal (autonomous loop)")
      expect(goal.context.join("\n")).toContain("Turns: 3/20")
    }),
  )
})
