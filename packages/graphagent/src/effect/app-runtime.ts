import { SessionAttention } from "@/notification/attention"
import { Notification } from "@/notification"
import { HookCwd } from "@/hook/cwd"
import { HookTodo } from "@/hook/todo"
import { HookConfigChange } from "@/hook/config-change"
import { SessionHooks } from "@/hook/session-hooks"
import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@graphagent/core/observability"

import { FSUtil } from "@graphagent/core/fs-util"
import { Database } from "@graphagent/core/database/database"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { ModelsDev } from "@graphagent/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAdapters } from "@/provider/adapter/registry"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { TodoReminders } from "@/session/todo-reminders"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionBtw } from "@/session/btw"
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
import { ProjectTrust } from "@/project/trust/service"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { SessionLifecycle } from "@/session/lifecycle"
import { Npm } from "@graphagent/core/npm"
import { memoMap } from "@graphagent/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { BackgroundLifecycle } from "@/background/lifecycle"
import { GoalLifecycle } from "@/goal/lifecycle"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { SettingsHook } from "@/hook"
import { HookRewakeLive } from "@/hook/rewake-live"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagLoop } from "@/dag/runtime/loop"
import { DagNodePublisher } from "@/dag/runtime/node-publisher"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { EventResidueSweep } from "@graphagent/core/event/residue-sweep"
import { Memory } from "@/memory/memory"
import { SessionInbox } from "@/session/inbox"
import { AgentScheduler } from "@/session/agent-scheduler"
import { ToolSourceLedger } from "@/session/tool-source-ledger"
import { Lifecycle } from "@/lifecycle/service"

const BaseAppLayer = Layer.mergeAll(
  Layer.mergeAll(
    Npm.defaultLayer,
    FSUtil.defaultLayer,
    Database.defaultLayer,
    Auth.defaultLayer,
    Config.defaultLayer,
    Git.defaultLayer,
    Storage.defaultLayer,
    Snapshot.defaultLayer,
    ModelsDev.defaultLayer,
    Provider.defaultLayer,
    ProviderAuth.defaultLayer,
    Agent.defaultLayer,
    Skill.defaultLayer,
    Discovery.defaultLayer,
    Question.defaultLayer,
    Permission.defaultLayer,
    Todo.defaultLayer,
    TodoReminders.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)),
    Goal.defaultLayer,
    Memory.defaultLayer,
    ToolSourceLedger.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    SessionInbox.defaultLayer,
    AgentScheduler.defaultLayer,
    BackgroundJob.defaultLayer,
    RuntimeFlags.defaultLayer,
    EventV2Bridge.defaultLayer,
    Lifecycle.defaultLayer,
    SessionRunState.defaultLayer,
    DagStore.defaultLayer,
    DagMessages.defaultLayer,
    Dag.defaultLayer,
    DagControl.defaultLayer,
  ),
  Layer.mergeAll(
    SessionProcessor.defaultLayer,
    SessionCompaction.defaultLayer,
    SessionRevert.defaultLayer,
    SessionBtw.defaultLayer,
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
    ProjectTrust.defaultLayer,
    Vcs.defaultLayer,
    Workspace.defaultLayer,
    Worktree.appLayer,
    Installation.defaultLayer,
    SessionLifecycle.defaultLayer,
    HookStartContext.defaultLayer,
  ),
).pipe(
  Layer.provideMerge(HookLifecycle.defaultLayer),
  Layer.provideMerge(HookFileWatch.defaultLayer),
  Layer.provideMerge(HookConfigChange.defaultLayer),
  // HookCwd transfers session hooks across a directory move; SettingsHook
  // already builds this same layer internally, so memoization keeps one store.
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
  // Provider adapters read Session.Service for Copilot request attribution.
  // Provide them after the instance/session group is assembled.
  Layer.provideMerge(ProviderAdapters.defaultLayer),
  // GoalLoop + SettingsHook go in provideMerge (NOT mergeAll) because they need
  // services from BOTH group1 and group2. mergeAll siblings cannot see each
  // other's outputs, but provideMerge gives the layer access to the full
  // accumulated context (group1 + group2 merged). Both self-provide part of
  // their transitive chain (GoalLoop in loop.ts, SettingsHook via
  // SessionHooks.defaultLayer); the remainder resolves from this ambient context.
  Layer.provideMerge(GoalLoop.defaultLayer),
  Layer.provideMerge(DagLoop.defaultLayer),
  Layer.provideMerge(DagSummaryPublisher.defaultLayer),
  Layer.provideMerge(DagNodePublisher.defaultLayer),
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
  // #1069 P7: register the job domain with the lifecycle service. Its
  // defaultLayer self-provides BackgroundJob and Lifecycle; memoMap dedups them
  // with the instances built above.
  Layer.provideMerge(BackgroundLifecycle.defaultLayer),
  // #1069 scope 3: the goal domain resolver reads the durable goal row on
  // every query. Self-providing Goal + Lifecycle keeps it on the same
  // instances as the rest of the runtime.
  Layer.provideMerge(GoalLifecycle.defaultLayer),
)

export const AppLayer = Layer.mergeAll(HookCwd.layer, HookTodo.layer).pipe(Layer.provideMerge(BaseAppLayer))

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
