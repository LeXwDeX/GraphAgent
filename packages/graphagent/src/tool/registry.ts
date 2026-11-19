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
import { SettingsHook } from "@/hook"
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
import { DagBudget } from "@/dag/budget"
import { DagControl } from "@/dag/control"
import { AgentScheduler } from "@/session/agent-scheduler"
import { ChildRegistry } from "@/session/child/registry"
import { ChildPolicy } from "@/session/child/policy"
import { SessionRole } from "@/session/role"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderProfile } from "@/provider/profile"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
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
import { FileState } from "../session/file-state"
import { FSUtil } from "@graphagent/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { AgentContract } from "../agent/contract"
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
import { TuiEvent } from "@/server/tui-event"
import { ToolJsonSchema } from "./json-schema"
import { MCP_DEFERRED_IDS, movedNotice, settle, type Moved } from "./mcp-deferred"
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_ORDER, type McpResourceOp } from "./mcp-resource"
import { ROOT_ONLY_TOOLS, type DirectTool } from "./pipeline"
import { RequestCache } from "../session/request-cache"
import { randomUUID } from "node:crypto"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { asSchema, type Tool as AITool } from "ai"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"

export function webSearchEnabled(flags = { exa: false, parallel: false }) {
  return flags.exa || flags.parallel
}

/**
 * The agent tool is only meaningful when this session can actually exchange
 * messages with a running DAG node. Both sides answer from this process's
 * child registry, so the decision costs no query: a parent sees the tool while
 * it has an active DAG node run, and a node session while its own run is
 * active. A finished or paused workflow with no running node therefore hides
 * the tool (Issue #1026 migration), where the durable workflow row used to keep
 * it visible. The role is the live one (`SessionRole.liveRoleOf`): a root sees
 * its nodes, a DAG node its owner, and a task child nothing.
 */
export const canUseAgentMessages = Effect.fn("ToolRegistry.canUseAgentMessages")(function* (session: Session.Info) {
  const role = SessionRole.liveRoleOf(session)
  if (role === "root") return ChildRegistry.hasDagChild(session.id)
  return role === "dag_node" && ChildRegistry.dagOwnerOf(session.id) !== undefined
})

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

/**
 * Cache key of the definition-stage built-in superset a `resolve` call used.
 * Attached non-enumerably to the returned array so the request layer can reuse
 * the serialized tool fragment without re-deriving it (Issue #1022, PR5).
 */
const RESOLVE_KEY = Symbol.for("graphagent.registry.resolve-key")

export function resolveKey(entries: ReadonlyArray<ToolEntry>): string | undefined {
  return (entries as unknown as Record<PropertyKey, unknown>)[RESOLVE_KEY] as string | undefined
}

const DEFINITION_CACHE_BYTES = 4 * 1024 * 1024

/**
 * Identity of one definition-stage result. Every input that changes the built
 * tool set or a derived schema is part of the key: the owning directory
 * instance, the model shape used by availability and provider transforms, and
 * the runtime flags that decide which built-ins exist.
 */
export function definitionKey(input: {
  origin: string
  model: { readonly providerID: string; readonly id: string; readonly apiID: string; readonly npm: string }
  flags: {
    readonly webSearch: boolean
    readonly lsp: boolean
    readonly plan: boolean
    readonly question: boolean
    readonly client: string
    readonly usePatch: boolean
  }
}) {
  return RequestCache.digest({ version: "builtin-definitions-v1", ...input })
}

/**
 * Definition-stage result cached per model. Per-request policy filters
 * (parent session, agent-message visibility, permission, user switches) are
 * applied after the lookup, so the cache only stores request-independent work:
 * availability, derived JSON Schema and provider-schema transformation.
 */
type CachedBuiltin = Readonly<{
  index: number
  id: string
  source: BuiltinSource
  effects: Tool.Effects
  description: string
  jsonSchema: JSONSchema7
  definition: Tool.Def
}>

type State = {
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
/** Directory-local cache identity; a new directory never reuses old work. */
  readonly origin: string
  readonly definitions: RequestCache.CacheState<CachedBuiltin[]>
  /** One agent-tool visibility decision per session turn (Issue #1022, HS6b). */
  agentUsable: Map<string, { readonly turnID: string; readonly value: boolean }>
  /** The models (`<provider>/<id>`) the user was told tools were moved into the deferred catalog for (#1459). */
  warned: Set<string>
}

type AgentCatalogOptions = {
  heading: string
  includeHidden: boolean
  includeModelState: boolean
  /** Workflow worker_type defaults compile to the native build/plan primary
   * agents, so the workflow catalog lists native primaries even though the
   * task subagent catalog and user-defined primary modes stay filtered out. */
  includePrimary?: boolean
  /** A composer runs only inside a DAG (#1158): the task catalog leaves it out,
   * the workflow catalog still lists it as a `worker_type`. */
  excludeComposers?: boolean
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
  /** The key before it was shortened or made unique (#1459); only such a key has one. Its deny and ask rules apply. */
  baseKey?: string
  /**
   * The server is `deferred` (#1459); only such a tool has it. The entry stays for the catalog and for `mcp_call`, and
   * the tool is not one of the model's tools.
   */
  deferred?: boolean
}>
export type McpResourceSource = Readonly<{ kind: "mcp-resource"; op: McpResourceOp; registrationID: string }>
/** `mcp_describe` and `mcp_call`, which stand in for the tools of deferred servers. */
export type McpDeferredSource = Readonly<{ kind: "mcp-deferred"; op: "describe" | "call"; registrationID: string }>
export type ToolSource = BuiltinSource | DirectShellSource | McpSource | McpResourceSource | McpDeferredSource

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
  | (ToolEntryBase & { source: McpDeferredSource })

export type ResolveInput = (
  { directTool: DirectTool; model?: Provider.Model } | { directTool?: undefined; model: Provider.Model }
) & {
  agent: Agent.Info
  session: Session.Info
  /** Current user turn; its id scopes the per-turn agent-tool visibility decision. */
  turnID?: string
  /** Per-message tool switches; undefined leaves every tool enabled. */
  user?: Pick<SessionV1.User, "tools">
  /** Session rules; agent rules are merged in before filtering. */
  permission?: PermissionV1.Ruleset
}

export type RegisteredTool = Readonly<{
  definition: Tool.Def
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
    const events = yield* EventV2Bridge.Service
    // #1324: resolving the `readonly` tier's tool face for a task child needs
    // the root session's live `dag_mode`, read the same way `ChildPolicy.askOf`
    // reads it elsewhere. Optional like every other service this registry
    // reads defensively: a harness without one just never sees a task child
    // turn unattended by that route (a DAG node's own run already says so).
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))

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

        const agentUsable = new Map<string, { readonly turnID: string; readonly value: boolean }>()
        // Event fan-out runs without InstanceRef: drop entries through the map
        // captured by this per-directory state.
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            const sessionID = data.sessionID
            if (typeof sessionID !== "string") return Effect.void
            agentUsable.delete(sessionID)
            return Effect.void
          }),
          (unsubscribe) => unsubscribe,
        )

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
          origin: randomUUID(),
          definitions: RequestCache.make<CachedBuiltin[]>(DEFINITION_CACHE_BYTES),
          agentUsable,
          warned: new Set<string>(),
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
        .filter((item) => !(options.excludeComposers && AgentContract.isComposer(item)))
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
        registrationID: `builtin:${index}:${definition.id}`,
      }))
      // The id may name a model that is not registered, so only the built-in rules speak here; a configured
      // `profile.edit_tools` applies in `resolve`, which holds the model.
      const usePatch = ProviderProfile.builtinProfileOf(input.providerID, input.modelID).editTools === "apply_patch"
      const filtered = registered.filter(({ definition: tool }) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled({ exa: flags.enableExa, parallel: flags.enableParallel })
        }

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
                      excludeComposers: true,
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

    // Tells the user, once for each model, that MCP tools were moved into the deferred catalog to meet the limits of
    // the model (#1459).
    const warnMoved = Effect.fnUntraced(function* (s: State, model: Provider.Model, moved: Moved) {
      const count = moved.byCount + moved.byName
      const name = `${model.providerID}/${model.id}`
      if (count === 0 || s.warned.has(name)) return
      s.warned.add(name)
      yield* Effect.logWarning("MCP tools moved into the deferred catalog for the limits of the model", {
        model: name,
        ...moved,
      })
      yield* events
        .publish(TuiEvent.ToastShow, { ...movedNotice(count, name), variant: "warning", duration: 8000 })
        .pipe(Effect.ignore)
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
      // #1030 D9-h: a run whose owner withheld workspace writes (review nodes)
      // never sees the tools that declare that effect. Shell and other
      // `unknown` tools keep the agent's own permission, so a reviewer can
      // still run tests. Read per request: the policy belongs to the active
      // child run of this process, not to the cached definitions.
      //
      // #1324 §4: the `readonly` tier of `dag.permission` hides the same
      // tools for every unattended session (a DAG node, or a task child while
      // its root is in DAG mode), whatever the owning node's own worker
      // profile says. The tier is read fresh here, never cached, so a switch
      // to `readonly` hides edit/write/apply_patch from the session's very
      // next tool resolution; a request already in flight is still refused at
      // ask time (`Permission.ask`'s readonly override). `ChildPolicy.askOf`
      // is only consulted once the tier is actually `readonly`, so the common
      // `allow` tier costs no extra read.
      const readonlyTier = (yield* config.dagGlobal()).permission === "readonly"
      const readonlyPolicy = readonlyTier
        ? yield* ChildPolicy.askOf(database?.db)(input.session.id, "readonly")
        : Option.none()
      const workspaceWritesDenied =
        ChildRegistry.subjectOf(input.session.id)?.permission.workspaceWrites === "deny" ||
        (Option.isSome(readonlyPolicy) && readonlyPolicy.value.unattended)
      const usePatch = ProviderProfile.profileOf(model).editTools === "apply_patch"
      const entries = new Map<string, ToolEntry>()

      const definitionsKey = definitionKey({
        origin: s.origin,
        model: { providerID: model.providerID, id: model.id, apiID: model.api.id, npm: model.api.npm },
        flags: {
          webSearch: webSearchEnabled({ exa: flags.enableExa, parallel: flags.enableParallel }),
          lsp: flags.experimentalLspTool,
          plan: flags.experimentalPlanMode,
          question: flags.enableQuestionTool,
          client: flags.client,
          usePatch,
        },
      })

      let builtins = RequestCache.get(s.definitions, definitionsKey)
      if (builtins === undefined) {
        const built: CachedBuiltin[] = []
        for (const [index, definition] of s.builtin.entries()) {
          if (definition.id === WebSearchTool.id) {
            if (!webSearchEnabled({ exa: flags.enableExa, parallel: flags.enableParallel })) continue
          } else if (definition.id === ApplyPatchTool.id) {
            if (!usePatch) continue
          } else if (definition.id === EditTool.id || definition.id === WriteTool.id) {
            if (usePatch) continue
          }
          const jsonSchema = definition.jsonSchema ?? ToolJsonSchema.fromSchema(definition.parameters)
          built.push({
            index,
            id: definition.id,
            source: { kind: "builtin", registrationID: `builtin:${index}:${definition.id}` },
            effects: definition.effects ?? "unknown",
            description: definition.description,
            jsonSchema: transform(jsonSchema),
            // Keep the derived schema on the definition so the execution
            // pipeline does not derive it a second time (H0 S1).
            definition: definition.jsonSchema ? definition : { ...definition, jsonSchema },
          })
        }
RequestCache.set(
          s.definitions,
          definitionsKey,
          built,
          built.reduce(
            (total, entry) =>
              total + Buffer.byteLength(entry.description) + Buffer.byteLength(JSON.stringify(entry.jsonSchema)),
            0,
          ),
        )
        builtins = built
      }

      for (const builtin of builtins) {
        if (SessionRole.isChild(input.session) && ROOT_ONLY_TOOLS.has(builtin.id)) continue
        if (workspaceWritesDenied && builtin.effects === "workspace_write") continue
        if (builtin.id === AgentTool.id) {
          const turnID = input.turnID
          const cached = turnID === undefined ? undefined : s.agentUsable.get(input.session.id)
          const usable =
            cached !== undefined && cached.turnID === turnID ? cached.value : yield* canUseAgentMessages(input.session)
          // The toolset stays stable for one user turn even when a mailbox
          // becomes reachable mid-turn (HS6b); a new turn re-evaluates.
          if (turnID !== undefined && (cached === undefined || cached.turnID !== turnID))
            s.agentUsable.set(input.session.id, { turnID, value: usable })
          if (!usable) continue
        }
        entries.set(builtin.id, {
          id: builtin.id,
          source: builtin.source,
          effects: builtin.effects,
          description: [
            builtin.description,
            builtin.id === TaskTool.id
              ? yield* describeAgents(input.agent, {
                  heading: "Available agent types:",
                  includeHidden: true,
                  includeModelState: false,
                  excludeComposers: true,
                })
              : undefined,
            builtin.id === WorkflowTool.id
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
          jsonSchema: builtin.jsonSchema,
          definition: builtin.definition,
        })
      }

      const mcpItems = yield* mcp.tools()
      for (const key of Object.keys(mcpItems).toSorted((left, right) => left.localeCompare(right))) {
        // A server tool with the same model-facing key replaces the built-in,
        // matching the pre-registry merge order (`tools[key] = item`): the
        // model sees exactly one tool under that name, and it is the MCP one.
        if (entries.has(key)) {
          yield* Effect.logWarning("MCP tool name collides with a built-in tool; the MCP tool wins", {
            tool: key,
          })
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
            ...(binding.baseKey === undefined ? {} : { baseKey: binding.baseKey }),
            ...(binding.deferred === true ? { deferred: true } : {}),
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

      const disabled = Permission.disabledTools(
        [
          ...[...entries].map(([id, entry]) => ({
            id,
            alias: entry.source.kind === "mcp" ? entry.source.baseKey : undefined,
          })),
          // The deferred-tool helpers are tools too: a rule that denies them hides them, a read-only agent included.
          ...MCP_DEFERRED_IDS.map((id) => ({ id })),
        ],
        nativePermission,
        configuredPermission,
      )
      const visible = (id: string) => input.user?.tools?.[id] !== false && !disabled.has(id)
      const { entries: resolved, moved } = settle({
        entries: entries.values(),
        visible,
        transform,
        limits: ProviderProfile.profileOf(model).toolLimits,
      })
      yield* warnMoved(s, model, moved)
      Object.defineProperty(resolved, RESOLVE_KEY, { value: definitionsKey })
      return resolved
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
      Layer.provide(FileState.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Dag.defaultLayer),
      Layer.provide(DagControl.defaultLayer),
      // #1031 M5: the workflow tool resolves the budget gate when the tool is
      // constructed, so the service must be in this layer's context.
      Layer.provide(DagBudget.defaultLayer),
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
      Layer.provide(AgentScheduler.defaultLayer),
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
  FileState.node,
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
  AgentScheduler.node,
])

export * as ToolRegistry from "./registry"
