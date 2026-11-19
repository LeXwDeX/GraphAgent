import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Context, Effect, Layer, Option } from "effect"

import { InstanceState } from "@/effect/instance-state"

import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { ROOT_ONLY_SKILLS } from "@/skill/builtin"
import { AbsolutePath } from "@graphagent/core/schema"
import { Location } from "@graphagent/core/location"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Reference } from "@graphagent/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Goal } from "@/goal/goal"
import { GoalPrompts } from "@/goal/prompts"
import { SettingsHook } from "@/hook"
import { Memory } from "@/memory/memory"
import type { SessionID } from "@/session/schema"
import type { Lane } from "@/session/agent-scheduler-state"
import { GraphAgentPrompt } from "@graphagent/core/system-context/graphagent"
import { Injection } from "@graphagent/core/system-context/injection"
import { resolveLanguage } from "@graphagent/core/config/language"
import { RequestCache } from "./request-cache"

/**
 * Every model receives the same prompt. The only substitution is the editing
 * instruction, which names the editing tools actually exposed for this request.
 */
export function provider(tools: readonly string[] = ["edit", "write"]) {
  return [GraphAgentPrompt.render(tools)]
}

/**
 * The goal section of the system prompt. It is the same text whether or not a goal exists, so creating or
 * clearing a goal never changes the cached prefix; the goal's live state travels in the runtime context.
 */
export const GOAL_NOTE =
  'Autonomous goals are managed with the goal tool. When a goal exists, its live state is the latest "Current Goal" block in a <runtime_context> message.'

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  /** Default reply language; `configured` is the `language` config value. */
  readonly language: (configured?: string) => Effect.Effect<string[]>
  readonly skills: (
    agent: Agent.Info,
    permission?: PermissionV1.Ruleset,
    nativePermission?: PermissionV1.Ruleset,
    /** `root: false` leaves out the skills that record how to use tools only a root session has (#1457). */
    options?: { readonly root?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly mcp: (
    agent: Agent.Info,
    permission?: PermissionV1.Ruleset,
    nativePermission?: PermissionV1.Ruleset,
  ) => Effect.Effect<string | undefined>
  /** `system` is always `[GOAL_NOTE]`, with or without a goal; `context` is the live state for this request. */
  readonly goal: (sessionID: SessionID) => Effect.Effect<{ system: string[]; context: string[] }>
  readonly hooks: () => Effect.Effect<string[]>
  readonly memory: (input: {
    sessionID: SessionID
    messages: SessionV1.WithParts[]
    main: boolean
    /** Lane of the triggering turn; memory model calls inherit it. */
    lane?: Lane
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SystemPrompt") {}

// Entry-form practice for asyncRewake hooks, rendered inside Active Hooks so it
// costs nothing when no hooks are configured. The full recipe lives in the
// configure-hooks skill; platform-neutral on purpose.
const BACKGROUND_WAITS = [
  "### Background waits",
  "For GitHub or GitLab PR/MR checks, a PR created with `gh pr create` is watched automatically; the notice arrives after the current turn ends. Use the watch_pr tool to register, query, or cancel a watch by hand.",
  "For other long external results, use an asyncRewake watcher from the configure-hooks skill instead of sleeping or polling in the foreground.",
  "A listed hook is not a running watch: rely on a callback only after confirming a watch started for the exact target and head.",
  "A callback is delivery, not evidence; query the current head's checks before reporting or merging.",
].join("\n")

const BACKGROUND_WAITS_HINT =
  "For GitHub or GitLab PR/MR waits, a PR created with `gh pr create` is watched automatically and the notice arrives after the current turn ends; register, query, or cancel watches with the watch_pr tool. For other long external waits (CI, reviews, deploys, long builds), set up an asyncRewake watcher through the configure-hooks skill with the user's agreement. Confirm the watch started; a callback is delivery, not evidence, so query the current head before reporting or merging."

const STOP_GUARD_POINTER =
  "For an end-of-turn check of a dirty worktree or unpushed commits, use the configure-hooks skill's stop-guard recipe."

const GIT_GUARD_POINTER =
  "To reduce accidental force pushes or hard resets, use the configure-hooks skill's git-guard recipe."

/**
 * The most bytes of one MCP server's instructions that go into the system prompt. A third-party server states its
 * own usage notes at whatever length it likes; what is over this is cut and the block says so.
 */
export const MCP_INSTRUCTIONS_MAX_BYTES = 2048

/** The longest prefix of `text` that fits `max` UTF-8 bytes, cut between characters: a surrogate pair stays whole. */
function headBytes(text: string, max: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > max) break
    end += char.length
  }
  return text.slice(0, end)
}

/** One server's usage notes as a block. Over the limit they are cut, with a line that says so, and logged. */
const mcpBlock = Effect.fnUntraced(function* (item: { readonly name: string; readonly instructions: string }) {
  const bytes = Buffer.byteLength(item.instructions)
  if (bytes <= MCP_INSTRUCTIONS_MAX_BYTES) {
    return Injection.wrap("mcp-instructions", item.instructions, { server: item.name })
  }
  yield* Effect.logWarning("mcp instructions truncated", {
    server: item.name,
    bytes,
    limit: MCP_INSTRUCTIONS_MAX_BYTES,
  })
  const shown = headBytes(item.instructions, MCP_INSTRUCTIONS_MAX_BYTES)
  const note = `[truncated: this server's instructions are ${bytes} bytes; the first ${Buffer.byteLength(shown)} bytes are shown]`
  return Injection.wrap("mcp-instructions", `${shown}\n${note}`, { server: item.name })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap
    // Goal.Service is resolved lazily (serviceOption) rather than declared as a
    // hard construction dependency: SystemPrompt.layer itself stays buildable in
    // compositions that omit Goal (bare test harnesses) and degrades to the
    // constant GOAL_NOTE with no live state. Production compositions always
    // provide Goal (defaultLayer and the LayerNode deps below), so the live
    // goal block renders in the runtime context.
    const goalSvc = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))

    // Request-invariant prompt fragments (language, skills, MCP). Keys are
    // content-derived, so a changed skill list or server instruction misses;
    // layer-local, so disposal releases the memory.
    const fragments = RequestCache.make<{ readonly text: string }>(4 * 1024 * 1024)

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
            `  Platform: ${process.platform}`,
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

      language: Effect.fn("SystemPrompt.language")(function* (configured?: string) {
        const language = resolveLanguage(configured)
        const key = RequestCache.digest({ version: "system-language-v1", language })
        const cached = RequestCache.get(fragments, key)
        if (cached) return [cached.text]
        const name = language === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)"
        const text = [
          "## Reply language",
          `Reply to the user in ${name} by default.`,
          "If the user explicitly asks for another language, follow the user's request.",
          "Keep code, commands, identifiers, and file paths in their original form.",
        ].join("\n")
        RequestCache.set(fragments, key, { text }, Buffer.byteLength(text))
        return [text]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (
        agent: Agent.Info,
        permission?: PermissionV1.Ruleset,
        nativePermission?: PermissionV1.Ruleset,
        options?: { readonly root?: boolean },
      ) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        if (Permission.disabledByPolicy(["skill"], nativePermission ?? [], ruleset).has("skill")) return

        const list = (yield* skill.available(agent)).filter(
          (item) =>
            (options?.root !== false || !ROOT_ONLY_SKILLS.has(item.name)) &&
            Permission.evaluate("skill", item.name, nativePermission ?? []).action !== "deny" &&
            Permission.evaluate("skill", item.name, ruleset).action !== "deny",
        )
        // The rendered block only depends on these two fields; hashing the
        // full skill content would read every skill body on every request.
        const key = RequestCache.digest({
          version: "system-skills-v2",
          agent: agent.name,
          skills: list.map((item) => ({ name: item.name, description: item.description })),
        })
        const cached = RequestCache.get(fragments, key)
        if (cached) return cached.text

        const text = [
          "Skills provide specialized instructions and workflows for specific tasks.",
          // The skill tool description owns how to load a skill; this block
          // only advertises what is available.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
        RequestCache.set(fragments, key, { text }, Buffer.byteLength(text))
        return text
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (
        agent: Agent.Info,
        permission?: PermissionV1.Ruleset,
        nativePermission?: PermissionV1.Ruleset,
      ) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) =>
            item.tools.length === 0 ||
            Permission.disabledByPolicy(item.tools, nativePermission ?? [], ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        const key = RequestCache.digest({
          version: "system-mcp-v1",
          servers: instructions.map((item) => ({
            name: item.name,
            instructions: item.instructions,
            tools: item.tools,
          })),
        })
        const cached = RequestCache.get(fragments, key)
        if (cached) return cached.text

        const text = (yield* Effect.forEach(instructions, mcpBlock)).join("\n\n")
        RequestCache.set(fragments, key, { text }, Buffer.byteLength(text))
        return text
      }),

      goal: Effect.fn("SystemPrompt.goal")(function* (sessionID: SessionID) {
        // No Goal service wired into this entry point, no goal, or a finished one: only the constant note.
        const none = { system: [GOAL_NOTE], context: [] }
        if (!goalSvc) return none
        const state = yield* goalSvc.load(sessionID)
        // Only active/waiting/paused goals carry a live-state block. `done` is
        // transient (auto-cleared) and treated the same as "no goal" here. A
        // waiting goal must stay visible: a notice turn may need to re-declare
        // its intent.
        if (!state || state.status === "done") return none
        // The live state changes every goal turn, so it goes to the runtime context, not the system prefix.
        return { system: [GOAL_NOTE], context: [GoalPrompts.renderGoalSystemBlock(state)] }
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
          ...shown.map(
            (h) => `- ${h.event} [${h.scope}/${h.type}${h.asyncRewake ? ", background" : ""}] ${h.descriptor}`,
          ),
        ]
        if (hooks.length > MAX) lines.push(`… and ${hooks.length - MAX} more (see hooks.json)`)
        // A listed hook proves loading, not a watch. The entry form names the
        // start-confirmation rule and the two hook practices; full recipes stay
        // in the skill.
        lines.push(hooks.some((h) => h.asyncRewake) ? BACKGROUND_WAITS : BACKGROUND_WAITS_HINT)
        lines.push(STOP_GUARD_POINTER, GIT_GUARD_POINTER)
        return [lines.join("\n")]
      }),

      memory: Effect.fn("SystemPrompt.memory")(function* (input) {
        if (!input.main) return []
        const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
        if (!memory) return []
        yield* memory.prepare({ sessionID: input.sessionID, messages: input.messages, lane: input.lane })
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
