import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookCwd } from "@/hook/cwd"
import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpRouter, HttpServer } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { FSUtil } from "@graphagent/core/fs-util"
import * as Observability from "@graphagent/core/observability"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { ProjectTrust } from "@/project/trust/service"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionInbox } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionBtw } from "@/session/btw"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionLifecycle } from "@/session/lifecycle"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { EventResidueSweep } from "@graphagent/core/event/residue-sweep"
import { SessionAttention } from "@/notification/attention"
import { Notification } from "@/notification"
import { HookTodo } from "@/hook/todo"
import { SettingsHook } from "@/hook"
import { HookRewakeLive } from "@/hook/rewake-live"
import { SessionHooks } from "@/hook/session-hooks"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@graphagent/core/control-plane/move-session"
import { MoveSessionLookup } from "@/session/move-session-lookup"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { httpClient } from "@graphagent/core/effect/layer-node-platform"
import { EventV2 } from "@graphagent/core/event"
import { ModelsDev } from "@graphagent/core/models-dev"
import { Npm } from "@graphagent/core/npm"
import { ProjectCopy } from "@/project/copy"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectCopy as CoreProjectCopy } from "@graphagent/core/project/copy"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { SessionProjector } from "@graphagent/core/session/projector"
import { lazy } from "@/util/lazy"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { PublicApi } from "./public"
import { EventApi } from "./groups/event"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { dagHandlers } from "./handlers/dag"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { questionHandlers } from "./handlers/question"
import { referenceHandlers } from "./handlers/reference"
import { sessionHandlers } from "./handlers/session"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { afterResponseLayer } from "./lifecycle"
import { memoMap } from "@graphagent/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { errorLayer } from "./middleware/error"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - instanceApiRoutes: remaining typed instance routes.
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    referenceHandlers,
    sessionHandlers,
    dagHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

// Exported so wiring regression tests can build the exact node graph the
// server provides to request handlers (LayerNode.buildLayer(app)) and probe
// its ambient service context — a hand-copied node list would not catch a
// missing member.
export const app = LayerNode.group([
  ProjectCopy.node,
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  Notification.node,
  SessionAttention.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  DagStore.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  Dag.node,
  DagMessages.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionBtw.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  ProjectTrust.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  SessionLifecycle.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  CoreProjectCopy.node,
  Goal.node,
  // SettingsHook + SessionHooks: previously defined but never wired into
  // the server app graph, so every consumer using
  // `Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))`
  // (SessionPrompt, tools.ts, Permission, ShareSession, Compaction, TaskTool)
  // silently degraded to `undefined` — meaning PreToolUse / PostToolUse /
  // PostToolUseFailure / FileChanged / UserPromptSubmit / Stop /
  // PermissionRequest / PreCompact / PostCompact /
  // SessionStart / TaskCreated / SubagentStart / TaskCompleted hooks never
  // fired in production. Listed here at the app-graph level so ALL
  // consumers see the service (per-consumer node additions would miss
  // Permission.node / Compaction.node / ShareSession.node etc.).
  SettingsHook.node,
  LayerNode.make(HookTodo.layer, [SettingsHook.node, Session.node, InstanceStore.node]),
  LayerNode.make(HookCwd.layer, [
    SettingsHook.node,
    SessionHooks.node,
    Session.node,
    InstanceStore.node,
    HookLifecycle.node,
    HookFileWatch.node,
    HookConfigChange.node,
  ]),
  SessionHooks.node,
  // HookRewake live node: async hook rewake delivery (hook-async-rewake).
  // Same app-graph-level placement rationale as SettingsHook above — the hook barrel
  // resolves HookRewake.Service via serviceOption from the ambient request
  // context, so it must be present in this graph or server-driven sessions
  // would silently skip rewake.
  HookRewakeLive.node,
  // The rewake delivery itself resolves SessionInbox via serviceOption from
  // the same ambient context (ledger-less sources deliver through
  // `SessionInbox.submit`); listing it only as HookRewakeLive.node's
  // dependency builds it but does not expose the service, so it must be a
  // graph-level node too.
  SessionInbox.node,
  // Memory: same failure class as SettingsHook above — /memory and
  // memory_search resolve Memory.Service via serviceOption from the ambient
  // request context (session/prompt.ts, tool/memory-search.ts), and listing
  // Memory.node only in per-consumer dependency arrays (SessionPrompt,
  // SystemPrompt, SessionCompaction, InstanceBootstrap) never surfaced it
  // here, so live sessions silently degraded to "Memory remains off" /
  // "Memory search is unavailable for this session" (issue #311).
  Memory.node,
  // GoalLoop: same failure class again (issue #340) — the only consumer is
  // InstanceBootstrap's `serviceOption(GoalLoop.Service).init()` (idle-event
  // subscription + startup goal scan), which runs in the request fiber's
  // ambient context. GoalLoop.node was listed only in AppLayer
  // (app-runtime.ts provideMerge), so headless serve, the
  // sidecar, and non-CWD TUI directories never armed goal continuation or
  // the crash-recovery scan: standing goals stalled after their first turn.
  GoalLoop.node,
  // DagSupervisionSweep: host-level deadline supervision (2026-08-18
  // orphaned-nodes incident) was constructed only in AppLayer, but the
  // sidecar calls Server.listen without effectCmd, so AppLayer never existed
  // there and the sweep never ran on that path (issue #341). Listing
  // it here makes every serving process build it with the listener scope.
  // Processes that also build AppLayer (serve via AppRuntime) get a
  // second instance; settle is convergent (withWorkflowLock + guardNode +
  // conditional projector UPDATE), so the duplicate is safe — see the sweep
  // header's multi-host convergence notes.
  DagSupervisionSweep.node,
  // EventResidueSweep (#524): default-on startup residue sweep for crash/
  // in-flight zombie event aggregates. Same app-graph-level placement
  // rationale as DagSupervisionSweep above — the sidecar and headless
  // serving processes build this node graph without AppLayer, and the sweep
  // is idempotent (a second pass in AppLayer processes removes nothing).
  EventResidueSweep.node,
])

export function createRoutes(options?: {
  readonly replacements?: readonly LayerNode.Replacement[]
}): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const moveSession = MoveSession.defaultLayer.pipe(Layer.provide(MoveSessionLookup.layer))
  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, afterResponseLayer).pipe(
    Layer.provide([errorLayer, compressionLayer, moveSession, HttpServer.layerServices]),
    Layer.provide(LayerNode.buildLayer(app, options)),
    Layer.provideMerge(Observability.layer),
    // tsgo (native TS preview) widens the merged error channel to `unknown` after the
    // provide/provideMerge chain, while the declared return type is ConfigError. The
    // runtime error set is unchanged (config + the provided layers' errors); this cast
    // only reconciles tsgo's over-conservative inference with the documented contract.
  ) as Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements>
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
  }),
)

export * as HttpApiApp from "./server"
