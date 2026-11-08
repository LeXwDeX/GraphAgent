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
import { Effect, Layer, Context, Option } from "effect"
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
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { ProviderTransform } from "@/provider/transform"
import { ToolJsonSchema } from "./json-schema"
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_ORDER, type McpResourceOp } from "./mcp-resource"
import { ROOT_ONLY_TOOLS, type DirectTool } from "./pipeline"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { asSchema, type Tool as AITool } from "ai"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { ToolSourceKind } from "@graphagent/core/session/context-folding"

export function webSearchEnabled(flags = { exa: false, parallel: false }) {
  return flags.exa || flags.parallel
}

/**
 * The agent tool is only meaningful when this session can actually exchange
 * messages with a running DAG node. Resolved once per request so the model
 * never sees an unusable tool.
 */
export const canUseAgentMessages = Effect.fn("ToolRegistry.canUseAgentMessages")(function* (session: Session.Info) {
  const store = yield* Effect.serviceOption(DagStore.Service)
  const messages = yield* Effect.serviceOption(DagMessages.Service)
  if (Option.isNone(store) || Option.isNone(messages)) return false
  const workflows = yield* store.value.listBySession(session.parentID ?? session.id)
  const caller = { projectID: session.projectID, directory: session.directory, sessionID: session.id }
  if (!session.parentID) {
    for (const workflow of workflows) {
      const endpoint = yield* messages.value.resolve(caller, workflow.id)
      if (endpoint.ok && endpoint.value.kind === "main") return true
    }
    return false
  }
  const endpoint = yield* messages.value.revisions(caller)
  if (!endpoint.ok || endpoint.value.endpoint.kind !== "node") return false
  for (const workflow of workflows) {
    if (endpoint.value.endpoint.workflowID !== workflow.id) continue
    const nodes = yield* store.value.getNodes(workflow.id)
    if (
      nodes.some(
        (node) =>
          node.status === "running" &&
          !node.superseded &&
          node.childSessionId === session.id &&
          node.id === endpoint.value.endpoint.nodeID &&
          DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts) === endpoint.value.endpoint.attemptID,
      )
    )
      return true
  }
  return false
})

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
  /**
   * Every tool the model may see for one request, with its origin and declared
   * filesystem effect. Definition-stage rewrites (availability, permissions,
   * description, schema) happen here exactly once; the execution pipeline only
   * validates and wraps the entries.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<ToolEntry[]>
}

/** Where a resolved tool came from. The executor keeps per-source behavior. */
export type BuiltinSource = Readonly<{ kind: "builtin"; registrationID: string }>
export type DirectShellSource = Readonly<{ kind: "direct-shell" }>
export type McpSource = Readonly<{
  kind: "mcp"
  server: string
  tool: string
  /** Where the server definition came from, for hook context. */
  source: string
  /** Claude-style `mcp__server__tool` name used by hook matchers. */
  canonicalName: string
  requiresUserInteraction: boolean
}>
export type McpResourceSource = Readonly<{ kind: "mcp-resource"; op: McpResourceOp; registrationID: string }>
export type ToolSource = BuiltinSource | DirectShellSource | McpSource | McpResourceSource

type ToolEntryBase = Readonly<{
  id: string
  effects: Tool.Effects
  description: string
  /** Final JSON Schema sent to the model. */
  jsonSchema: JSONSchema7
}>

/**
 * Source-discriminated entry. Builtins and direct-shell calls keep their native
 * `Tool.Def`; MCP server tools keep the SDK tool; resource helpers are built by
 * the pipeline from the fixed definitions.
 */
export type ToolEntry =
  | (ToolEntryBase & { source: BuiltinSource; definition: Tool.Def })
  | (ToolEntryBase & { source: DirectShellSource; definition: DirectTool })
  | (ToolEntryBase & { source: McpSource; tool: AITool })
  | (ToolEntryBase & { source: McpResourceSource })

export type ResolveInput = (
  { directTool: DirectTool; model?: Provider.Model } | { directTool?: undefined; model: Provider.Model }
) & {
  agent: Agent.Info
  session: Session.Info
  /** Per-message tool switches; undefined leaves every tool enabled. */
  user?: Pick<SessionV1.User, "tools">
  /** Session rules; agent rules are merged in before filtering. */
  permission?: PermissionV1.Ruleset
}

export type RegisteredTool = Readonly<{
  definition: Tool.Def
  sourceKind: Extract<ToolSourceKind, "host-builtin">
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
    const mcp = yield* MCP.Service

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

    const registrations = Effect.fn("ToolRegistry.registrations")(function* (input: {
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
      agent: Agent.Info
    }) {
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
              effects: tool.effects,
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

    const resolve: Interface["resolve"] = Effect.fn("ToolRegistry.resolve")(function* (input) {
      const transform = (schema: JSONSchema7) => (input.model ? ProviderTransform.schema(input.model, schema) : schema)

      // Explicit shell (`!cmd`) is the only entry without a model, and it
      // bypasses availability, switch and permission filters.
      if (input.directTool) {
        const definition = input.directTool
        const jsonSchema = definition.jsonSchema ?? ToolJsonSchema.fromSchema(definition.parameters)
        return [
          {
            id: definition.id,
            source: { kind: "direct-shell" as const },
            effects: "unknown" as const,
            description: definition.description,
            jsonSchema: transform(jsonSchema),
            // Carry the derived schema on the definition: the execution
            // pipeline falls back to `fromSchema(parameters)` when the
            // definition has none, and re-deriving it here doubles the
            // per-request schema work (H0 S1 `schema.fromSchema`).
            definition: definition.jsonSchema ? definition : { ...definition, jsonSchema },
          },
        ]
      }

      const model = input.model
      const s = yield* InstanceState.get(state)
      const nativePermission = (yield* agents.permissionPolicy(input.agent.name)).native
      const configuredPermission = Permission.merge(input.agent.permission, input.permission ?? [])
      const usePatch = usesApplyPatch(ModelV2.ID.make(model.api.id))
      const entries = new Map<string, ToolEntry>()

      for (const [index, definition] of s.builtin.entries()) {
        if (definition.id === WebSearchTool.id) {
          if (!webSearchEnabled({ exa: flags.enableExa, parallel: flags.enableParallel })) continue
        } else if (definition.id === ApplyPatchTool.id) {
          if (!usePatch) continue
        } else if (definition.id === EditTool.id || definition.id === WriteTool.id) {
          if (usePatch) continue
        }
        if (input.session.parentID && ROOT_ONLY_TOOLS.has(definition.id)) continue
        if (definition.id === AgentTool.id && !(yield* canUseAgentMessages(input.session))) continue
        const jsonSchema = definition.jsonSchema ?? ToolJsonSchema.fromSchema(definition.parameters)
        entries.set(definition.id, {
          id: definition.id,
          source: { kind: "builtin", registrationID: `builtin:${index}:${definition.id}` },
          effects: definition.effects ?? "unknown",
          description: [
            definition.description,
            definition.id === TaskTool.id
              ? yield* describeAgents(input.agent, {
                  heading: "Available agent types:",
                  includeHidden: true,
                  includeModelState: false,
                })
              : undefined,
            definition.id === WorkflowTool.id
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
          jsonSchema: transform(jsonSchema),
          // Keep the derived schema on the definition so the execution
          // pipeline does not derive it a second time (H0 S1).
          definition: definition.jsonSchema ? definition : { ...definition, jsonSchema },
        })
      }

      const mcpItems = yield* mcp.tools()
      for (const key of Object.keys(mcpItems).toSorted((left, right) => left.localeCompare(right))) {
        if (entries.has(key)) {
          yield* Effect.logWarning("MCP tool name collides with a built-in tool; keeping the built-in", {
            tool: key,
          })
          continue
        }
        const item = mcpItems[key]
        const binding = McpCatalog.toolBinding(item)
        if (!binding) {
          yield* Effect.logWarning("MCP tool has no source binding; skipping an unresolvable tool", { tool: key })
          continue
        }
        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        entries.set(key, {
          id: key,
          source: {
            kind: "mcp",
            server: binding.server,
            tool: binding.tool,
            source: binding.source,
            canonicalName: McpCatalog.canonicalToolName(binding),
            requiresUserInteraction: binding.requiresUserInteraction === true,
          },
          effects: "unknown",
          description: item.description ?? "",
          jsonSchema: transform({ ...schema, properties: schema.properties ?? {} }),
          tool: item,
        })
      }

      const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
        (client) => !!client.getServerCapabilities()?.resources,
      )
      if (hasMcpResourceServer) {
        for (const op of MCP_RESOURCE_ORDER) {
          const definition = MCP_RESOURCE_DEFINITIONS[op]
          if (entries.has(definition.id)) continue
          entries.set(definition.id, {
            id: definition.id,
            source: { kind: "mcp-resource", op, registrationID: `mcp-resource:${definition.id}` },
            effects: "read",
            description: definition.description,
            jsonSchema: transform(definition.jsonSchema),
          })
        }
      }

      const disabled = Permission.disabledByPolicy([...entries.keys()], nativePermission, configuredPermission)
      return [...entries.values()].filter((entry) => input.user?.tools?.[entry.id] !== false && !disabled.has(entry.id))
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools, resolve })
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
    )
    .pipe(
      Layer.provide(DagStore.defaultLayer),
      Layer.provide(DagMessages.defaultLayer),
      Layer.provide(MCP.defaultLayer),
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
  DagStore.node,
  DagMessages.node,
  MCP.node,
])

export * as ToolRegistry from "./registry"
