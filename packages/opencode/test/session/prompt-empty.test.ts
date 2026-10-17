import { NodeFileSystem } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionRunState } from "../../src/session/run-state"
import { SessionRevert } from "../../src/session/revert"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { SystemPrompt } from "../../src/session/system"
import { Image } from "../../src/image/image"
import { Snapshot } from "../../src/snapshot"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { Todo } from "../../src/session/todo"
import { Question } from "../../src/question"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Memory } from "@/memory/memory"
import { ToolSourceLedger } from "@/session/tool-source-ledger"
import { Skill } from "../../src/skill"
import { Goal } from "@/goal/goal"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { EventV2Bridge } from "@/event-v2-bridge"
import { it } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent } from "@opencode-ai/llm"
import { Stream } from "effect"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

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
    startAuth: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const hookRecorded: HookPayload[] = []
const hookRecorderLayer = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.gen(function* () {
        hookRecorded.push(payload)
        return {
          blocked: undefined,
          preventContinuation: false,
          permissionDecision: undefined,
          permissionDecisionReason: undefined,
          additionalContexts: [],
          systemMessages: [],
          hookSpecificOutput: undefined,
        }
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const flags = RuntimeFlags.layer({ experimentalEventSystem: true })

const deps = Layer.mergeAll(
  hookRecorderLayer,
  memoryLayer,
  Session.defaultLayer,
  Snapshot.defaultLayer,
  Env.defaultLayer,
  AgentSvc.defaultLayer,
  Command.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  ProviderSvc.defaultLayer,
  lsp,
  mcp,
  FSUtil.defaultLayer,
  BackgroundJob.defaultLayer,
  status,
  Database.defaultLayer,
  DagMessages.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  ToolSourceLedger.defaultLayer,
).pipe(Layer.provideMerge(infra))

const question = Question.layer.pipe(Layer.provideMerge(deps))
const todo = Todo.layer.pipe(Layer.provideMerge(deps))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(DagAgentMessages.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(flags),
  Layer.provideMerge(todo),
  Layer.provideMerge(question),
  Layer.provideMerge(deps),
)
const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))

const makePrompt = (llmLayer: Layer.Layer<LLM.Service>) => {
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provideMerge(llmLayer),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
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

const emptyUnknown: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  LLMEvent.finish({ reason: "unknown" }),
]

const validScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "done" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

it.instance(
  "session.prompt loop retries an empty response and finishes the same turn with real content",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const llmLayer = Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          organizer: () => Effect.succeed(undefined),
          stream: () => {
            const script = calls === 0 ? emptyUnknown : validScript
            calls += 1
            return Stream.fromIterable(script)
          },
        }),
      )
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Empty retry" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "say something" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(looped.info.role).toBe("assistant")
        if (looped.info.role !== "assistant") throw new Error("expected an assistant reply")
        expect(looped.info.finish).toBe("stop")
        expect(looped.info.error).toBeUndefined()
        expect(looped.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(calls).toBe(2)

        // Single-turn history: exactly one user and one assistant message.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages).toHaveLength(2)
        expect(messages[0]?.info.role).toBe("user")
        expect(messages[1]?.info.role).toBe("assistant")
        expect(messages[1]?.info.id).toBe(looped.info.id)
      }).pipe(Effect.provide(makePrompt(llmLayer)))
    }),
  { config: cfg },
)
