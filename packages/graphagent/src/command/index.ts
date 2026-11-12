import { LayerNode } from "@graphagent/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2Bridge } from "@/event-v2-bridge"
import { watchTrustState } from "@/project/trust/subscribe"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_IMPORT_CLAUDE from "./template/import-claude.txt"
import PROMPT_CREATE_HOOK from "./template/create-hook.txt"
import { LegacyEvent } from "@graphagent/schema/legacy-event"
import { CommandPlugin } from "@graphagent/core/plugin/command"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

/**
 * Provenance for a skill-promoted command (`source: "skill"`): the backing
 * skill's own trust classification and SKILL.md path. Kept out of `Info`'s
 * schema -- the public HTTP/SDK shape -- since the command-shell trust gate
 * (#1040) is its only reader; it is never displayed. Keyed by the exact
 * `Info` object `get`/`list` return (the same reference `init()` stored, not
 * a clone), so a stale key is simply never found after a reload.
 */
const skillCommandOrigins = new WeakMap<
  object,
  { readonly source: Skill.Info["hookSource"]; readonly location: string }
>()

/** Undefined for a command that is not skill-promoted. */
export function skillCommandOrigin(cmd: Info) {
  return skillCommandOrigins.get(cmd)
}

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  GOAL: "goal",
  SUBGOAL: "subgoal",
  MEMORY: "memory",
  DAG_AUTO: "dag-auto",
  IMPORT_CLAUDE: "import-claude",
  CREATE_HOOK: "create-hook",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.root)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "set a persistent goal [--max-turns N] <goal>; control [status|pause|resume [--max-turns N]|done|clear|stop]",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      }
      commands[Default.SUBGOAL] = {
        name: Default.SUBGOAL,
        description: "manage subgoals [list|<text>|remove <n>|clear]",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      }
      commands[Default.MEMORY] = {
        name: Default.MEMORY,
        description: "enable or disable project MEMORY [on|off]",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      }
      commands[Default.DAG_AUTO] = {
        name: Default.DAG_AUTO,
        description: CommandPlugin.DagAutoDescription,
        source: "command",
        template: CommandPlugin.DagAutoContent,
        hints: hints(CommandPlugin.DagAutoContent),
      }
      commands[Default.IMPORT_CLAUDE] = {
        name: Default.IMPORT_CLAUDE,
        description: "Review Claude Code config and convert it into .agents/",
        source: "command",
        template: PROMPT_IMPORT_CLAUDE,
        hints: hints(PROMPT_IMPORT_CLAUDE),
      }
      commands[Default.CREATE_HOOK] = {
        name: Default.CREATE_HOOK,
        description: "Create lifecycle hooks, including background polling that resumes an idle conversation",
        source: "command",
        template: PROMPT_CREATE_HOOK,
        subtask: true,
        hints: [],
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        // Reference-only skills stay loadable through the skill tool but get no
        // same-name slash command.
        if (item.hidden) continue
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
        // #1040: the command-shell trust gate needs the backing skill's own
        // classification to fail closed on a project-owned skill it cannot
        // enumerate; keep it out of the schema above (never displayed).
        skillCommandOrigins.set(commands[item.name], { source: item.hookSource, location: item.location })
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))
    // Command declarations come from trust-gated project files; a decision
    // must drop the cached command map so newly trusted commands appear.
    const trustWatch = yield* watchTrustState(state)
    const ready = Effect.fnUntraced(function* () {
      yield* InstanceState.get(trustWatch)
    })

    const get = Effect.fn("Command.get")(function* (name: string) {
      yield* ready()
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      yield* ready()
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [Config.node, MCP.node, Skill.node, EventV2Bridge.node])

export * as Command from "."
