import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_GOAL from "./prompt/goal.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Goal } from "@/goal/goal"
import { GoalPrompts } from "@/goal/prompts"
import { SettingsHook } from "@/hook/settings"
import { Memory } from "@/memory/memory"
import type { SessionID } from "@/session/schema"
import { editingInstruction, editingTools } from "@/tool/editing-tools"

export function provider(model: Provider.Model, tools: readonly string[] = editingTools(model.api.id)) {
  const id = model.api.id.toLowerCase()
  if (id.includes("gpt-4") || /(^|\/)o[13](?:$|[-.])/.test(id)) return [PROMPT_BEAST]
  if (id.includes("gpt")) {
    if (id.includes("codex")) {
      return [PROMPT_CODEX.replace("${editingInstruction}", () => editingInstruction(tools))]
    }
    return [PROMPT_GPT.replace("${editingInstruction}", () => editingInstruction(tools))]
  }
  if (id.includes("gemini-")) return [PROMPT_GEMINI]
  if (id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (id.includes("trinity")) return [PROMPT_TRINITY]
  if (id.includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
  /** `system` is constant while a goal stays active or paused; `context` is the live state for this request. */
  readonly goal: (sessionID: SessionID) => Effect.Effect<{ system: string[]; context: string[] }>
  readonly hooks: () => Effect.Effect<string[]>
  readonly memory: (input: {
    sessionID: SessionID
    messages: SessionV1.WithParts[]
    main: boolean
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap
    // Goal.Service is resolved lazily (serviceOption) rather than declared as a
    // hard construction dependency: SystemPrompt.layer itself stays buildable in
    // compositions that omit Goal (bare test harnesses) and degrades to the
    // terse "no active goal" note. Production compositions always provide Goal
    // (defaultLayer and the LayerNode deps below), so the goal block renders.
    const goalSvc = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `Configured model ID: ${model.providerID}/${model.id}. Provider API model ID: ${model.api.id}.`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),

      goal: Effect.fn("SystemPrompt.goal")(function* (sessionID: SessionID) {
        // No Goal service wired into this entry point → degrade to a terse note.
        const none = { system: ["No autonomous goal is active for this session."], context: [] }
        if (!goalSvc) return none
        const state = yield* goalSvc.load(sessionID)
        // Only active/paused goals carry a live-state block. `done` is transient
        // (auto-cleared) and treated the same as "no goal" here.
        if (!state || (state.status !== "active" && state.status !== "paused")) return none
        // Active/paused: the trimmed static mechanism + the live-state block.
        // The mechanism is intentionally NOT injected when no goal is active, to
        // avoid prompt bloat (spec: no-active-goal-injected-as-terse-note).
        // The live state changes every goal turn, so it goes to the runtime context, not the system prefix.
        return { system: [PROMPT_GOAL], context: [GoalPrompts.renderGoalSystemBlock(state)] }
      }),

      // Active Hooks block — dynamic, mirrors goal's economy: no hooks → empty
      // array (no header, no placeholder). SettingsHook is resolved at request
      // time via serviceOption (per tool-service-resolution spec) so headless /
      // test entry points that omit the heavyweight service degrade cleanly.
      hooks: Effect.fn("SystemPrompt.hooks")(function* () {
        const hookSvc = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
        if (!hookSvc) return []
        const hooks = yield* hookSvc.list()
        if (hooks.length === 0) return []
        const MAX = 20
        const shown = hooks.slice(0, MAX)
        const lines = [
          "## Active Hooks",
          "For lifecycle-hook configuration, output protocols and async continuation, load the configure-hooks skill.",
          ...shown.map((h) => `- ${h.event} [${h.scope}/${h.type}] ${h.descriptor}`),
        ]
        if (hooks.length > MAX) lines.push(`… and ${hooks.length - MAX} more (see hooks.json)`)
        return [lines.join("\n")]
      }),

      memory: Effect.fn("SystemPrompt.memory")(function* (input) {
        if (!input.main) return []
        const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
        if (!memory) return []
        yield* memory.prepare({ sessionID: input.sessionID, messages: input.messages })
        return yield* memory.context(input.sessionID)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [Skill.node, MCP.node, Goal.node, Memory.node, locationServiceMapNode])

export * as SystemPrompt from "./system"
