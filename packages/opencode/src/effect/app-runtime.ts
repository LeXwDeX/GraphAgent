import { SessionAttention } from "@/notification/attention"
import { HookAttentionHost } from "@/notification/attention-host"
import { Notification } from "@/notification"
import { HookCwd } from "@/hook/cwd"
import { HookModelSwitch } from "@/hook/model-switch"
import { HookV2Conversation } from "@/hook/v2-conversation"
import { HookV2Turn } from "@/hook/v2-turn"
import { HookV2Compaction } from "@/hook/v2-compaction"
import { HookV2Lifecycle } from "@/hook/v2-lifecycle"
import { HookTodo } from "@/hook/todo"
import { HookConfigChange } from "@/hook/config-change"
import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { SettingsHook } from "@/hook/settings"
import { HookRewakeLive } from "@/hook/rewake-live"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import { Dag } from "@/dag/dag"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagLoop } from "@/dag/runtime/loop"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { EventResidueSweep } from "@opencode-ai/core/event/residue-sweep"
import { Memory } from "@/memory/memory"
import { ToolSourceLedger } from "@/session/tool-source-ledger"

const BaseAppLayer = Layer.mergeAll(
  Layer.mergeAll(
    Npm.defaultLayer,
    FSUtil.defaultLayer,
    Database.defaultLayer,
    Auth.defaultLayer,
    Account.defaultLayer,
    Config.defaultLayer,
    Git.defaultLayer,
    Storage.defaultLayer,
    Snapshot.defaultLayer,
    Plugin.defaultLayer,
    ModelsDev.defaultLayer,
    Provider.defaultLayer,
    ProviderAuth.defaultLayer,
    Agent.defaultLayer,
    Skill.defaultLayer,
    Discovery.defaultLayer,
    Question.defaultLayer,
    Permission.defaultLayer,
    Todo.defaultLayer,
    Goal.defaultLayer,
    Memory.defaultLayer,
    ToolSourceLedger.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    BackgroundJob.defaultLayer,
    RuntimeFlags.defaultLayer,
    EventV2Bridge.defaultLayer,
    SessionRunState.defaultLayer,
    DagStore.defaultLayer,
    DagMessages.defaultLayer,
    Dag.defaultLayer,
  ),
  Layer.mergeAll(
    SessionProcessor.defaultLayer,
    SessionCompaction.defaultLayer,
    SessionRevert.defaultLayer,
    SessionSummary.defaultLayer,
    SessionPrompt.defaultLayer,
    HookRewakeLive.liveLayer,
    Instruction.defaultLayer,
    LLM.defaultLayer,
    LSP.defaultLayer,
    MCP.defaultLayer,
    McpAuth.defaultLayer,
    Command.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Format.defaultLayer,
    Project.defaultLayer,
    Vcs.defaultLayer,
    Workspace.defaultLayer,
    Worktree.appLayer,
    Installation.defaultLayer,
    ShareNext.defaultLayer,
    SessionShare.defaultLayer,
    HookStartContext.defaultLayer,
  ),
).pipe(
  Layer.provideMerge(HookLifecycle.defaultLayer),
  Layer.provideMerge(HookFileWatch.defaultLayer),
  Layer.provideMerge(HookConfigChange.defaultLayer),
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
  // GoalLoop + SettingsHook go in provideMerge (NOT mergeAll) because they need
  // services from BOTH group1 and group2. mergeAll siblings cannot see each
  // other's outputs, but provideMerge gives the layer access to the full
  // accumulated context (group1 + group2 merged). Both self-provide part of
  // their transitive chain (GoalLoop in loop.ts, SettingsHook via
  // SessionHooks.defaultLayer); the remainder resolves from this ambient context.
  Layer.provideMerge(GoalLoop.defaultLayer),
  Layer.provideMerge(DagLoop.defaultLayer),
  Layer.provideMerge(DagSummaryPublisher.defaultLayer),
  // Host-level deadline-supervision sweep (production incident 2026-08-18):
  // forks its repeating fiber at construction into the LAYER scope — unlike
  // DagLoop it must NOT die with a per-directory instance teardown, or a
  // `running` node with dead supervision would rot forever.
  Layer.provideMerge(DagSupervisionSweep.defaultLayer),
  // #524: default-on startup residue sweep for crash/in-flight zombie event
  // aggregates (both read models absent). Host-level like the supervision
  // sweep: one pass per process start, forked into the layer scope,
  // soft-degrading — never blocks or fails startup.
  Layer.provideMerge(EventResidueSweep.defaultLayer),
  Layer.provideMerge(SettingsHook.defaultLayer),
  Layer.provideMerge(Notification.defaultLayer),
  Layer.provideMerge(SessionAttention.defaultLayer),
)

export const AppLayer = Layer.mergeAll(
  HookAttentionHost.layer,
  HookCwd.layer,
  HookTodo.layer,
  HookModelSwitch.layer,
  HookV2Conversation.layer,
  HookV2Turn.layer,
  HookV2Compaction.layer,
  HookV2Lifecycle.layer,
).pipe(Layer.provideMerge(BaseAppLayer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
