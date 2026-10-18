import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookCwd } from "@/hook/cwd"
import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
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
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { EventResidueSweep } from "@opencode-ai/core/event/residue-sweep"
import { HookModelSwitch } from "@/hook/model-switch"
import { HookAttentionHost } from "@/notification/attention-host"
import { SessionAttention } from "@/notification/attention"
import { Notification } from "@/notification"
import { HookV2Conversation } from "@/hook/v2-conversation"
import { HookV2Turn } from "@/hook/v2-turn"
import { HookV2Compaction } from "@/hook/v2-compaction"
import { HookV2Lifecycle } from "@/hook/v2-lifecycle"
import { HookTodo } from "@/hook/todo"
import { SettingsHook } from "@/hook/settings"
import { HookRewakeLive } from "@/hook/rewake-live"
import { SessionHooks } from "@/hook/session-hooks"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Npm } from "@opencode-ai/core/npm"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRewakeBridge } from "@opencode-ai/core/session/execution/rewake-bridge"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
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
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@opencode-ai/server/handlers"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
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
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    dagHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

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
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
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
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
  Goal.node,
  // SettingsHook + SessionHooks: previously defined but never wired into
  // the server app graph, so every consumer using
  // `Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))`
  // (SessionPrompt, tools.ts, Permission, ShareSession, Compaction, TaskTool)
  // silently degraded to `undefined` — meaning PreToolUse / PostToolUse /
  // PostToolUseFailure / FileChanged / UserPromptSubmit / Stop /
  // PermissionRequest / PermissionDenied / PreCompact / PostCompact /
  // SessionStart / TaskCreated / SubagentStart / TaskCompleted hooks never
  // fired in production. Listed here at the app-graph level so ALL
  // consumers see the service (per-consumer node additions would miss
  // Permission.node / Compaction.node / ShareSession.node etc.).
  SettingsHook.node,
  LayerNode.make(HookAttentionHost.layer, [InstanceStore.node, SessionAttention.node]),
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
  LayerNode.make(HookV2Conversation.layer, [
    SettingsHook.node,
    Session.node,
    InstanceStore.node,
    Permission.node,
    SessionAttention.node,
  ]),
  LayerNode.make(HookV2Turn.layer, [
    SessionAttention.node,
    Notification.node,
    SettingsHook.node,
    Session.node,
    InstanceStore.node,
    SessionPrompt.node,
    BackgroundJob.node,
    DagStore.node,
    Permission.node,
    SessionStatus.node,
  ]),
  LayerNode.make(HookV2Compaction.layer, [SettingsHook.node, Session.node, InstanceStore.node]),
  LayerNode.make(HookV2Lifecycle.layer, [
    SettingsHook.node,
    Session.node,
    SessionPrompt.node,
    InstanceStore.node,
    HookLifecycle.node,
    HookStartContext.node,
    HookFileWatch.node,
    HookConfigChange.node,
    Skill.node,
  ]),
  LayerNode.make(HookModelSwitch.layer, [SessionPrompt.node, Session.node, InstanceStore.node]),
  SessionHooks.node,
  // The V2 handler graph registers its scoped execution callback here; hook
  // callbacks in the sibling app graph can then wake the same coordinator.
  SessionRewakeBridge.node,
  // HookRewake live node: async hook rewake delivery (hook-async-rewake).
  // Same app-graph-level placement rationale as SettingsHook above — settings.ts
  // resolves HookRewake.Service via serviceOption from the ambient request
  // context, so it must be present in this graph or server-driven sessions
  // would silently skip rewake.
  HookRewakeLive.node,
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
  // (app-runtime.ts provideMerge), so headless serve/web, the desktop
  // sidecar, and non-CWD TUI directories never armed goal continuation or
  // the crash-recovery scan: standing goals stalled after their first turn.
  GoalLoop.node,
  // DagSupervisionSweep: host-level deadline supervision (2026-08-18
  // orphaned-nodes incident) was constructed only in AppLayer, but the
  // desktop sidecar (packages/desktop/src/main/sidecar.ts) calls
  // Server.listen without effectCmd, so AppLayer never existed there and
  // the sweep never ran on the desktop default path (issue #341). Listing
  // it here makes every serving process build it with the listener scope.
  // Processes that also build AppLayer (serve/web via AppRuntime) get a
  // second instance; settle is convergent (withWorkflowLock + guardNode +
  // conditional projector UPDATE), so the duplicate is safe — see the sweep
  // header's multi-host convergence notes.
  DagSupervisionSweep.node,
  // EventResidueSweep (#524): default-on startup residue sweep for crash/
  // in-flight zombie event aggregates. Same app-graph-level placement
  // rationale as DagSupervisionSweep above — the desktop sidecar and headless
  // serving processes build this node graph without AppLayer, and the sweep
  // is idempotent (a second pass in AppLayer processes removes nothing).
  EventResidueSweep.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(LayerNode.buildLayer(app)),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
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
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
