import { LayerNode } from "@graphagent/core/effect/layer-node"
import { httpClient } from "@graphagent/core/effect/layer-node-platform"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@graphagent/core/database/database"
import { TodoWriteTool } from "./todo"
import { GoalTool } from "./goal"
import { MemorySearch } from "./memory-search"
import { SettingsHook } from "@/hook/settings"
import { HookStartContext } from "@/hook/start-context"
import { WebFetchTool } from "./webfetch"
import { WatchPrTool } from "./watch_pr"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { WorkflowTool } from "./workflow"
import { AgentTool } from "./agent"
import { DagAgentMessages } from "@/dag/agent-messages"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { usesApplyPatch } from "./editing-tools"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@graphagent/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import type { ToolSourceKind } from "@graphagent/core/session/context-folding"

export function webSearchEnabled(flags = { exa: false, parallel: false }) {
  return flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

type AgentCatalogOptions = {
  heading: string
  includeHidden: boolean
  includeModelState: boolean
  /** Workflow worker_type defaults compile to the native build/plan primary
   * agents, so the workflow catalog lists native primaries even though the
   * task subagent catalog and user-defined primary modes stay filtered out. */
  includePrimary?: boolean
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
  }) => Effect.Effect<Tool.Def[]>
  readonly registrations: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
  }) => Effect.Effect<RegisteredTool[]>
}

export type RegisteredTool = Readonly<{
  definition: Tool.Def
  sourceKind: Extract<ToolSourceKind, "host-builtin" | "custom">
  registrationID: string
}>

export class Service extends Context.Service<Service, Interface>()("@graphagent/ToolRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const goaltool = yield* GoalTool
    const memorySearch = yield* MemorySearch.MemorySearchTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const watchPr = yield* WatchPrTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const workflow = yield* WorkflowTool
    const agentTool = yield* AgentTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* () {
        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          watchPr: Tool.init(watchPr),
          todo: Tool.init(todo),
          goal: Tool.init(goaltool),
          memorySearch: Tool.init(memorySearch),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          workflow: Tool.init(workflow),
          agent: Tool.init(agentTool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
        })

        return {
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.watchPr,
            tool.todo,
            tool.goal,
            tool.memorySearch,
            tool.search,
            tool.skill,
            tool.patch,
            tool.workflow,
            tool.agent,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return s.builtin
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeAgents = Effect.fn("ToolRegistry.describeAgents")(function* (
      caller: Agent.Info,
      options: AgentCatalogOptions,
    ) {
      const description = (yield* agents.list())
        .filter((item) => item.mode !== "primary" || (options.includePrimary && item.native))
        .filter((item) => options.includeHidden || !item.hidden)
        .filter((item) => Permission.evaluate("task", item.name, caller.permission).action !== "deny")
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}${options.includeModelState ? ` [model: ${item.model ? "configured" : "inherited"}]` : ""}`,
        )
        .join("\n")
      return [options.heading, description].join("\n")
    })

    const registrations: Interface["registrations"] = Effect.fn("ToolRegistry.registrations")(function* (input) {
      const s = yield* InstanceState.get(state)
      const registered: RegisteredTool[] = s.builtin.map((definition, index) => ({
        definition,
        sourceKind: "host-builtin" as const,
        registrationID: `builtin:${index}:${definition.id}`,
      }))
      const filtered = registered.filter(({ definition: tool }) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled({ exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch = usesApplyPatch(input.modelID)
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (registration) {
          const tool = registration.definition
          const jsonSchema = tool.jsonSchema
          return {
            ...registration,
            definition: {
              id: tool.id,
              description: [
                tool.description,
                tool.id === TaskTool.id
                  ? yield* describeAgents(input.agent, {
                      heading: "Available agent types:",
                      includeHidden: true,
                      includeModelState: false,
                    })
                  : undefined,
                tool.id === WorkflowTool.id
                  ? yield* describeAgents(input.agent, {
                      heading: "Available workflow worker_type values:",
                      includeHidden: false,
                      includeModelState: true,
                      includePrimary: true,
                    })
                  : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
              parameters: tool.parameters,
              jsonSchema,
              execute: tool.execute,
              formatValidationError: tool.formatValidationError,
            },
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      return (yield* registrations(input)).map((item) => item.definition)
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools, registrations })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer
    .pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Dag.defaultLayer),
      Layer.provide(DagControl.defaultLayer),
      Layer.provide(DagAgentMessages.defaultLayer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(
      Layer.provide(Database.defaultLayer),
      Layer.provide(RuntimeFlags.defaultLayer),
      Layer.provide(HookStartContext.defaultLayer),
    ),
)

export const node = LayerNode.make(layer.pipe(Layer.provide(Ripgrep.defaultLayer)), [
  Config.node,
  Question.node,
  Todo.node,
  Agent.node,
  Skill.node,
  Session.node,
  BackgroundJob.node,
  Provider.node,
  LSP.node,
  Instruction.node,
  FSUtil.node,
  EventV2Bridge.node,
  httpClient,
  CrossSpawnSpawner.node,
  Format.node,
  Truncate.node,
  RuntimeFlags.node,
  Database.node,
  SettingsHook.node,
  HookStartContext.node,
  Dag.node,
  DagControl.node,
  DagAgentMessages.node,
])

export * as ToolRegistry from "./registry"
