import { NodeFileSystem } from "@effect/platform-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FetchHttpClient } from "effect/http"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Storage } from "@/storage/storage"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { Image } from "@/image/image"
import { Snapshot } from "@/snapshot"
import { Agent as AgentSvc } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { Todo } from "@/session/todo"
import { Question } from "@/question"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { SettingsHook } from "@/hook/settings"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Memory } from "@/memory/memory"
import { ToolSourceLedger } from "@/session/tool-source-ledger"
import { Skill } from "@/skill"
import { Goal } from "@/goal/goal"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testProviderConfig } from "../lib/test-provider"
import { countingAppProcessLayer, countingDatabaseLayer, countingEventLayer } from "../lib/engine-probe"
import type { FakeProvider } from "../lib/fake-provider"

// Layer graph for the H0 scenarios. It mirrors test/session/prompt-empty.test.ts
// (the smallest SessionPrompt harness) with production defaults for runtime
// flags and two substitutions:
//   - the database and event bus come from test/lib/engine-probe.ts;
//   - `LLM.Service` is the scripted engine-probe provider, so no sockets or
//     test LLM server are involved.
// SessionSummary stays stubbed for S1: summary generation is measured by the
// compaction scenarios (S2/S3), not by the fixed 50-message single session.

const dbLayer = countingDatabaseLayer
const eventLayer = countingEventLayer(EventV2.layer.pipe(Layer.provide(dbLayer)))
const bridgeLayer = Layer.fresh(EventV2Bridge.layer).pipe(Layer.provide(eventLayer))

export const perfConfig = testProviderConfig("http://localhost:1/v1")

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in perf tests"),
    authenticate: () => Effect.die("unexpected MCP auth in perf tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in perf tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const hookRecorderLayer = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: () =>
      Effect.succeed({
        blocked: undefined,
        preventContinuation: false,
        permissionDecision: undefined,
        permissionDecisionReason: undefined,
        additionalContexts: [],
        systemMessages: [],
        hookSpecificOutput: undefined,
      }),
    list: () => Effect.succeed([]),
  }),
)

const memoryLayer = Layer.mock(Memory.Service, {
  init: () => Effect.void,
  prepare: () => Effect.void,
  context: () => Effect.succeed([]),
  checkpoint: () => Effect.succeed([]),
  setEnabled: (enabled) => Effect.succeed(enabled ? ("Memory on" as const) : ("Memory off" as const)),
  statusReason: () => Effect.succeed(undefined),
  status: () => Effect.succeed("Memory on"),
})

// Explicit production defaults: RuntimeFlags.layer() resolves an empty
// ConfigProvider, so it ignores preload environment variables and the
// experimentalWorkspaces opt-in used by the shared test preload.
const flags = RuntimeFlags.layer()

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const snapshot = Snapshot.layer.pipe(
  Layer.provide(countingAppProcessLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(bridgeLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))

// Session.defaultLayer self-provides Database.defaultLayer and
// EventV2Bridge.defaultLayer, which would bypass the probe. Compose the bare
// Session.layer against the counting database and event bus instead (same
// composition as test/session/fork-batch.test.ts).
const projectorLayer = SessionProjector.layer.pipe(Layer.provide(eventLayer), Layer.provide(dbLayer))
const sessionLayer = Session.layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(dbLayer),
  Layer.provide(bridgeLayer),
  Layer.provide(projectorLayer),
  Layer.provide(flags),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(SessionAutomationLease.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
)

const deps = Layer.mergeAll(
  dbLayer,
  bridgeLayer,
  hookRecorderLayer,
  memoryLayer,
  sessionLayer,
  snapshot,
  Env.defaultLayer,
  AgentSvc.defaultLayer,
  Command.defaultLayer,
  Permission.defaultLayer,
  Config.defaultLayer,
  ProviderSvc.defaultLayer,
  lsp,
  mcp,
  FSUtil.defaultLayer,
  BackgroundJob.defaultLayer,
  status,
  DagMessages.defaultLayer,
  DagStore.defaultLayer,
  ToolSourceLedger.defaultLayer,
).pipe(Layer.provideMerge(infra))

const question = Question.layer.pipe(Layer.provideMerge(deps))
const todo = Todo.layer.pipe(Layer.provideMerge(deps))
const makeRegistry = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  ToolRegistry.layer.pipe(
    Layer.provide(DagAgentMessages.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Dag.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(spawner),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
const registry = makeRegistry(CrossSpawnSpawner.defaultLayer)
const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))

export interface PerfLayerOptions {
  /**
   * Spawner used by the shell tool inside the registry. S6 passes a fake shell
   * so a long command runs on TestClock; everything else keeps the real
   * spawner (git, ripgrep, snapshot).
   */
  readonly shell?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
}

/** Build the perf layer for one fake provider instance. */
export function makePerfLayer(
  provider: FakeProvider,
  options?: PerfLayerOptions,
): Layer.Layer<SessionPrompt.Service | Session.Service, never, never> {
  const registryLayer = options?.shell ? makeRegistry(options.shell) : registry
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provideMerge(provider.layer),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(Goal.defaultLayer),
    Layer.provide(
      SystemPrompt.layer.pipe(
        Layer.provide(Skill.defaultLayer),
        Layer.provide(LocationServiceMap.layer),
        Layer.provide(Goal.defaultLayer),
        Layer.provide(deps),
      ),
    ),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}
