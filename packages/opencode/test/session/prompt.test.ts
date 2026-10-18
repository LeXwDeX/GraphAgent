import { NodeFileSystem } from "@effect/platform-node"
import { disposeInstance } from "@/effect/instance-registry"
import { createHash } from "node:crypto"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { eq, sql } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { InstanceState } from "@/effect/instance-state"
import { Goal } from "@/goal/goal"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Truncate } from "@/tool/truncate"
import { SettingsHook, type HookPayload, type TriggerResult } from "@/hook/settings"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookTranscript } from "@/hook/transcript"
import { Global } from "@opencode-ai/core/global"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { decodeRecord, decodeRecords, decodeString } from "../lib/hook-json"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Memory } from "@/memory/memory"
import { ToolSourceLedger } from "@/session/tool-source-ledger"
import { Auth } from "@/auth"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { jsonSchema, tool as aiTool, type Tool as AITool } from "ai"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = [], tools: Record<string, AITool> = {}, ready = Effect.void) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => ready.pipe(Effect.as(tools)),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []

// Recording SettingsHook stub (hook-event-wiring 4.2): captures Stop/StopFailure
// trigger payloads from the prompt loop without executing real hooks.
const hookRecorded: HookPayload[] = []
// Test-only opt-in: when > 0, the recorder returns a block decision for the next
// N Stop triggers (drives the Stop-hook continuation path so stop_hook_active can
// be observed transitioning false → true). Defaults to 0 (never block).
let stopBlockNext = 0
// Test-only controls for the hooks-stop-continuation-fidelity regression tests.
// All default inert so existing tests are unaffected.
//   stopBlockAlways       — every Stop blocks (hard-limit test)
//   stopSystemMessages    — returned on every Stop (systemMessage-outlet test)
//   stopAdditionalContexts— returned on every Stop (additionalContext test)
//   subagentStopBlockAlways— every SubagentStop blocks (SubagentStop hard-limit test)
let stopBlockAlways = false
let stopPreventContinuation = false
let stopSystemMessages: string[] = []
let stopAdditionalContexts: string[] = []
let subagentStopBlockAlways = false
let hookOverride: ((payload: HookPayload) => TriggerResult | undefined) | undefined
let userPromptAdmissionStarted: Deferred.Deferred<void> | undefined
let userPromptAdmissionGate: Deferred.Deferred<void> | undefined
let snapshotFenceStarted: Deferred.Deferred<void> | undefined
let snapshotFenceGate: Deferred.Deferred<void> | undefined
const hookRecorderLayer = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.gen(function* () {
        hookRecorded.push(payload)
        const override = hookOverride?.(payload)
        if (override) return override
        if (
          payload.event === "UserPromptSubmit" &&
          payload.prompt.includes("hold-human-admission") &&
          userPromptAdmissionStarted &&
          userPromptAdmissionGate
        ) {
          yield* Deferred.succeed(userPromptAdmissionStarted, undefined).pipe(Effect.ignore)
          yield* Deferred.await(userPromptAdmissionGate)
        }
        let blocked: { reason: string; command: string } | undefined
        if (payload.event === "Stop") {
          if (stopBlockAlways || stopBlockNext > 0) {
            if (!stopBlockAlways) stopBlockNext--
            blocked = { reason: "test: stop-hook block", command: "recorder" }
          }
        }
        if (payload.event === "SubagentStop" && subagentStopBlockAlways) {
          blocked = { reason: "test: subagent-stop block", command: "recorder" }
        }
        const systemMessages = payload.event === "Stop" ? stopSystemMessages : []
        const additionalContexts = payload.event === "Stop" && !payload.stopHookActive ? stopAdditionalContexts : []
        return {
          blocked,
          preventContinuation:
            (payload.event === "Stop" || payload.event === "SubagentStop") && stopPreventContinuation,
          permissionDecision: undefined,
          permissionDecisionReason: undefined,
          additionalContexts,
          systemMessages,
          hookSpecificOutput: undefined,
        }
      }),
    list: () => Effect.succeed([]),
  }),
)
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const fencedAgent: AgentSvc.Info = {
  name: "build",
  mode: "primary",
  permission: [],
  options: {},
}
const snapshotFenceAgentLayer: Layer.Layer<AgentSvc.Service> = Layer.succeed(
  AgentSvc.Service,
  AgentSvc.Service.of({
    get: () =>
      Effect.gen(function* () {
        if (snapshotFenceStarted && snapshotFenceGate) {
          yield* Deferred.succeed(snapshotFenceStarted, undefined).pipe(Effect.ignore)
          yield* Deferred.await(snapshotFenceGate)
        }
        return fencedAgent
      }),
    list: () => Effect.succeed([fencedAgent]),
    defaultInfo: () => Effect.succeed(fencedAgent),
    defaultAgent: () => Effect.succeed("build"),
    permissionPolicy: () => Effect.succeed({ native: [], rules: fencedAgent.permission }),
    generate: () => Effect.die("not used by snapshot fence regression"),
  }),
)

type PromptLayerOptions = {
  settingsHookLayer?: Layer.Layer<SettingsHook.Service>
  observeMessages?: (input: Parameters<Session.Interface["messages"]>[0]) => void
  organizer?: LLM.Interface["organizer"]
  mcpInstructions?: MCP.ServerInstructions[]
  mcpTools?: Record<string, AITool>
  toolsReady?: Effect.Effect<void>
  processor?: "blocking"
  goal?: boolean
  goalLayer?: Layer.Layer<Goal.Service>
  memoryPrepare?: Memory.Interface["prepare"]
  memoryContext?: string[]
  agentLayer?: Layer.Layer<AgentSvc.Service>
  ripgrepLayer?: Layer.Layer<Ripgrep.Service>
  native?: boolean
  experimentalBackgroundSubagents?: boolean
}

function makePrompt(input?: PromptLayerOptions) {
  const flags = RuntimeFlags.layer({
    experimentalEventSystem: true,
    experimentalBackgroundSubagents: input?.experimentalBackgroundSubagents ?? false,
  })
  // goal: false exercises the Goal-absent degradation path (serviceOption None)
  const goalLayer: Layer.Layer<Goal.Service> =
    input?.goal === false
      ? (Layer.empty as unknown as Layer.Layer<Goal.Service>)
      : (input?.goalLayer ?? Goal.defaultLayer)
  const memoryLayer = Layer.mock(Memory.Service, {
    init: () => Effect.void,
    prepare: input?.memoryPrepare ?? (() => Effect.void),
    context: () => Effect.succeed(input?.memoryContext ?? []),
    checkpoint: () => Effect.succeed(input?.memoryContext ?? []),
    setEnabled: (enabled) => Effect.succeed(enabled ? ("Memory on" as const) : ("Memory off" as const)),
    statusReason: () => Effect.succeed(undefined),
    status: () => Effect.succeed("Memory on"),
  })
  const baseLLM = input?.native
    ? LLM.layer.pipe(
        Layer.provide(Auth.defaultLayer),
        Layer.provide(Config.defaultLayer),
        Layer.provide(ProviderSvc.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(
          LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
        ),
        Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true })),
      )
    : LLM.defaultLayer
  const llmLayer = input?.organizer
    ? Layer.effect(
        LLM.Service,
        Effect.gen(function* () {
          const service = yield* LLM.Service
          return LLM.Service.of({ ...service, organizer: input.organizer! })
        }),
      ).pipe(Layer.provide(baseLLM))
    : baseLLM
  const sessionLayer = input?.observeMessages
    ? Layer.effect(
        Session.Service,
        Effect.gen(function* () {
          const service = yield* Session.Service
          return Session.Service.of({
            ...service,
            messages: (request) =>
              Effect.suspend(() => {
                input.observeMessages?.(request)
                return service.messages(request)
              }),
          })
        }),
      ).pipe(Layer.provide(Session.defaultLayer))
    : Session.defaultLayer
  const deps = Layer.mergeAll(
    input?.settingsHookLayer ?? hookRecorderLayer,
    HookLifecycle.defaultLayer,
    memoryLayer,
    sessionLayer,
    Snapshot.defaultLayer,
    llmLayer,
    Env.defaultLayer,
    input?.agentLayer ?? AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    makeMcp(input?.mcpInstructions, input?.mcpTools, input?.toolsReady),
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
    Layer.provide(input?.ripgrepLayer ?? Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(flags),
          Layer.provideMerge(deps),
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
    Layer.provideMerge(goalLayer),
    Layer.provide(
      SystemPrompt.layer.pipe(
        Layer.provide(Skill.defaultLayer),
        Layer.provide(LocationServiceMap.layer),
        Layer.provide(goalLayer),
        Layer.provide(deps),
      ),
    ),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: PromptLayerOptions) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: PromptLayerOptions) {
  return makePrompt(input)
}

// Real rg file enumeration order varies by platform; positive folding fixtures require byte-identical glob output.
const stableGlobRipgrepLayer = Layer.effect(
  Ripgrep.Service,
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    return Ripgrep.Service.of({
      ...ripgrep,
      glob: (input) =>
        ripgrep
          .glob(input)
          .pipe(
            Effect.map((entries) =>
              [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
            ),
          ),
    })
  }),
).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(makeHttp())
const nativeIt = testEffect(makeHttp({ native: true }))
const backgroundIt = testEffect(makeHttp({ experimentalBackgroundSubagents: true }))
const stableFoldingIt = testEffect(makeHttp({ ripgrepLayer: stableGlobRipgrepLayer }))
const stableNativeFoldingIt = testEffect(makeHttp({ native: true, ripgrepLayer: stableGlobRipgrepLayer }))
const mcpOverrideMarker = `mcp-context-folding-override-${"m".repeat(24_000)}`
const withMcpReadOverride = testEffect(
  makeHttp({
    mcpTools: {
      read: aiTool({
        description: "MCP read override",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ content: [{ type: "text" as const, text: mcpOverrideMarker }] }),
      }),
    },
  }),
)
const noLLMServer = testEffect(makeHttpNoLLMServer())
const withOversizedToolSchema = testEffect(
  makeHttp({
    mcpTools: {
      oversized_schema: aiTool({
        description: "oversized tool ".repeat(6_000),
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      }),
    },
  }),
)
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const snapshotFenceNoLLMServer = testEffect(makeHttpNoLLMServer({ agentLayer: snapshotFenceAgentLayer }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const withMemoryContext = testEffect(
  makeHttp({ memoryContext: ["<project_memory_data>project-memory-probe</project_memory_data>"] }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const backgroundUnix = process.platform !== "win32" ? backgroundIt.instance : backgroundIt.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function foldingProviderCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    compaction: { auto: false },
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        models: {
          ...base.provider.test.models,
          "test-model": {
            ...base.provider.test.models["test-model"],
            limit: { context: 12_000, output: 1_000 },
          },
        },
      },
    },
  }
}

function foldingAutoProviderCfg(url: string) {
  return {
    ...foldingProviderCfg(url),
    compaction: { auto: true, dynamic: true },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const foldingReadBody = (marker: string) =>
  `${Array.from({ length: 28 }, (_, index) => `${marker}${String(index).padStart(2, "0")}-${"r".repeat(960)}`).join("\n")}\n`

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const outboundToolResult = (body: unknown, callID: string) => {
  if (!record(body) || !Array.isArray(body.messages)) return undefined
  const matches: string[] = []
  for (const message of body.messages) {
    if (
      record(message) &&
      message.role === "tool" &&
      message.tool_call_id === callID &&
      typeof message.content === "string"
    ) {
      matches.push(message.content)
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

const foldedPlaceholder = (witnessCallID: string) =>
  `[Duplicate tool output folded. Identical full output is retained in later tool call ${JSON.stringify(witnessCallID)}.]`

const outputFingerprint = (output: string | undefined) =>
  output === undefined
    ? "missing"
    : `bytes=${Buffer.byteLength(output, "utf8")} sha256=${createHash("sha256").update(output).digest("hex")}`

const expectFoldedBuiltinPair = (input: {
  tool: "read" | "grep" | "glob"
  body: unknown
  sourceCallID: string
  sourceOutput: string
  witnessCallID: string
  witnessOutput: string
}) => {
  const outboundSource = outboundToolResult(input.body, input.sourceCallID)
  const outboundWitness = outboundToolResult(input.body, input.witnessCallID)
  const expectedSource = foldedPlaceholder(input.witnessCallID)
  const storedIdentical = input.sourceOutput === input.witnessOutput
  const sourceFolded = outboundSource === expectedSource
  const witnessIntact = outboundWitness === input.witnessOutput
  if (storedIdentical && sourceFolded && witnessIntact) return
  throw new Error(
    [
      `context folding ${input.tool} pair mismatch`,
      `storedIdentical=${storedIdentical}`,
      `sourceFolded=${sourceFolded}`,
      `witnessIntact=${witnessIntact}`,
      `storedSource(${outputFingerprint(input.sourceOutput)})`,
      `storedWitness(${outputFingerprint(input.witnessOutput)})`,
      `outboundSource(${outputFingerprint(outboundSource)})`,
      `outboundWitness(${outputFingerprint(outboundWitness)})`,
    ].join("; "),
  )
}

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const seedAgentConversation = Effect.fn("test.seedAgentConversation")(function* () {
  const sessions = yield* Session.Service
  const instance = yield* InstanceState.context
  const { db } = yield* Database.Service
  const parent = yield* sessions.create({ title: "DAG parent" })
  const child = yield* sessions.create({ parentID: parent.id, title: "DAG child" })
  const workflowID = `dag-${parent.id}`
  yield* db.run(sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated)
    VALUES (${workflowID},${instance.project.id},${parent.id},${instance.directory},'Messaging','running','{}',1,1,1)`)
  yield* db.run(sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated)
    VALUES ('worker',${workflowID},'Worker','task','running','[]',${child.id},1,1,1)`)
  const identity = { projectID: instance.project.id, directory: instance.directory }
  return {
    parent,
    child,
    workflowID,
    parentCaller: { ...identity, sessionID: parent.id },
    childCaller: { ...identity, sessionID: child.id },
  }
})

const answerPreparedAgentQuestion = Effect.fn("test.answerPreparedAgentQuestion")(function* (input: {
  prepared: SessionPrompt.IdleAdmission
  parentID: SessionID
  parentCaller: DagMessages.Caller
  question: string
  childPrompt: ReturnType<SessionPrompt.Interface["prompt"]>
  questionTimeout?: Duration.Input
  beforeActivate?: Effect.Effect<unknown, Error>
}) {
  const mailbox = yield* DagMessages.Service
  const status = yield* SessionStatus.Service
  yield* Effect.addFinalizer(() => input.prepared.abort)
  const child = yield* input.childPrompt.pipe(Effect.forkScoped)
  const accepted = yield* pollWithTimeout(
    mailbox
      .receive(input.parentCaller)
      .pipe(
        Effect.map((received) =>
          received.ok ? received.value.find((message) => message.content === input.question) : undefined,
        ),
      ),
    "node question was never durably accepted",
    input.questionTimeout,
  )
  expect(accepted.state).toBe("queued")
  expect(yield* status.get(input.parentID)).toMatchObject({ type: "busy" })
  if (input.beforeActivate) yield* input.beforeActivate
  yield* input.prepared.activate
  yield* input.prepared.result
  const result = yield* Fiber.join(child)
  expect(result.info.role).toBe("assistant")
  if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
  return accepted
})

it.instance("DAG prepared parent answers while its node is waiting without acknowledging a mailbox read", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const { parent, child, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    const question = "DAG_WAITING_NODE_QUESTION"
    const answer = "DAG_PREPARED_PARENT_ANSWER"
    const fromChild = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("DAG_WAITING_CHILD")
    const fromParent = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("DAG_PREPARED_MAIN")
    yield* llm.toolMatch(fromChild, "agent", {
      params: {
        action: "send",
        workflow_id: workflowID,
        recipient: "parent",
        idempotency_key: "waiting-question",
        content: question,
      },
    })
    yield* llm.toolMatch(fromChild, "agent", {
      params: { action: "receive", workflow_id: workflowID, wait_ms: 30_000 },
    })
    yield* llm.textMatch(fromChild, "Node received its answer")
    yield* llm.toolMatch(fromParent, "agent", {
      params: {
        action: "send",
        workflow_id: workflowID,
        recipient: "node",
        node_id: "worker",
        attempt_id: DagMessages.nodeAttemptID(child.id, 0),
        idempotency_key: "waiting-answer",
        content: answer,
      },
    })
    yield* llm.textMatch(fromParent, "Main answered")
    const prepared = yield* prompt.prepareIfIdle({
      sessionID: parent.id,
      model: ref,
      parts: [{ type: "text", text: "DAG_PREPARED_MAIN" }],
    })
    if (Option.isNone(prepared)) throw new Error("Synthetic main admission was unexpectedly busy")
    const accepted = yield* answerPreparedAgentQuestion({
      prepared: prepared.value,
      parentID: parent.id,
      parentCaller,
      question,
      childPrompt: prompt.prompt({
        sessionID: child.id,
        model: ref,
        parts: [{ type: "text", text: "DAG_WAITING_CHILD" }],
      }),
      beforeActivate: pollWithTimeout(
        sessions
          .messages({ sessionID: child.id })
          .pipe(
            Effect.map((history) =>
              history
                .flatMap((message) => message.parts)
                .some(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === "agent" &&
                    part.state.status === "running" &&
                    part.state.input.params &&
                    record(part.state.input.params) &&
                    part.state.input.params.action === "receive",
                )
                ? true
                : undefined,
            ),
          ),
        "node did not wait for the main answer",
      ),
    })
    expect(accepted).toMatchObject({ sender: { sessionID: child.id }, recipient: { sessionID: parent.id } })
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ id: accepted.id, state: "delivered" }] })
    expect(yield* mailbox.receive(childCaller)).toMatchObject({
      value: [
        { content: answer, state: "delivered", sender: { sessionID: parent.id }, recipient: { sessionID: child.id } },
      ],
    })
    const inputs = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(inputs.filter(fromChild)).toHaveLength(3)
    expect(inputs.filter(fromParent)).toHaveLength(2)
    expect(JSON.stringify(inputs.filter(fromChild).at(-1)?.body)).toContain(answer)
  }),
)

it.instance("DAG messages enter an actual model input once and receive does not acknowledge them", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    yield* prompt.prompt({
      sessionID: parent.id,
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "DAG initial context" }],
    })
    const accepted = yield* mailbox.send(childCaller, {
      workflowID,
      idempotencyKey: "report",
      content: "DAG_CHILD_REPORT",
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error(accepted.reason)
    const before = yield* mailbox.receive(parentCaller)
    expect(before).toMatchObject({ value: [{ state: "queued" }] })
    yield* llm.text("report acknowledged")
    yield* prompt.loop({ sessionID: parent.id })
    const requests = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].body)).toContain("dag_agent_message")
    expect(JSON.stringify(requests[0].body)).toContain("DAG_CHILD_REPORT")
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ state: "delivered" }] })
    yield* prompt.loop({ sessionID: parent.id })
    const history = yield* sessions.messages({ sessionID: parent.id })
    expect(
      history.flatMap((message) => message.parts).filter((part) => part.id === accepted.value.partID),
    ).toHaveLength(1)
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(1)
  }),
)

it.instance("DAG late input continues the same child after a clean result without repeating prior input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const mailbox = yield* DagMessages.Service
    const { child, parentCaller, childCaller, workflowID } = yield* seedAgentConversation()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    yield* llm.hold("old result", gate)
    yield* llm.text("new result includes update")
    const running = yield* prompt
      .prompt({ sessionID: child.id, model: ref, parts: [{ type: "text", text: "DAG child initial context" }] })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.hits.pipe(
        Effect.map((hits) =>
          hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
            ? true
            : undefined,
        ),
      ),
      "child model never started",
    )
    const request = {
      workflowID,
      nodeID: "worker",
      attemptID: DagMessages.nodeAttemptID(child.id, 0),
      idempotencyKey: "late-update",
      content: "DAG_LATE_UPDATE",
    }
    const accepted = yield* mailbox.send(parentCaller, request)
    expect(accepted.ok).toBe(true)
    expect(yield* mailbox.send(parentCaller, request)).toEqual(accepted)
    release()
    yield* Fiber.join(running)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(2)
    expect(JSON.stringify(hits[0].body)).not.toContain("DAG_LATE_UPDATE")
    expect(JSON.stringify(hits[1].body)).toContain("DAG_LATE_UPDATE")
    expect(yield* mailbox.revisions(childCaller)).toMatchObject({
      value: { accepted: 1, snapshot: 1, queued: 0, delivered: 1 },
    })
  }),
)

const boundedMessageIt = testEffect(
  makeHttp({
    agentLayer: Layer.mock(AgentSvc.Service, {
      get: () => Effect.succeed({ ...fencedAgent, steps: 1 }),
      defaultAgent: () => Effect.succeed("build"),
      defaultInfo: () => Effect.succeed({ ...fencedAgent, steps: 1 }),
      list: () => Effect.succeed([{ ...fencedAgent, steps: 1 }]),
    }),
  }),
)
boundedMessageIt.instance("DAG late input cannot bypass the model step budget", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const mailbox = yield* DagMessages.Service
    const { child, parentCaller, childCaller, workflowID } = yield* seedAgentConversation()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    yield* llm.hold("budget boundary", gate)
    const running = yield* prompt
      .prompt({ sessionID: child.id, model: ref, parts: [{ type: "text", text: "DAG bounded child" }] })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.hits.pipe(
        Effect.map((hits) =>
          hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
            ? true
            : undefined,
        ),
      ),
      "bounded model never started",
    )
    expect(
      yield* mailbox.send(parentCaller, {
        workflowID,
        nodeID: "worker",
        attemptID: DagMessages.nodeAttemptID(child.id, 0),
        idempotencyKey: "budget-update",
        content: "DAG_BUDGET_UPDATE",
      }),
    ).toMatchObject({ ok: true })
    release()
    yield* Fiber.join(running)
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(1)
    expect(yield* mailbox.receive(childCaller)).toMatchObject({
      value: [{ state: "undeliverable", reason: "budget_exhausted" }],
    })
  }),
)

boundedMessageIt.instance("a Stop hook cannot extend an exhausted model step budget", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const session = yield* sessions.create({ title: "Bounded stop hook" })
    stopBlockNext = 1
    yield* llm.text("final result")
    yield* prompt.prompt({ sessionID: session.id, model: ref, parts: [{ type: "text", text: "Answer once" }] })
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(1)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        stopBlockNext = 0
      }),
    ),
  ),
)

it.instance("DAG late input respects a SubagentStop hook preventing continuation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const mailbox = yield* DagMessages.Service
    const { child, parentCaller, childCaller, workflowID } = yield* seedAgentConversation()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const beforeHooks = hookRecorded.length
    stopPreventContinuation = true
    yield* llm.hold("result before stop hook", gate)
    const running = yield* prompt
      .prompt({ sessionID: child.id, model: ref, parts: [{ type: "text", text: "DAG hook controlled child" }] })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.hits.pipe(
        Effect.map((hits) =>
          hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
            ? true
            : undefined,
        ),
      ),
      "hook controlled model never started",
    )
    expect(
      yield* mailbox.send(parentCaller, {
        workflowID,
        nodeID: "worker",
        attemptID: DagMessages.nodeAttemptID(child.id, 0),
        idempotencyKey: "hook-update",
        content: "DAG_HOOK_BLOCKED_UPDATE",
      }),
    ).toMatchObject({ ok: true })
    release()
    yield* Fiber.join(running)
    expect(hookRecorded.slice(beforeHooks).filter((payload) => payload.event === "SubagentStop")).toHaveLength(1)
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(1)
    expect(yield* mailbox.receive(childCaller)).toMatchObject({
      value: [{ state: "undeliverable", reason: "hook_blocked" }],
    })
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        stopPreventContinuation = false
      }),
    ),
  ),
)

const dagStructuredFormat = Schema.decodeUnknownSync(SessionV1.OutputFormatJsonSchema)({
  type: "json_schema",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
})

for (const semanticError of ["content-filter", "missing-structured-output"] as const) {
  for (const [suffix, register] of [
    ["", it.instance],
    [" at the final model step", boundedMessageIt.instance],
  ] as const) {
    register(`DAG late input becomes undeliverable after ${semanticError}${suffix}`, () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const mailbox = yield* DagMessages.Service
        const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const response = reply().wait(gate).text("semantic failure response")
        yield* llm.push(semanticError === "content-filter" ? response.contentFilter() : response.stop())
        const running = yield* prompt
          .prompt({
            sessionID: parent.id,
            model: ref,
            format: semanticError === "missing-structured-output" ? dagStructuredFormat : undefined,
            parts: [{ type: "text", text: "DAG semantic error boundary" }],
          })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          llm.hits.pipe(
            Effect.map((hits) =>
              hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
                ? true
                : undefined,
            ),
          ),
          "semantic failure model never started",
        ).pipe(Effect.race(Fiber.join(running).pipe(Effect.andThen(Effect.die("Model completed before release")))))
        expect(
          yield* mailbox.send(childCaller, {
            workflowID,
            idempotencyKey: "semantic-late",
            content: "DAG_LATE_AFTER_SEMANTIC_FAILURE",
          }),
        ).toMatchObject({ ok: true })
        release()
        const result = yield* Fiber.join(running)
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("Expected assistant")
        expect(result.info.error?.name).toBe(
          semanticError === "content-filter" ? "ContentFilterError" : "StructuredOutputError",
        )
        expect(yield* mailbox.receive(parentCaller)).toMatchObject({
          value: [{ state: "undeliverable", reason: "model_error" }],
        })
        const revision = yield* mailbox.revisions(parentCaller)
        if (!revision.ok || !revision.value.snapshotID) throw new Error("Expected durable model snapshot")
        expect(yield* mailbox.snapshotByID(parentCaller, revision.value.snapshotID)).toMatchObject({
          value: { stopReason: "model_error" },
        })
        expect(
          (yield* llm.hits).filter(
            (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
          ),
        ).toHaveLength(1)
      }),
    )
  }
}

it.instance("DAG continuation must produce fresh structured output instead of borrowing the prior model step", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    yield* llm.push(reply().wait(gate).tool("StructuredOutput", { value: "OLD_STRUCTURED_RESULT" }))
    yield* llm.text("Plain response did not satisfy the new structured request")
    const running = yield* prompt
      .prompt({
        sessionID: parent.id,
        model: ref,
        format: dagStructuredFormat,
        parts: [{ type: "text", text: "DAG structured continuation" }],
      })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.hits.pipe(
        Effect.map((hits) =>
          hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
            ? true
            : undefined,
        ),
      ),
      "structured model never started",
    ).pipe(Effect.race(Fiber.join(running).pipe(Effect.andThen(Effect.die("Model completed before release")))))
    expect(
      yield* mailbox.send(childCaller, {
        workflowID,
        idempotencyKey: "structured-late",
        content: "DAG_STRUCTURED_LATE_INPUT",
      }),
    ).toMatchObject({ ok: true })
    release()
    const result = yield* Fiber.join(running)
    if (result.info.role !== "assistant") throw new Error("Expected assistant")
    expect(result.info.error?.name).toBe("StructuredOutputError")
    expect(result.info.structured).toBeUndefined()
    const history = yield* sessions.messages({ sessionID: parent.id })
    expect(
      history.filter((message) => message.info.role === "assistant" && message.info.structured !== undefined),
    ).toHaveLength(1)
    const requests = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].body)).toContain("DAG_STRUCTURED_LATE_INPUT")
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({
      value: [{ state: "delivered" }],
    })
  }),
)

it.instance("DAG structured output cannot turn a content-filter finish into a successful model outcome", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const mailbox = yield* DagMessages.Service
    const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    yield* llm.push(reply().wait(gate).tool("StructuredOutput", { value: "FILTERED_RESULT" }).contentFilter())
    const running = yield* prompt
      .prompt({
        sessionID: parent.id,
        model: ref,
        format: dagStructuredFormat,
        parts: [{ type: "text", text: "DAG filtered structured response" }],
      })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      llm.hits.pipe(
        Effect.map((hits) =>
          hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
            ? true
            : undefined,
        ),
      ),
      "filtered structured model never started",
    ).pipe(Effect.race(Fiber.join(running).pipe(Effect.andThen(Effect.die("Model completed before release")))))
    expect(
      yield* mailbox.send(childCaller, {
        workflowID,
        idempotencyKey: "filtered-structured-late",
        content: "DAG_LATE_AFTER_FILTERED_STRUCTURED_OUTPUT",
      }),
    ).toMatchObject({ ok: true })
    release()
    const result = yield* Fiber.join(running)
    if (result.info.role !== "assistant") throw new Error("Expected assistant")
    expect(result.info.error?.name).toBe("ContentFilterError")
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({
      value: [{ state: "undeliverable", reason: "model_error" }],
    })
    const snapshot = yield* mailbox.snapshotForTurn(parentCaller, result.info.id)
    expect(snapshot).toMatchObject({ value: { associated: true, stopReason: "model_error" } })
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(1)
  }),
)

it.instance("DAG request preparation failure finalizes the assistant and retains unassociated input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const plugins = yield* Plugin.Service
    const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    expect(
      yield* mailbox.send(childCaller, {
        workflowID,
        idempotencyKey: "preparation-input",
        content: "DAG_INPUT_BEFORE_PREPARATION_FAILURE",
      }),
    ).toMatchObject({ ok: true })
    let preparations = 0
    const hooks = yield* plugins.list()
    hooks.push({
      "experimental.chat.messages.transform": async () => {
        preparations++
        throw new Error("Injected outbound preparation failure")
      },
    })
    yield* prompt
      .prompt({
        sessionID: parent.id,
        model: ref,
        parts: [{ type: "text", text: "Prepare DAG model input" }],
      })
      .pipe(Effect.exit)
    const history = yield* sessions.messages({ sessionID: parent.id })
    const assistant = history.findLast((message) => message.info.role === "assistant")?.info
    if (!assistant || assistant.role !== "assistant") throw new Error("Expected persisted failed assistant")
    expect(assistant.error).toBeDefined()
    expect(assistant.time.completed).toBeDefined()
    expect(yield* mailbox.snapshotForTurn(parentCaller, assistant.id)).toMatchObject({
      value: { associated: false, logicalTurnID: assistant.id, stopReason: "preparation_failed" },
    })
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ state: "queued" }] })
    expect(yield* (yield* SessionStatus.Service).get(parent.id)).toMatchObject({ type: "idle" })
    expect(preparations).toBe(1)
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(0)
  }),
)

it.instance("DAG early model resolution failure durably stops preparation without consuming queued input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const { parent, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
    expect(
      yield* mailbox.send(childCaller, {
        workflowID,
        idempotencyKey: "early-preparation-input",
        content: "DAG_INPUT_BEFORE_MODEL_RESOLUTION_FAILURE",
      }),
    ).toMatchObject({ ok: true })
    const rejected = yield* prompt
      .prompt({
        sessionID: parent.id,
        model: { ...ref, modelID: ModelV2.ID.make("missing-dag-model-697") },
        parts: [{ type: "text", text: "Reject unavailable explicit selection before admission" }],
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(rejected)).toBe(true)
    expect(yield* sessions.messages({ sessionID: parent.id })).toHaveLength(0)
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ state: "queued" }] })
    // ModelSwitch now validates explicit selections before admission. Exercise
    // the durable preparation boundary with already-admitted historical input
    // whose model has become unavailable before a later runner activation.
    const admitted = yield* prompt.prompt({
      sessionID: parent.id,
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "Prepare DAG input before its model is removed" }],
    })
    if (admitted.info.role !== "user") throw new Error("Expected admitted historical user")
    yield* sessions.updateMessage({
      ...admitted.info,
      model: { ...ref, modelID: ModelV2.ID.make("missing-dag-model-697") },
    })
    const failed = yield* prompt.loop({ sessionID: parent.id }).pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ state: "queued" }] })
    expect(yield* (yield* SessionStatus.Service).get(parent.id)).toMatchObject({ type: "idle" })
    expect(
      (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation")),
    ).toHaveLength(0)
    const history = yield* sessions.messages({ sessionID: parent.id })
    const assistant = history.findLast((message) => message.info.role === "assistant")?.info
    expect(assistant?.role).toBe("assistant")
    if (!assistant || assistant.role !== "assistant") throw new Error("Expected durable early preparation failure")
    expect(assistant.error).toBeDefined()
    expect(assistant.time.completed).toBeDefined()
    expect(history.filter((message) => message.info.role === "assistant")).toHaveLength(1)
    expect(yield* mailbox.snapshotForTurn(parentCaller, assistant.id)).toMatchObject({
      value: { associated: false, logicalTurnID: assistant.id, stopReason: "preparation_failed" },
    })
  }),
)

it.instance("idle admission rolls back its transcript and reporting mark together before model activation", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const status = yield* SessionStatus.Service
    const session = yield* sessions.create({ title: "Atomic wake admission" })
    const messageID = MessageID.ascending()
    const attempt = yield* prompt
      .prepareIfIdle(
        {
          sessionID: session.id,
          messageID,
          model: ref,
          parts: [{ type: "text", text: "Atomic wake receipt", synthetic: true }],
        },
        Effect.die(new Error("Injected reporting write failure")),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(attempt)).toBe(true)
    expect((yield* sessions.messages({ sessionID: session.id })).some((message) => message.info.id === messageID)).toBe(
      false,
    )
    yield* pollWithTimeout(
      status.get(session.id).pipe(Effect.map((state) => (state.type === "idle" ? true : undefined))),
      "failed admission retained its runner",
    )
    const next = yield* prompt.prepareIfIdle({
      sessionID: session.id,
      model: ref,
      parts: [{ type: "text", text: "Replacement admission" }],
    })
    expect(Option.isSome(next)).toBe(true)
    if (Option.isSome(next)) yield* next.value.abort
    expect(yield* (yield* TestLLMServer).hits).toHaveLength(0)
  }),
)

// Explicit opt-in acceptance against existing configured providers, always in a synthetic instance.
const liveAgentIt = testEffect(
  makeHttpNoLLMServer({
    agentLayer: Layer.mock(AgentSvc.Service, {
      get: () =>
        Effect.succeed({
          ...fencedAgent,
          steps: 4,
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "agent", pattern: "*", action: "allow" },
          ],
        }),
      defaultAgent: () => Effect.succeed("build"),
      defaultInfo: () => Effect.succeed(fencedAgent),
      list: () => Effect.succeed([fencedAgent]),
    }),
  }),
)
for (const modelID of ["qwen-max", "glm", "deepseek"]) {
  const runLive = process.env.OPENCODE_DAG_LIVE_CONFIG ? liveAgentIt.instance : liveAgentIt.instance.skip
  runLive(`DAG configured ${modelID} accepts the agent tool and sends to the observed attempt`, () =>
    Effect.gen(function* () {
      const configPath = process.env.OPENCODE_DAG_LIVE_CONFIG!
      const configured = yield* Effect.promise(() => Bun.file(configPath).json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ConfigV1.Info)),
      )
      const entry = Object.entries(configured.provider ?? {}).find(([, provider]) => provider.models?.[modelID])
      if (!entry) throw new Error(`No configured provider for ${modelID}`)
      const [providerID, provider] = entry
      const { directory } = yield* TestInstance
      yield* writeConfig(directory, {
        provider: { [providerID]: provider },
        compaction: { auto: false },
        reasoningDistillation: { enabled: false },
      })
      const prompt = yield* SessionPrompt.Service
      const mailbox = yield* DagMessages.Service
      const { parent, child, childCaller, parentCaller, workflowID } = yield* seedAgentConversation()
      const content = `live-${modelID}-message`
      const result = yield* prompt.prompt({
        sessionID: parent.id,
        model: { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) },
        parts: [
          {
            type: "text",
            text: `This is an isolated DAG messaging acceptance test. Use only the agent tool. First observe workflow_id ${JSON.stringify(workflowID)}, node_id "worker". Then send the same node a message using its observed attempt_id (expected ${JSON.stringify(DagMessages.nodeAttemptID(child.id, 0))}), idempotency_key "live-${modelID}", and content ${JSON.stringify(content)}. Finish with a short confirmation. This instruction authorizes only these two agent operations.`,
          },
        ],
      })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      const received = yield* mailbox.receive(childCaller)
      if (received.ok && !received.value.length) {
        const transcript = yield* (yield* Session.Service).messages({ sessionID: parent.id })
        const evidence = {
          modelID,
          parts: transcript
            .flatMap((message) => message.parts)
            .flatMap<{
              type: string
              text?: string
              tool?: string
              status?: string
            }>((part) =>
              part.type === "text"
                ? [{ type: part.type, text: part.text.slice(0, 2000) }]
                : part.type === "tool"
                  ? [{ type: part.type, tool: part.tool, status: part.state.status }]
                  : [],
            ),
        }
        if (process.env.OPENCODE_DAG_LIVE_EVIDENCE)
          yield* Effect.promise(() =>
            Bun.write(process.env.OPENCODE_DAG_LIVE_EVIDENCE!, JSON.stringify(evidence, null, 2)),
          )
      }
      expect(received).toMatchObject({ ok: true, value: [{ content, state: "queued" }] })
      if (modelID === "glm") {
        const selectedModel = { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) }
        const question = "LIVE_NODE_QUESTION: confirm the main update"
        const answer = "LIVE_MAIN_REPLY: update confirmed"
        const prepared = yield* prompt.prepareIfIdle({
          sessionID: parent.id,
          model: selectedModel,
          parts: [
            {
              type: "text",
              text: `Await the node's agent message, then reply with the agent tool. Use {"params":{"action":"send","workflow_id":${JSON.stringify(workflowID)},"recipient":"node","node_id":"worker","attempt_id":${JSON.stringify(DagMessages.nodeAttemptID(child.id, 0))},"idempotency_key":"live-reply-glm","content":${JSON.stringify(answer)}}}. Finish briefly.`,
            },
          ],
        })
        expect(Option.isSome(prepared)).toBe(true)
        if (Option.isNone(prepared)) throw new Error("Synthetic main admission was unexpectedly busy")
        const accepted = yield* answerPreparedAgentQuestion({
          prepared: prepared.value,
          parentID: parent.id,
          parentCaller,
          question,
          questionTimeout: "60 seconds",
          childPrompt: prompt.prompt({
            sessionID: child.id,
            model: selectedModel,
            parts: [
              {
                type: "text",
                text: `Use only agent. Read the main update in your context and ask its author a question before finishing: {"params":{"action":"send","workflow_id":${JSON.stringify(workflowID)},"recipient":"parent","idempotency_key":"live-question-glm","content":${JSON.stringify(question)}}}. Then finish briefly.`,
              },
            ],
          }),
        })
        expect(accepted).toMatchObject({
          sender: { sessionID: child.id },
          recipient: { sessionID: parent.id },
          workflowID,
        })
        expect(yield* mailbox.receive(parentCaller)).toMatchObject({ value: [{ id: accepted.id, state: "delivered" }] })
        yield* prompt.loop({ sessionID: child.id })
        expect(yield* mailbox.receive(childCaller)).toMatchObject({
          value: [
            { id: received.ok ? received.value[0]?.id : undefined, content, recipientSequence: 1, state: "delivered" },
            {
              content: answer,
              recipientSequence: 2,
              state: "delivered",
              sender: { sessionID: parent.id },
              recipient: { sessionID: child.id, attemptID: DagMessages.nodeAttemptID(child.id, 0) },
            },
          ],
        })
      }
      if (modelID === "deepseek") {
        const sessions = yield* Session.Service
        const simple = yield* sessions.create({ title: "Simple task without orchestration" })
        yield* prompt.prompt({
          sessionID: simple.id,
          model: { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) },
          parts: [{ type: "text", text: "What is 2 + 2? Reply briefly without calling any tools." }],
        })
        expect(
          (yield* sessions.messages({ sessionID: simple.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool"),
        ).toHaveLength(0)
        const before = yield* mailbox.latestSnapshot(parentCaller)
        const running = yield* prompt
          .prompt({
            sessionID: parent.id,
            model: { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) },
            parts: [
              {
                type: "text",
                text: "Answer briefly without tools. If a new DAG agent update arrives, account for its context in your next answer.",
              },
            ],
          })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          mailbox
            .latestSnapshot(parentCaller)
            .pipe(
              Effect.map((snapshot) =>
                snapshot.ok && snapshot.value?.associated && (!before.ok || snapshot.value.id !== before.value?.id)
                  ? true
                  : undefined,
              ),
            ),
          "live main model input was never associated",
        )
        expect(yield* (yield* SessionStatus.Service).get(parent.id)).toMatchObject({ type: "busy" })
        expect(
          yield* mailbox.send(childCaller, {
            workflowID,
            idempotencyKey: "live-late-deepseek",
            content: "LIVE_LATE_UPDATE: the node verified its output",
          }),
        ).toMatchObject({ ok: true })
        yield* Fiber.join(running)
        expect(yield* mailbox.receive(parentCaller)).toMatchObject({
          value: [{ content: "LIVE_LATE_UPDATE: the node verified its output", state: "delivered" }],
        })
      }
    }),
  )
}

it.instance("compacts a large new user message before sending it on the same model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "test-model": {
                ...config.provider.test.models["test-model"],
                limit: { context: 1_000_000, output: 10_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Proactive compaction" })
    yield* seed(chat.id, { finish: "stop" })
    yield* user(chat.id, "large request ".repeat(10_000))
    // An ineffective summary must not immediately re-trigger the same proactive compaction.
    yield* llm.text("long summary ".repeat(10_000))
    yield* llm.text("continued answer")

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("compacts a large unique tool output before sending it on the same model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "test-model": {
                ...config.provider.test.models["test-model"],
                limit: { context: 1_000_000, output: 10_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Proactive tool-output compaction" })
    const previous = yield* seed(chat.id, { finish: "tool-calls" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: previous.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "unique-large-result",
      tool: "custom_probe",
      state: {
        status: "completed",
        input: {},
        output: "unique tool result ".repeat(7_000),
        title: "Unique large result",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    yield* llm.text("compact summary")
    yield* llm.text("continued answer")

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("checks a smaller switched model after an earlier compaction summary", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "small-model": {
                ...config.provider.test.models["test-model"],
                id: "small-model",
                name: "Small Model",
                limit: { context: 10_000, output: 1_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Model switch compaction" })
    const previous = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updateMessage({ ...previous.assistant, summary: true })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: previous.assistant.id,
      sessionID: chat.id,
      type: "text",
      text: "long summary ".repeat(3_000),
    })
    const next = yield* user(chat.id, "continue with the smaller model")
    yield* sessions.updateMessage({
      ...next,
      model: { providerID: ref.providerID, modelID: ModelV2.ID.make("small-model") },
    })
    yield* llm.text("smaller summary")
    yield* llm.text("continued answer")

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

withOversizedToolSchema.instance(
  "counts the previous request's system and tool overhead when provider usage is unavailable",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => {
        const config = providerCfg(url)
        return {
          ...config,
          compaction: { auto: true, max_context_tokens: 50_000, tail_turns: 1 },
          provider: {
            ...config.provider,
            test: {
              ...config.provider.test,
              models: {
                ...config.provider.test.models,
                "small-model": {
                  ...config.provider.test.models["test-model"],
                  id: "small-model",
                  name: "Small Model",
                  limit: { context: 200_000, output: 10_000 },
                },
              },
            },
          },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Request overhead" })
      yield* seed(chat.id, { finish: "stop" })
      yield* user(chat.id, "large request ".repeat(12_000))
      yield* llm.text("first answer")
      // The first request has no prior usage to check; it records the overhead it carries.
      yield* prompt.loop({ sessionID: chat.id })

      // A switched model discards provider usage, so the check falls back to the history estimate plus
      // the recorded overhead. Their sum exceeds max_context_tokens even though history alone does not.
      const next = yield* user(chat.id, "continue with the smaller model")
      yield* sessions.updateMessage({
        ...next,
        model: { providerID: ref.providerID, modelID: ModelV2.ID.make("small-model") },
      })
      yield* llm.text("short summary")
      yield* llm.text("continued answer")

      yield* prompt.loop({ sessionID: chat.id })

      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
    }),
)

it.instance("uses the new model projection instead of stale usage from the previous model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "small-model": {
                ...config.provider.test.models["test-model"],
                id: "small-model",
                name: "Small Model",
                limit: { context: 10_000, output: 1_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Model usage isolation" })
    const previous = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updateMessage({
      ...previous.assistant,
      tokens: { input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const next = yield* user(chat.id, "a short request")
    yield* sessions.updateMessage({
      ...next,
      model: { providerID: ref.providerID, modelID: ModelV2.ID.make("small-model") },
    })
    yield* llm.text("short answer")

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBeFalse()
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("recompacts an oversized summary before sending it to a smaller model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "test-model": {
                ...config.provider.test.models["test-model"],
                limit: { context: 10_000, output: 1_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Oversized compaction summary" })
    yield* seed(chat.id, { finish: "stop" })
    yield* user(chat.id, "large request ".repeat(3_000))
    yield* llm.text("oversized summary ".repeat(3_000))
    yield* llm.text("short summary")
    yield* llm.text("continued answer")

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(2)
    expect(yield* llm.hits).toHaveLength(3)
  }),
)

it.instance("stops after repeated automatic summaries remain above the model limit", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        compaction: { auto: true, max_context_tokens: 25_000 },
        provider: {
          ...config.provider,
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              "test-model": {
                ...config.provider.test.models["test-model"],
                limit: { context: 10_000, output: 1_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Bounded compaction" })
    yield* seed(chat.id, { finish: "stop" })
    yield* user(chat.id, "large request ".repeat(3_000))
    for (let attempt = 0; attempt < 3; attempt++) yield* llm.text("oversized summary ".repeat(3_000))

    const result = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBeTrue()
    if (Exit.isFailure(result)) {
      expect(SessionV1.ContextOverflowError.isInstance(Cause.squash(result.cause))).toBeTrue()
    }
    expect(yield* llm.hits).toHaveLength(3)
  }),
)

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance(
  "loop runs the model when the newest user message sorts below the pre-wrap assistant id (cross-era wrap)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const assistantID = MessageID.make("msg_fffac212c001")
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: MessageID.make("msg_fffac212c000"),
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 1786700000000 },
        finish: "stop",
      } satisfies SessionV1.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: chat.id,
        type: "text",
        text: "pre-wrap answer",
      })
      yield* user(chat.id, "hello after the wrap")
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(result.info.id).not.toBe(assistantID)
      expect(yield* llm.hits).toHaveLength(1)
    }),
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

it.instance("loop fires StopFailure (not Stop) when the turn ends in error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const before = hookRecorded.length
    const result = yield* prompt.loop({ sessionID: chat.id })
    const fired = hookRecorded.slice(before)

    // Error propagation unchanged: the loop still returns the errored assistant.
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("ContextOverflowError")

    const stopFailures = fired.filter((p) => p.event === "StopFailure")
    expect(stopFailures).toHaveLength(1)
    expect(stopFailures[0]).toMatchObject({ event: "StopFailure", stopHookActive: false })
    expect(stopFailures[0]).toMatchObject({
      error: "invalid_request",
      errorDetails: expect.any(String),
      lastAssistantMessage: expect.any(String),
    })
    expect(fired.filter((p) => p.event === "Stop")).toHaveLength(0)
  }),
)

it.instance("loop fires Stop (not StopFailure) on clean completion", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => providerCfg(url))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.text("hi there")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const before = hookRecorded.length
    yield* prompt.loop({ sessionID: chat.id })
    const fired = hookRecorded.slice(before)

    expect(fired.filter((p) => p.event === "Stop")).toHaveLength(1)
    expect(fired.filter((p) => p.event === "StopFailure")).toHaveLength(0)
  }),
)

type StopPayload = Extract<HookPayload, { event: "Stop" }>
const stopPayloads = (slice: HookPayload[]) => slice.filter((p): p is StopPayload => p.event === "Stop")

// hooks-api-fidelity: stop_hook_active anti-loop signal. A blocked Stop drives a
// continuation turn; the second Stop carries stop_hook_active=true. A fresh user
// prompt starts a new turn so the signal resets to false.
unix("stop_hook_active: false → block-continue → true → new input resets to false", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => providerCfg(url))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "stop-hook-active" })

    // Turn 1: two model replies queued — the first finishes and is blocked by
    // the Stop hook, the continuation turn consumes the second and is allowed.
    yield* llm.text("first reply")
    yield* llm.text("continuation reply")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "go" }],
    })
    stopBlockNext = 1
    const before = hookRecorded.length
    yield* prompt.loop({ sessionID: chat.id })
    const turn1 = stopPayloads(hookRecorded.slice(before))
    // First Stop (stop_hook_active=false) blocked → continuation → second Stop
    // (stop_hook_active=true) allowed.
    expect(turn1).toHaveLength(2)
    expect(turn1[0].stopHookActive).toBe(false)
    expect(turn1[1].stopHookActive).toBe(true)
    stopBlockNext = 0

    // Turn 2: a new user prompt resets the signal — the Stop is false again.
    yield* llm.text("third reply")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    const before2 = hookRecorded.length
    yield* prompt.loop({ sessionID: chat.id })
    const turn2 = stopPayloads(hookRecorded.slice(before2))
    expect(turn2).toHaveLength(1)
    expect(turn2[0].stopHookActive).toBe(false)
  }),
)

// hooks-stop-continuation-fidelity: Stop block reason injection, hard limit, and
// systemMessage outlet. Each test resets its recorder control in a finally-style
// finalizer so a failure can't poison sibling tests.

const syntheticTexts = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
    return msgs
      .flatMap((m) => m.parts)
      .filter((p): p is SessionV1.TextPart => p.type === "text" && p.synthetic === true)
      .map((p) => p.text)
  })

unix("Stop block continuation injects the block reason as a synthetic text part", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "stop-reason-inject" })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopBlockNext = 0
      }),
    )

    yield* llm.text("first reply")
    yield* llm.text("continuation reply")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "go" }],
    })
    stopBlockNext = 1
    yield* prompt.loop({ sessionID: chat.id })

    // The blocked Stop's reason is injected as a synthetic text part so the
    // continuation turn carries it in context (mirrors task.ts SubagentStop).
    expect(yield* syntheticTexts(chat.id)).toContain("test: stop-hook block")
  }),
)

unix("Stop hard limit: a hook that always blocks is capped at MAX_STOP_CONTINUATIONS", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "stop-hard-limit" })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopBlockAlways = false
      }),
    )

    const max = SettingsHook.MAX_STOP_CONTINUATIONS
    // One reply per turn: the initial turn plus MAX continuation turns.
    for (let i = 0; i <= max; i++) yield* llm.text(`reply ${i}`)
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "go" }],
    })
    stopBlockAlways = true
    const before = hookRecorded.length
    yield* prompt.loop({ sessionID: chat.id })
    const stops = stopPayloads(hookRecorded.slice(before))

    // 1 initial Stop (stop_hook_active=false) + MAX continuation Stops (true),
    // then the hard limit forces exit — no infinite loop.
    expect(stops).toHaveLength(max + 1)
    expect(stops[0].stopHookActive).toBe(false)
    for (let i = 1; i <= max; i++) expect(stops[i].stopHookActive).toBe(true)
  }),
)

unix("Stop hook systemMessage reaches user notification without entering model context", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "stop-sysmsg" })
    const notices: string[] = []
    const events = yield* EventV2Bridge.Service
    const off = yield* events.listen((event) => {
      if (event.type === LegacyEvent.HookMessage.type) {
        const data = decodeRecord(event.data)
        if (data.sessionID === chat.id) notices.push(decodeString(data.message))
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => (typeof off === "function" ? Effect.sync(off) : off))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopSystemMessages = []
      }),
    )

    yield* llm.text("done reply")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "go" }],
    })
    stopSystemMessages = ["SYSMSG-MARKER-123"]
    yield* prompt.loop({ sessionID: chat.id })

    expect(notices).toContain("SYSMSG-MARKER-123")
    expect(yield* syntheticTexts(chat.id)).not.toContain("SYSMSG-MARKER-123")
    expect(yield* llm.calls).toBe(1)
  }),
)

unix("Stop hook additionalContext continues through a real second model request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "stop-addctx" })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopAdditionalContexts = []
      }),
    )

    yield* llm.text("done reply")
    yield* llm.text("feedback applied")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "go" }],
    })
    stopAdditionalContexts = ["ADDCTX-MARKER-456"]
    yield* prompt.loop({ sessionID: chat.id })

    expect(yield* syntheticTexts(chat.id)).toContain("ADDCTX-MARKER-456")
    expect(yield* llm.calls).toBe(2)
    const nextInput = JSON.stringify((yield* llm.inputs)[1])
    expect(nextInput).toContain("ADDCTX-MARKER-456")
    const history = yield* sessions.messages({ sessionID: chat.id })
    expect(history.filter((message) => message.info.role === "assistant")).toHaveLength(2)
  }),
)

unix(
  "SubagentStop hard limit: a hook that always blocks is capped (no infinite loop)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { general: { model: "test/test-model" } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "subagent-stop-limit",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subagentStopBlockAlways = false
        }),
      )

      const max = SettingsHook.MAX_STOP_CONTINUATIONS
      // Main agent emits the task tool call; the subagent then runs 1 initial
      // turn + MAX continuation turns (one per blocked SubagentStop), and the
      // main agent takes a follow-up turn after the task tool returns.
      yield* llm.tool("task", {
        description: "subagent stop limit probe",
        prompt: "just say ok",
        subagent_type: "general",
      })
      for (let i = 0; i < max + 2; i++) yield* llm.text("ok")

      subagentStopBlockAlways = true
      const before = hookRecorded.length
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "run the subagent" }],
      })
      const subStops = hookRecorded
        .slice(before)
        .filter((p): p is Extract<HookPayload, { event: "SubagentStop" }> => p.event === "SubagentStop")

      // The for-loop caps continuation at MAX: SubagentStop fires exactly MAX
      // times (first with stop_hook_active=false, rest true), then the loop
      // exits — a misbehaving hook can't re-prompt the subagent forever.
      expect(subStops).toHaveLength(max)
      expect(subStops[0].stopHookActive).toBe(false)
      for (let i = 1; i < max; i++) expect(subStops[i].stopHookActive).toBe(true)
    }),
  30_000,
)

backgroundUnix(
  "task tool repairs exact string background booleans through the full AI SDK tool path (#647)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { general: { model: "test/test-model" } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* sessions.create({
        title: "task-background-e2e",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // The mock model emits background as the exact string "true" — the shape
      // qwen-family providers send even though the schema declares a boolean.
      yield* llm.tool("task", {
        description: "background reviewer",
        prompt: "review the change",
        subagent_type: "general",
        background: "true",
      })
      // Parent and child requests run concurrently; dispatch responses by the
      // actual user request instead of assuming a scheduling order.
      const childRequest = (hit: { body: Record<string, unknown> }) => {
        const lastUser = decodeRecords(hit.body.messages).findLast((message) => message.role === "user")
        return JSON.stringify(lastUser?.content).includes("review the change")
      }
      yield* llm.textMatch(childRequest, "reviewer done")
      yield* llm.textMatch((hit) => !childRequest(hit), "dispatched")
      // The background completion can join the running parent turn or start its own turn.
      yield* llm.text("background acknowledged")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "run the reviewer in the background" }],
      })

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      const childSessionId = kids[0]?.id
      if (!childSessionId) throw new Error("background task child session missing")
      const job = yield* jobs.wait({ id: childSessionId, timeout: 30_000 })
      expect(job.info?.output).toContain("reviewer done")
      expect(job.info?.status).toBe("completed")
      yield* pollWithTimeout(
        sessions.messages({ sessionID: chat.id }).pipe(
          Effect.orDie,
          Effect.map((messages) =>
            messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text.includes("Background task completed")),
            )
              ? true
              : undefined,
          ),
        ),
        "background completion report",
        "10 seconds",
      )
      const parentMessages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        parentMessages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "dispatched"),
        ),
      ).toBe(true)
      const calls = yield* llm.calls
      expect(calls + (yield* llm.pending)).toBe(4)
      expect(calls === 3 || calls === 4).toBe(true)
    }),
  30_000,
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionExecution.noopLayer),
        Effect.provide(SessionV2.defaultLayer),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("model switch hooks refuse before persistence and attach only the latest target context", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const base = providerCfg(url)
      return {
        ...base,
        provider: {
          ...base.provider,
          test: {
            ...base.provider.test,
            models: {
              ...base.provider.test.models,
              second: { ...base.provider.test.models["test-model"], id: "second", name: "Second model" },
              third: { ...base.provider.test.models["test-model"], id: "third", name: "Third model" },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({ title: "Model switch" })
    yield* prompt.prompt({ sessionID: chat.id, model: ref, noReply: true, parts: [{ type: "text", text: "seed" }] })
    const current = () =>
      db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, chat.id))
        .get()
        .pipe(Effect.orDie)
    let decision: "deny" | "ask" | "allow" = "deny"
    hookOverride = (payload) => {
      if (payload.event === "PreModelSwitch")
        return {
          additionalContexts: [],
          systemMessages: [],
          modelSwitchDecision: decision,
          modelSwitchDecisionReason: "Model policy gate",
        }
      if (payload.event === "PostModelSwitch")
        return {
          additionalContexts: [`context for target ${payload.toModel}`],
          systemMessages: ["visible warning, not model context"],
        }
      return undefined
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        hookOverride = undefined
      }),
    )
    const second = { providerID: ref.providerID, modelID: ModelV2.ID.make("second") }
    const denied = yield* prompt
      .setModel({ sessionID: chat.id, model: second, source: "picker", hookMode: "interactive" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    expect((yield* current())?.model?.id).toBe(ref.modelID)
    decision = "ask"
    const asked = yield* prompt
      .setModel({ sessionID: chat.id, model: second, source: "sdk", hookMode: "noninteractive" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(asked)).toBe(true)
    expect((yield* current())?.model?.id).toBe(ref.modelID)
    decision = "allow"
    yield* prompt.setModel({ sessionID: chat.id, model: second, source: "picker", hookMode: "interactive" })
    yield* prompt.setModel({
      sessionID: chat.id,
      model: { providerID: ref.providerID, modelID: ModelV2.ID.make("third") },
      source: "sdk",
    })
    expect((yield* current())?.model?.id).toBe("third")
    yield* llm.text("Selected target responded.")
    yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Use the selected model." }] })
    const [request] = yield* llm.inputs
    expect(request.model).toBe("third")
    expect(JSON.stringify(request.messages).includes("context for target third")).toBe(true)
    expect(JSON.stringify(request.messages).includes("context for target second")).toBe(false)
    expect(JSON.stringify(request.messages).includes("visible warning, not model context")).toBe(false)
  }),
)

it.instance("saved hook followup rejects corrupt metadata and never repeats an uncertain started input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Interrupted followup record" })
    yield* llm.text("Initial completed")
    yield* prompt.prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "INITIAL" }] })
    yield* sessions.setMetadata({ sessionID: chat.id, metadata: { hookPendingInput: { version: 999 } } })
    const corrupt = yield* prompt.resume({ sessionID: chat.id }).pipe(Effect.exit)
    expect(Exit.isFailure(corrupt)).toBe(true)
    if (Exit.isFailure(corrupt)) {
      expect(Cause.hasFails(corrupt.cause)).toBe(true)
      expect(Cause.squash(corrupt.cause)).toMatchObject({ _tag: "NoPendingHookInput" })
    }
    const pending = {
      version: 1,
      messageID: MessageID.ascending(),
      phase: "started",
      input: {
        kind: "prompt",
        parts: [{ type: "text", text: "MUST_NOT_REPEAT" }],
      },
    }
    yield* sessions.setMetadata({ sessionID: chat.id, metadata: { hookPendingInput: pending } })
    const uncertain = yield* prompt.resume({ sessionID: chat.id }).pipe(Effect.exit)
    expect(Exit.isFailure(uncertain)).toBe(true)
    if (Exit.isFailure(uncertain)) expect(String(Cause.squash(uncertain.cause))).toContain("already started")
    expect(yield* llm.calls).toBe(1)
    expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput).toEqual(pending)
    expect(JSON.stringify(yield* sessions.messages({ sessionID: chat.id }))).not.toContain("MUST_NOT_REPEAT")
  }),
)

it.instance("model switch ask uses the interactive command question before committing", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const base = providerCfg(url)
      return {
        ...base,
        provider: {
          ...base.provider,
          test: {
            ...base.provider.test,
            models: {
              ...base.provider.test.models,
              second: { ...base.provider.test.models["test-model"], id: "second" },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const chat = yield* sessions.create({ title: "Question gate" })
    yield* prompt.prompt({ sessionID: chat.id, model: ref, noReply: true, parts: [{ type: "text", text: "seed" }] })
    hookOverride = (payload) =>
      payload.event === "PreModelSwitch"
        ? {
            additionalContexts: [],
            systemMessages: [],
            modelSwitchDecision: "ask",
            modelSwitchDecisionReason: "Confirm this model",
          }
        : undefined
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        hookOverride = undefined
      }),
    )
    const switching = yield* prompt
      .setModel({
        sessionID: chat.id,
        model: { providerID: ref.providerID, modelID: ModelV2.ID.make("second") },
        source: "command",
        hookMode: "interactive",
      })
      .pipe(Effect.forkChild)
    const asked = yield* pollWithTimeout(
      questions.list().pipe(Effect.map((items) => (items.length === 1 ? items : undefined))),
      "model switch question missing",
    )
    expect(asked[0].questions[0].question).toBe("Confirm this model")
    yield* questions.reply({ requestID: asked[0].id, answers: [["Switch"]] })
    expect((yield* Fiber.join(switching)).modelID).toBe(ModelV2.ID.make("second"))
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

for (const [runtime, runner] of [
  ["ai-sdk", it],
  ["native", nativeIt],
] as const) {
  runner.instance(`deferred tool survives repeated resume and executes only after allow (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Deferred",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const filePath = path.join(dir, "deferred.txt")
      let decision: "defer" | "allow" = "defer"
      const observed: Array<{ id?: string; input: Record<string, unknown> }> = []
      hookOverride = (payload) => {
        if (payload.event !== "PreToolUse" || payload.toolName !== "write") return undefined
        observed.push({ id: payload.toolUseID, input: payload.toolInput })
        return {
          additionalContexts: [],
          systemMessages: [],
          permissionDecision: decision,
          updatedInput: { filePath, content: "approved replacement" },
        }
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          hookOverride = undefined
        }),
      )
      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        hookMode: "noninteractive",
        parts: [{ type: "text", text: "Write the file." }],
      })
      yield* llm.tool("write", { filePath, content: "original input" })
      yield* llm.text("The deferred write completed.")
      const first = yield* prompt.loop({ sessionID: chat.id })
      expect(first.info.role === "assistant" && first.info.finish).toBe("tool_deferred")
      const pending = toolPart(first.parts)
      expect(pending?.state.status).toBe("pending")
      expect(pending?.state.input).toEqual({ filePath, content: "original input" })
      expect(yield* fs.exists(filePath)).toBe(false)
      expect(yield* llm.calls).toBe(1)
      const second = yield* prompt.loop({ sessionID: chat.id })
      expect(second.info.id).toBe(first.info.id)
      expect(second.info.role === "assistant" && second.info.finish).toBe("tool_deferred")
      expect(yield* llm.calls).toBe(1)
      expect(yield* fs.exists(filePath)).toBe(false)
      decision = "allow"
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
      expect(yield* fs.readFileString(filePath)).toBe("approved replacement")
      expect(yield* llm.calls).toBe(2)
      expect(observed).toHaveLength(3)
      expect(new Set(observed.map((x) => x.id)).size).toBe(1)
      expect(observed.every((x) => x.input.content === "original input")).toBe(true)
      const history = yield* sessions.messages({ sessionID: chat.id })
      expect(history.filter((x) => x.info.role === "user")).toHaveLength(1)
      expect(toolPart(history.find((x) => x.info.id === first.info.id)!.parts)?.state.status).toBe("completed")
      expect(JSON.stringify((yield* llm.inputs)[1].messages)).toContain("approved replacement")
    }),
  )

  runner.instance(`SDK prompt automatically finishes the initial hook turn before supplied input (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const lifecycle = yield* HookLifecycle.Service
      const chat = yield* sessions.create({ title: "SDK initial hook input" })
      yield* lifecycle.queueInitial(chat.id, "HOOK_INITIAL_ONLY")
      yield* llm.text("Initial answer")
      yield* llm.text("Supplied answer")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        parts: [{ type: "text", text: "SDK_SUPPLIED_INPUT" }],
        hookMode: "noninteractive",
      })
      expect(result.parts.some((part) => part.type === "text" && part.text === "Supplied answer")).toBe(true)
      const requests = yield* llm.inputs
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0].messages)).toContain("HOOK_INITIAL_ONLY")
      expect(JSON.stringify(requests[0].messages)).not.toContain("SDK_SUPPLIED_INPUT")
      expect(JSON.stringify(requests[1].messages)).toContain("SDK_SUPPLIED_INPUT")
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
      ).toHaveLength(2)
      expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput).toBeUndefined()
    }),
  )

  runner.instance(`explicit cancel discards a saved initial-hook followup and accepts a new prompt (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const lifecycle = yield* HookLifecycle.Service
      const chat = yield* sessions.create({ title: "Cancel initial followup" })
      yield* lifecycle.queueInitial(chat.id, "CANCEL_INITIAL")
      yield* llm.hang
      const running = yield* prompt
        .prompt({
          sessionID: chat.id,
          model: ref,
          hookMode: "noninteractive",
          parts: [{ type: "text", text: "CANCEL_QUEUED_FOLLOWUP" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput).toBeDefined()
      yield* prompt.cancel(chat.id)
      yield* Fiber.join(running)
      expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput).toBeUndefined()
      yield* llm.text("NEW_PROMPT_DONE")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        model: ref,
        hookMode: "noninteractive",
        parts: [{ type: "text", text: "NEW_PROMPT" }],
      })
      expect(result.parts.some((part) => part.type === "text" && part.text === "NEW_PROMPT_DONE")).toBe(true)
      const calls = yield* llm.inputs
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls)).not.toContain("CANCEL_QUEUED_FOLLOWUP")
      expect(JSON.stringify(calls[1])).toContain("NEW_PROMPT")
    }),
  )

  runner.instance(`initial hook turn keeps a supplied followup until deferred work finishes (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const lifecycle = yield* HookLifecycle.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Initial followup",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const filePath = path.join(dir, "initial-followup.txt")
      let deferred = true
      hookOverride = (payload) =>
        payload.event === "PreToolUse" && payload.toolName === "write"
          ? { additionalContexts: [], systemMessages: [], permissionDecision: deferred ? "defer" : "allow" }
          : undefined
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          hookOverride = undefined
        }),
      )
      yield* lifecycle.queueInitial(chat.id, "INITIAL_MESSAGE")
      yield* llm.tool("write", { filePath, content: "initial completed" })
      yield* llm.text("INITIAL_FINISHED")
      yield* llm.text("FOLLOWUP_FINISHED")
      const first = yield* prompt.resume({
        sessionID: chat.id,
        hookMode: "noninteractive",
        initialOnly: true,
        followup: { kind: "prompt", parts: [{ type: "text", text: "SUPPLIED_FOLLOWUP" }] },
      })
      expect(first?.info.role === "assistant" && first.info.finish).toBe("tool_deferred")
      let history = yield* sessions.messages({ sessionID: chat.id })
      expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
      expect(JSON.stringify(history)).not.toContain("SUPPLIED_FOLLOWUP")
      expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput?.phase).toBe("pending")
      expect(yield* fs.exists(filePath)).toBe(false)
      deferred = false
      const resumed = yield* prompt.resume({ sessionID: chat.id, hookMode: "noninteractive" })
      expect(resumed?.parts.some((part) => part.type === "text" && part.text === "FOLLOWUP_FINISHED")).toBe(true)
      expect(yield* fs.readFileString(filePath)).toBe("initial completed")
      expect(yield* llm.calls).toBe(3)
      history = yield* sessions.messages({ sessionID: chat.id })
      expect(history.filter((message) => message.info.role === "user")).toHaveLength(2)
      const requests = yield* llm.inputs
      expect(JSON.stringify(requests[1].messages)).not.toContain("SUPPLIED_FOLLOWUP")
      expect(JSON.stringify(requests[2].messages)).toContain("SUPPLIED_FOLLOWUP")
      expect((yield* sessions.get(chat.id)).metadata?.hookPendingInput).toBeUndefined()
    }),
  )

  runner.instance(`step limit disables execution tools and stops a provider tool call (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { build: { steps: 2 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const firstFile = path.join(dir, "before-limit.txt")
      const blockedFile = path.join(dir, "after-limit.txt")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Write a file, then summarize." }],
      })
      yield* llm.tool("write", { filePath: firstFile, content: "allowed" })
      // The provider deliberately ignores toolChoice=none on the last step.
      yield* llm.tool("write", { filePath: blockedFile, content: "must not execute" })
      yield* llm.text("must not request another step")

      yield* prompt.loop({ sessionID: chat.id })

      expect(yield* fs.readFileString(firstFile)).toBe("allowed")
      expect(yield* fs.exists(blockedFile)).toBe(false)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[0].tools)).toContain('"write"')
      expect(inputs[1].tools ?? []).toEqual([])
      expect(inputs[1].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[1].messages)).toContain("Tools are disabled until next user input")
      expect(yield* llm.pending).toBe(1)
    }),
  )

  runner.instance(`step limit returns a text summary without a false structured-output instruction (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { build: { steps: 1 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          retryCount: 0,
        }),
        parts: [{ type: "text", text: "Return a structured answer." }],
      })
      yield* llm.text("The step limit was reached before the structured answer was ready.")

      const result = yield* prompt.loop({ sessionID: chat.id })

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(1)
      expect(inputs[0].tools ?? []).toEqual([])
      expect(inputs[0].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[0].messages)).not.toContain("MUST use the StructuredOutput tool")
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("Expected an assistant response")
      expect(result.info.error?.name).toBe("StructuredOutputError")
      if (result.info.error?.name !== "StructuredOutputError") throw new Error("Expected the step limit error")
      expect(result.info.error.data.message).toContain("Maximum agent steps reached")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("step limit"))).toBe(true)
    }),
  )

  runner.instance(`step limit preserves structured output completed before the final step (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { build: { steps: 2 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          retryCount: 0,
        }),
        parts: [{ type: "text", text: "Return 4 as the answer." }],
      })
      yield* llm.tool("StructuredOutput", { answer: 4 })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("Expected an assistant response")
      expect(result.info.error).toBeUndefined()
      expect(result.info.structured).toEqual({ answer: 4 })
      expect((yield* llm.inputs)[0].tool_choice).toBe("required")
    }),
  )

  for (const setting of ["default", "zero"] as const) {
    runner.instance(`tool call budget is unlimited with ${setting} configuration (${runtime})`, () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          ...(setting === "zero" ? { maxToolCalls: 0 } : {}),
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const chat = yield* sessions.create({
          title: "Unlimited budget",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const glob = (yield* registry.all()).find((item) => item.id === "glob")
        if (!glob) throw new Error("glob tool is not registered")
        const original = glob.execute.bind(glob)
        let executed = 0
        glob.execute = (args, ctx) => original(args, ctx).pipe(Effect.tap(() => Effect.sync(() => executed++)))
        yield* Effect.addFinalizer(() => Effect.sync(() => void (glob.execute = original)))

        yield* prompt.prompt({
          sessionID: chat.id,
          noReply: true,
          parts: [{ type: "text", text: "Run the requested file searches." }],
        })
        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-unlimited-parallel",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: Array.from({ length: 51 }, (_, index) => ({
                        index,
                        id: `call-unlimited-${index}`,
                        type: "function",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ pattern: `unlimited-${index}.txt` }),
                        },
                      })),
                    },
                    finish_reason: null,
                  },
                ],
              },
            ],
            tail: [
              {
                id: "chatcmpl-unlimited-parallel",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ],
          }),
          reply().tool("glob", { pattern: "unlimited-next-request.txt" }),
          reply().text("Searches completed.").stop(),
        )
        yield* prompt.loop({ sessionID: chat.id })

        expect(executed).toBe(52)
        const tools = (yield* sessions.messages({ sessionID: chat.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(tools).toHaveLength(52)
        expect(tools.every((part) => part.state.status === "completed")).toBe(true)
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(3)
        for (const input of inputs) {
          expect(JSON.stringify(input.tools)).toContain('"glob"')
          expect(input.tool_choice).not.toBe("none")
          expect(JSON.stringify(input.messages)).not.toContain("Maximum tool calls")
        }
      }),
    )
  }

  runner.instance(`tool call budget counts parallel calls, spans requests and resets on new input (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 2 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const files = ["first", "second", "excess", "forged", "fresh-first", "fresh-second"].map((name) =>
        path.join(dir, `${name}.txt`),
      )
      yield* prompt.prompt({ sessionID: chat.id, noReply: true, parts: [{ type: "text", text: "Write three files." }] })
      yield* llm.push(
        raw({
          chunks: [
            {
              id: "chatcmpl-budget-parallel",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: files.slice(0, 3).map((filePath, index) => ({
                      index,
                      id: `call-budget-${index}`,
                      type: "function",
                      function: { name: "write", arguments: JSON.stringify({ filePath, content: "allowed" }) },
                    })),
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ],
        }),
        reply().tool("write", { filePath: files[3], content: "must not execute" }),
      )
      yield* prompt.loop({ sessionID: chat.id })

      expect(yield* fs.readFileString(files[0])).toBe("allowed")
      expect(yield* fs.readFileString(files[1])).toBe("allowed")
      expect(yield* fs.exists(files[2])).toBe(false)
      expect(yield* fs.exists(files[3])).toBe(false)
      const history = yield* sessions.messages({ sessionID: chat.id })
      const rejected = history
        .flatMap((message) => message.parts)
        .find(
          (part): part is ErrorToolPart =>
            part.type === "tool" && part.callID === "call-budget-2" && part.state.status === "error",
        )
      expect(rejected?.state.error).toContain("Maximum tool calls (2) reached")
      const firstInputs = yield* llm.inputs
      expect(firstInputs).toHaveLength(2)
      expect(firstInputs[1].tools ?? []).toEqual([])
      expect(firstInputs[1].tool_choice ?? "none").toBe("none")

      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        parts: [{ type: "text", text: "Write two more files." }],
      })
      yield* llm.push(
        reply().tool("write", { filePath: files[4], content: "fresh" }),
        reply().tool("write", { filePath: files[5], content: "fresh" }),
        reply().text("Two more files are complete.").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* fs.readFileString(files[4])).toBe("fresh")
      expect(yield* fs.readFileString(files[5])).toBe("fresh")
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(5)
      expect(JSON.stringify(inputs[2].tools)).toContain('"write"')
      expect(JSON.stringify(inputs[3].tools)).toContain('"write"')
      expect(inputs[4].tools ?? []).toEqual([])
    }),
  )

  runner.instance(`deleting a queued input does not reset the active tool budget (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Queued budget delete",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = path.join(dir, "queued-budget-first.txt")
      const malicious = path.join(dir, "queued-budget-malicious.txt")
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const write = (yield* registry.all()).find((item) => item.id === "write")
      if (!write) throw new Error("write tool is not registered")
      const original = write.execute.bind(write)
      let paused = false
      write.execute = (args, ctx) => {
        if (!paused && record(args) && args.filePath === first) {
          paused = true
          return Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return yield* original(args, ctx)
          })
        }
        return original(args, ctx)
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => void (write.execute = original)))
      yield* llm.push(
        reply().tool("write", { filePath: first, content: "first write" }),
        reply().tool("write", { filePath: malicious, content: "must be blocked" }),
        reply().text("done").stop(),
      )
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Input A" }],
      })
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(started), "first write did not start")

      const id = MessageID.ascending()
      yield* prompt.prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Input B to delete" }],
      })
      const queued = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === id)
      const text = queued?.parts.find((part): part is SessionV1.TextPart => part.type === "text")
      if (!queued || !text) throw new Error("expected queued B message")
      expect(
        yield* prompt.deleteQueuedMessage({
          sessionID: chat.id,
          messageID: id,
          partID: text.id,
          expectedText: text.text,
          expectedPartIDs: queued.parts.map((part) => part.id),
        }),
      ).toBeTrue()

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(run)
      expect(yield* fs.readFileString(first)).toBe("first write")
      expect(yield* fs.exists(malicious)).toBe(false)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(inputs[1].tools ?? []).toEqual([])
      expect(inputs[1].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[1].messages)).not.toContain("Input B to delete")
    }),
  )

  runner.instance(`queued input receives its own tool budget only when claimed (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Queued budget retained",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = path.join(dir, "queued-budget-a.txt")
      const second = path.join(dir, "queued-budget-b.txt")
      const excess = path.join(dir, "queued-budget-b-excess.txt")
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const write = (yield* registry.all()).find((item) => item.id === "write")
      if (!write) throw new Error("write tool is not registered")
      const original = write.execute.bind(write)
      let paused = false
      write.execute = (args, ctx) => {
        if (!paused && record(args) && args.filePath === first) {
          paused = true
          return Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return yield* original(args, ctx)
          })
        }
        return original(args, ctx)
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => void (write.execute = original)))
      yield* llm.push(
        reply().tool("write", { filePath: first, content: "A" }),
        reply().tool("write", { filePath: second, content: "B" }),
        reply().tool("write", { filePath: excess, content: "must be blocked" }),
        reply().text("B is complete.").stop(),
      )
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Input A" }],
      })
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(started), "first write did not start")
      const id = MessageID.ascending()
      yield* prompt.prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Input B retained" }],
      })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(run)

      expect(yield* fs.readFileString(first)).toBe("A")
      expect(yield* fs.readFileString(second)).toBe("B")
      expect(yield* fs.exists(excess)).toBe(false)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(inputs[0].tools ?? []).not.toEqual([])
      expect(JSON.stringify(inputs[0].messages)).not.toContain("Input B retained")
      expect(JSON.stringify(inputs[1].messages)).toContain("Input B retained")
      expect(inputs[1].tools ?? []).not.toEqual([])
      expect(inputs[2].tools ?? []).toEqual([])
      expect(inputs[2].tool_choice ?? "none").toBe("none")
    }),
  )

  runner.instance(`tool call budget survives internal admission and manual loop restart (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = path.join(dir, "budget-before-followup.txt")
      const blocked = path.join(dir, "budget-after-followup.txt")
      yield* prompt.prompt({ sessionID: chat.id, noReply: true, parts: [{ type: "text", text: "Write once." }] })
      yield* llm.push(reply().tool("write", { filePath: first, content: "allowed" }), reply().text("Complete.").stop())
      yield* prompt.loop({ sessionID: chat.id })

      yield* prompt.prompt(
        {
          sessionID: chat.id,
          noReply: true,
          parts: [{ type: "text", text: "Internal result follow-up.", synthetic: true }],
        },
        { continueToolBudget: true },
      )
      yield* llm.tool("write", { filePath: blocked, content: "must not execute" })
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* fs.readFileString(first)).toBe("allowed")
      expect(yield* fs.exists(blocked)).toBe(false)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(inputs[2].tools ?? []).toEqual([])
      expect(inputs[2].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[2].messages)).toContain("Maximum tool calls (1)")
    }),
  )

  runner.instance(`tool call budget includes structured output and reports exhaustion clearly (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          retryCount: 0,
        }),
        parts: [{ type: "text", text: "List text files, then return structured output." }],
      })
      yield* llm.push(reply().tool("glob", { pattern: "*.txt" }), reply().text("The tool budget is exhausted.").stop())
      const result = yield* prompt.loop({ sessionID: chat.id })
      if (result.info.role !== "assistant") throw new Error("Expected an assistant response")
      expect(result.info.error?.name).toBe("StructuredOutputError")
      if (result.info.error?.name !== "StructuredOutputError")
        throw new Error("Expected a structured output limit error")
      expect(result.info.error.data.message).toContain("Maximum tool calls reached")
      const inputs = yield* llm.inputs
      expect(inputs[1].tools ?? []).toEqual([])
      expect(JSON.stringify(inputs[1].messages)).not.toContain("MUST use the StructuredOutput tool")

      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          retryCount: 0,
        }),
        parts: [{ type: "text", text: "Return 4 immediately." }],
      })
      yield* llm.tool("StructuredOutput", { answer: 4 })
      const completed = yield* prompt.loop({ sessionID: chat.id })
      if (completed.info.role !== "assistant") throw new Error("Expected an assistant response")
      expect(completed.info.error).toBeUndefined()
      expect(completed.info.structured).toEqual({ answer: 4 })
    }),
  )

  runner.instance(`tool call budget is retained through automatic compaction (${runtime})`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        maxToolCalls: 1,
        compaction: { auto: true, max_context_tokens: 25_000 },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = path.join(dir, "budget-before-compaction.txt")
      const blocked = path.join(dir, "budget-after-compaction.txt")
      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        parts: [{ type: "text", text: "Write once, then continue." }],
      })
      yield* llm.push(
        reply().tool("write", { filePath: first, content: "allowed" }).usage({ input: 30_000, output: 10 }),
        reply().text("One file was written. Summarize the remaining work.").stop(),
        reply().tool("write", { filePath: blocked, content: "must not execute" }),
      )
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* fs.readFileString(first)).toBe("allowed")
      expect(yield* fs.exists(blocked)).toBe(false)
      const history = yield* sessions.messages({ sessionID: chat.id })
      expect(history.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(inputs[2].tools ?? []).toEqual([])
      expect(inputs[2].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[2].messages)).toContain("Maximum tool calls (1)")
    }),
  )

  runner.instance(`tool call budget also bounds completed calls with invalid arguments (${runtime})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 2 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({ sessionID: chat.id, noReply: true, parts: [{ type: "text", text: "Write a file." }] })
      yield* llm.push(
        reply().tool("write", {}),
        reply().tool("write", {}),
        reply().text("Arguments were invalid; no file was written.").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(inputs[2].tools ?? []).toEqual([])
      expect(inputs[2].tool_choice ?? "none").toBe("none")
      expect(JSON.stringify(inputs[2].messages)).toContain("Maximum tool calls (2)")
    }),
  )
}

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

const contextFoldingClosedLoop = (runtime: "ai-sdk" | "native") =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(foldingProviderCfg)
    const readFile = path.join(dir, "fold-read.txt")
    const uniqueFile = path.join(dir, "fold-unique.txt")
    const grepFile = path.join(dir, "fold-grep.txt")
    const globDir = path.join(dir, "fold-glob")
    const probeLedger = path.join(dir, "s08-probe-ledger.ndjson")
    const probeTool = path.join(dir, ".opencode", "tools", "s08_probe.ts")
    const uniqueMarker = `unique-tool-output-${runtime}-`
    yield* writeText(readFile, foldingReadBody("read-body-abcdefghij-"))
    yield* writeText(uniqueFile, `${uniqueMarker}${"u".repeat(4_000)}\n`)
    yield* writeText(
      grepFile,
      Array.from({ length: 40 }, (_, index) => `needle-${index}-${"g".repeat(320)}`).join("\n"),
    )
    yield* writeText(
      probeTool,
      [
        "export default {",
        "  description: 'S08 deterministic side-effect and lifecycle probe',",
        "  args: { mode: { type: 'string' } },",
        "  execute: async ({ mode }, ctx) => {",
        "    const { appendFile } = await import('node:fs/promises')",
        `    const ledger = ${JSON.stringify(probeLedger)}`,
        "    await appendFile(ledger, JSON.stringify({ mode, event: 'start' }) + '\\n')",
        "    if (mode === 'fail') throw new Error('s08 expected probe failure')",
        "    if (mode === 'slow') {",
        "      await new Promise((_resolve, reject) => {",
        "        const abort = async () => {",
        "          await appendFile(ledger, JSON.stringify({ mode, event: 'abort' }) + '\\n')",
        "          reject(new Error('s08 probe cancelled'))",
        "        }",
        "        if (ctx.abort.aborted) void abort()",
        "        else ctx.abort.addEventListener('abort', () => void abort(), { once: true })",
        "      })",
        "    }",
        "    await appendFile(ledger, JSON.stringify({ mode, event: 'complete' }) + '\\n')",
        "    return `s08-probe-${mode}-complete`",
        "  },",
        "}",
        "",
      ].join("\n"),
    )
    yield* ensureDir(globDir)
    yield* Effect.forEach(
      Array.from({ length: 80 }, (_, index) =>
        path.join(globDir, `context-folding-${String(index).padStart(3, "0")}-${"n".repeat(80)}.txt`),
      ),
      (file) => writeText(file, "glob"),
      { concurrency: 16 },
    )

    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* sessions.create({
      title: `Context folding ${runtime}`,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    const parallelProbe = raw({
      chunks: [
        {
          id: `chatcmpl-s08-${runtime}`,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: ["success", "fail"].map((mode, index) => ({
                  index,
                  id: `call-probe-${mode}`,
                  type: "function",
                  function: { name: "s08_probe", arguments: JSON.stringify({ mode }) },
                })),
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "collect duplicate context" }],
    })
    yield* llm.push(
      parallelProbe,
      reply().tool("read", { filePath: uniqueFile }, "call-read-unique"),
      reply().tool("read", { filePath: readFile }, "call-read-source"),
      reply().tool("read", { filePath: readFile }, "call-read-witness"),
      reply().tool("grep", { pattern: "needle", path: grepFile }, "call-grep-source"),
      reply().tool("grep", { pattern: "needle", path: grepFile }, "call-grep-witness"),
      reply().tool("glob", { pattern: "**/*.txt", path: globDir }, "call-glob-source"),
      reply().tool("glob", { pattern: "**/*.txt", path: globDir }, "call-glob-witness"),
      reply().text("initial tool collection complete").stop(),
    )
    yield* prompt.loop({ sessionID: session.id })

    const beforeMessages = yield* MessageV2.filterCompactedEffect(session.id)
    const probeParts = beforeMessages
      .flatMap((message) => message.parts)
      .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "s08_probe")
    expect(probeParts.map((part) => ({ callID: part.callID, status: part.state.status }))).toEqual([
      { callID: "call-probe-success", status: "completed" },
      { callID: "call-probe-fail", status: "error" },
    ])
    const beforeTools = beforeMessages
      .flatMap((message) => message.parts)
      .filter(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.state.status === "completed" && ["read", "grep", "glob"].includes(part.tool),
      )
    expect(beforeTools.map((part) => part.tool)).toEqual(["read", "read", "read", "grep", "grep", "glob", "glob"])
    expect(beforeTools.every((part) => part.state.metadata.contextFoldingInstructions === "none")).toBe(true)
    const beforeByCallID = new Map(beforeTools.map((part) => [part.callID, part]))
    for (const callID of ["call-read-source", "call-read-witness"]) {
      const part = beforeByCallID.get(callID)
      expect(part).toBeDefined()
      if (!part) throw new Error(`missing stored read result ${callID}`)
      expect(part.state.output.length).toBeGreaterThan(20_000)
      expect(part.state.output).not.toContain("(line truncated to 2000 chars)")
      expect(part.state.metadata.truncated).toBe(false)
    }
    const persisted = beforeTools.map((part) => ({
      id: part.id,
      messageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      input: structuredClone(part.state.input),
      output: part.state.output,
      metadata: structuredClone(part.state.metadata),
    }))

    for (let index = 0; index < 4; index++) {
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: `recent protection ${index}` }],
      })
      yield* llm.text(`recent-${index}-${"context ".repeat(3_000)}`)
      yield* prompt.loop({ sessionID: session.id })
    }

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "send the next provider request" }],
    })
    yield* llm.text("folded request accepted")
    yield* prompt.loop({ sessionID: session.id })

    const hits = yield* llm.hits
    const outboundBody = hits.at(-1)?.body ?? {}
    const outbound = JSON.stringify(outboundBody)
    expect(outbound).toContain("Duplicate tool output folded")
    for (const [tool, marker] of [
      ["read", "read-body-abcdefghij"],
      ["grep", "needle-39-"],
      ["glob", "context-folding-079-"],
    ] as const) {
      const sourceCallID = `call-${tool}-source`
      const witnessCallID = `call-${tool}-witness`
      const source = beforeByCallID.get(sourceCallID)
      const witness = beforeByCallID.get(witnessCallID)
      expect(source).toBeDefined()
      expect(witness).toBeDefined()
      if (!source) throw new Error(`missing stored ${tool} source`)
      if (!witness) throw new Error(`missing stored ${tool} witness`)
      expect(witness.state.output).toContain(marker)
      expectFoldedBuiltinPair({
        tool,
        body: outboundBody,
        sourceCallID,
        sourceOutput: source.state.output,
        witnessCallID,
        witnessOutput: witness.state.output,
      })
    }
    expect((outbound.match(/Duplicate tool output folded/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(outbound).toContain(uniqueMarker)
    expect(outbound).toContain("read-body-abcdefghij")
    expect(outbound).toContain("needle-39-")
    expect(outbound).toContain("context-folding-079-")
    for (const witness of ["call-read-witness", "call-grep-witness", "call-glob-witness"])
      expect(outbound).toContain(witness)
    expect(outbound.indexOf("call-read-source")).toBeLessThan(outbound.indexOf("call-read-witness"))

    const afterMessages = yield* MessageV2.filterCompactedEffect(session.id)
    const afterByID = new Map(
      afterMessages
        .flatMap((message) => message.parts)
        .filter((part): part is CompletedToolPart => part.type === "tool" && part.state.status === "completed")
        .map((part) => [part.id, part]),
    )
    expect(
      persisted.map((item) => {
        const part = afterByID.get(item.id)
        return part
          ? {
              id: part.id,
              messageID: part.messageID,
              callID: part.callID,
              tool: part.tool,
              input: part.state.input,
              output: part.state.output,
              metadata: part.state.metadata,
            }
          : undefined
      }),
    ).toEqual(persisted)
    const probeEvents = (yield* Effect.promise(() => Bun.file(probeLedger).text()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { mode: string; event: string })
    expect(probeEvents.filter((event) => event.mode === "success")).toEqual(
      expect.arrayContaining([
        { mode: "success", event: "start" },
        { mode: "success", event: "complete" },
      ]),
    )
    expect(probeEvents.filter((event) => event.mode === "fail")).toEqual([{ mode: "fail", event: "start" }])
    expect(probeEvents.filter((event) => event.mode === "success" && event.event === "start")).toHaveLength(1)
    expect(probeEvents.filter((event) => event.mode === "fail" && event.event === "start")).toHaveLength(1)

    const preCompactionHits = hits.length
    yield* compaction.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
    yield* llm.text(`s08-manual-summary-${runtime}`)
    const compacted = yield* prompt.loop({ sessionID: session.id })
    expect(compacted.info.role).toBe("assistant")
    const compactionHits = (yield* llm.hits).slice(preCompactionHits)
    expect(compactionHits).toHaveLength(1)
    expectBoundedOriginalOpenCodeSummary(compactionHits[0]?.body ?? {}, {
      read: "read-body-abcdefghij",
      grep: "needle-0-",
      glob: "context-folding-",
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue after the manual full compaction" }],
    })
    yield* llm.text(`s08-post-compaction-${runtime}`)
    yield* prompt.loop({ sessionID: session.id })
    const afterCompaction = JSON.stringify((yield* llm.hits).at(-1)?.body ?? {})
    expect(afterCompaction).toContain(`s08-manual-summary-${runtime}`)
    expect(afterCompaction).not.toContain("Duplicate tool output folded")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the cancellable lifecycle probe" }],
    })
    yield* llm.tool("s08_probe", { mode: "slow" })
    const slowRun = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        if (!(yield* Effect.promise(() => Bun.file(probeLedger).exists()))) return
        const text = yield* Effect.promise(() => Bun.file(probeLedger).text())
        return text.includes('{"mode":"slow","event":"start"}') ? true : undefined
      }),
      "S08 slow probe did not start",
      "10 seconds",
    )
    yield* prompt.cancel(session.id)
    expect(Exit.isSuccess(yield* Fiber.await(slowRun))).toBe(true)
    const cancelled = (yield* MessageV2.filterCompactedEffect(session.id))
      .flatMap((message) => message.parts)
      .findLast((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "s08_probe")
    expect(cancelled?.state.status).toBe("error")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "resume after cancellation" }],
    })
    yield* llm.text(`s08-cancel-recovered-${runtime}`)
    const recovered = yield* prompt.loop({ sessionID: session.id })
    expect(recovered.info.role).toBe("assistant")
    expect(recovered.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: `s08-cancel-recovered-${runtime}` })]),
    )
    const finalProbeEvents = (yield* Effect.promise(() => Bun.file(probeLedger).text()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { mode: string; event: string })
    expect(finalProbeEvents.filter((event) => event.mode === "success" && event.event === "start")).toHaveLength(1)
    expect(finalProbeEvents.filter((event) => event.mode === "fail" && event.event === "start")).toHaveLength(1)
    expect(finalProbeEvents.filter((event) => event.mode === "slow" && event.event === "start")).toHaveLength(1)
    expect(finalProbeEvents.filter((event) => event.mode === "slow" && event.event === "abort")).toHaveLength(1)
    const finalTools = new Map(
      (yield* sessions.messages({ sessionID: session.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is CompletedToolPart => part.type === "tool" && part.state.status === "completed")
        .map((part) => [part.id, part]),
    )
    expect(
      persisted.map((item) => {
        const part = finalTools.get(item.id)
        return part
          ? {
              id: part.id,
              messageID: part.messageID,
              callID: part.callID,
              tool: part.tool,
              input: part.state.input,
              output: part.state.output,
              metadata: part.state.metadata,
            }
          : undefined
      }),
    ).toEqual(persisted)
    expect("prune" in compaction).toBe(false)
    expect(
      (yield* sessions.messages({ sessionID: session.id })).some((message) =>
        message.parts.some(
          (part) =>
            part.type === "tool" && part.state.status === "completed" && part.state.time.compacted !== undefined,
        ),
      ),
    ).toBe(false)
    expect(yield* llm.pending).toBe(0)
  })

const contextFoldingOverrideFailsClosed = (sourceKind: "custom" | "mcp") =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(foldingProviderCfg)
    if (sourceKind === "custom") {
      yield* writeText(
        path.join(dir, ".opencode", "tools", "read.ts"),
        [
          "export default {",
          "  description: 'custom read override',",
          "  args: {},",
          "  execute: async () => 'custom-context-folding-override-' + 'c'.repeat(24000),",
          "}",
          "",
        ].join("\n"),
      )
    }

    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const ledger = yield* ToolSourceLedger.Service
    const session = yield* sessions.create({
      title: `Context folding ${sourceKind} override`,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `exercise ${sourceKind} read override` }],
    })
    yield* llm.push(
      reply().tool("read", {}, `call-${sourceKind}-source`),
      reply().tool("read", {}, `call-${sourceKind}-witness`),
      reply().text("override collection complete").stop(),
    )
    yield* prompt.loop({ sessionID: session.id })

    const settled = (yield* MessageV2.filterCompactedEffect(session.id))
      .filter(
        (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } => message.info.role === "assistant",
      )
      .flatMap((message) =>
        message.parts
          .filter(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "read" && part.state.status === "completed",
          )
          .map((part) => ({ messageID: message.info.id, part })),
      )
    expect(settled).toHaveLength(2)
    const identities = yield* Effect.forEach(settled, ({ messageID, part }) =>
      ledger.lookup({ sessionID: session.id, assistantMessageID: messageID, callID: part.callID, toolName: part.tool }),
    )
    expect(identities.map((identity) => identity?.sourceKind)).toEqual([sourceKind, sourceKind])

    for (let index = 0; index < 4; index++) {
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: `recent override protection ${index}` }],
      })
      yield* llm.text(`recent-override-${index}-${"context ".repeat(3_000)}`)
      yield* prompt.loop({ sessionID: session.id })
    }

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "send override history unchanged" }],
    })
    yield* llm.text("override request accepted")
    yield* prompt.loop({ sessionID: session.id })

    const outbound = JSON.stringify((yield* llm.hits).at(-1)?.body ?? {})
    expect(outbound).not.toContain("Duplicate tool output folded")
    expect(outbound).toContain(`${sourceKind}-context-folding-override`)
    expect(yield* llm.pending).toBe(0)
  })

const contextFoldingDisabledClosedLoop = (runtime: "ai-sdk" | "native") =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({
      ...foldingProviderCfg(url),
      compaction: { auto: false, dynamic: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: `Context folding disabled ${runtime}`,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "fold-disabled.txt")
    const marker = `disabled-full-output-${runtime}-`
    yield* writeText(file, `${marker}${"d".repeat(28_000)}\n`)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "collect disabled duplicate context" }],
    })
    yield* llm.push(
      reply().tool("read", { filePath: file }, "call-disabled-source"),
      reply().tool("read", { filePath: file }, "call-disabled-witness"),
      reply().text("disabled collection complete").stop(),
    )
    yield* prompt.loop({ sessionID: session.id })

    for (let index = 0; index < 4; index++) {
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: `disabled recent protection ${index}` }],
      })
      yield* llm.text(`disabled-recent-${index}-${"context ".repeat(3_000)}`)
      yield* prompt.loop({ sessionID: session.id })
    }

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "send disabled history unchanged" }],
    })
    yield* llm.text("disabled request accepted")
    yield* prompt.loop({ sessionID: session.id })

    const outbound = JSON.stringify((yield* llm.hits).at(-1)?.body ?? {})
    expect(outbound).not.toContain("Duplicate tool output folded")
    expect((outbound.match(new RegExp(marker, "g")) ?? []).length).toBeGreaterThanOrEqual(2)
    const stored = (yield* MessageV2.filterCompactedEffect(session.id))
      .flatMap((message) => message.parts)
      .filter(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "read" && part.state.status === "completed",
      )
    expect(stored).toHaveLength(2)
    expect(stored.every((part) => part.state.output.includes(marker))).toBe(true)
    expect(yield* llm.pending).toBe(0)
  })

const occurrences = (value: string, marker: string) => value.split(marker).length - 1

const expectBoundedOriginalOpenCodeSummary = (body: unknown, markers: { read: string; grep: string; glob: string }) => {
  const text = JSON.stringify(body)
  expect(text).not.toContain("Duplicate tool output folded")
  expect(occurrences(text, markers.read)).toBeGreaterThanOrEqual(2)
  expect(occurrences(text, markers.grep)).toBeGreaterThanOrEqual(2)
  expect(occurrences(text, markers.glob)).toBeGreaterThanOrEqual(2)
  expect(occurrences(text, "Tool output truncated for compaction")).toBeGreaterThanOrEqual(4)
}

const lifecycleSnapshot = (messages: SessionV1.WithParts[]) =>
  messages
    .flatMap((message) => message.parts)
    .filter(
      (part): part is CompletedToolPart =>
        part.type === "tool" &&
        part.state.status === "completed" &&
        ["read", "grep", "glob"].includes(part.tool) &&
        part.callID.startsWith("call-lifecycle-"),
    )
    .map((part) => ({
      id: part.id,
      messageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      input: part.state.input,
      output: part.state.output,
      metadata: part.state.metadata,
    }))

const lifecycleLedger = (file: string) =>
  Effect.promise(() => Bun.file(file).text()).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line): { event: string } => JSON.parse(line)),
    ),
  )

const seedFoldedOpenCodeLifecycle = Effect.fn("test.seedFoldedOpenCodeLifecycle")(function* (input: {
  runtime: "ai-sdk" | "native"
}) {
  const { dir, llm } = yield* useServerConfig(foldingAutoProviderCfg)
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: `Context folding lifecycle ${input.runtime}`,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const readFile = path.join(dir, "lifecycle-read.txt")
  const grepFile = path.join(dir, "lifecycle-grep.txt")
  const globDir = path.join(dir, "lifecycle-glob")
  const ledger = path.join(dir, "s08-lifecycle-ledger.ndjson")
  const toolFile = path.join(dir, ".opencode", "tools", "s08_lifecycle.ts")
  const markers = {
    read: `lifecycle-read-${input.runtime}-`,
    grep: `lifecycle-needle-0-${input.runtime}-`,
    glob: "lifecycle-glob-",
  }

  yield* writeText(readFile, foldingReadBody(markers.read))
  yield* writeText(
    grepFile,
    Array.from({ length: 40 }, (_, index) => `lifecycle-needle-${index}-${input.runtime}-${"g".repeat(320)}`).join(
      "\n",
    ),
  )
  yield* writeText(
    toolFile,
    [
      "export default {",
      "  description: 'S08 lifecycle side-effect probe',",
      "  args: {},",
      "  execute: async () => {",
      "    const { appendFile } = await import('node:fs/promises')",
      `    const ledger = ${JSON.stringify(ledger)}`,
      "    await appendFile(ledger, JSON.stringify({ event: 'start' }) + '\\n')",
      "    await appendFile(ledger, JSON.stringify({ event: 'complete' }) + '\\n')",
      "    return 's08-lifecycle-complete'",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  yield* ensureDir(globDir)
  yield* Effect.forEach(
    Array.from({ length: 80 }, (_, index) =>
      path.join(globDir, `lifecycle-glob-${String(index).padStart(3, "0")}-${input.runtime}-${"n".repeat(80)}.txt`),
    ),
    (file) => writeText(file, "glob"),
    { concurrency: 16 },
  )

  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "collect lifecycle duplicate context" }],
  })
  yield* llm.push(
    reply().tool("s08_lifecycle", {}, "call-lifecycle-side-effect"),
    reply().tool("read", { filePath: readFile }, "call-lifecycle-read-source"),
    reply().tool("read", { filePath: readFile }, "call-lifecycle-read-witness"),
    reply().tool("grep", { pattern: "lifecycle-needle", path: grepFile }, "call-lifecycle-grep-source"),
    reply().tool("grep", { pattern: "lifecycle-needle", path: grepFile }, "call-lifecycle-grep-witness"),
    reply().tool("glob", { pattern: "**/*.txt", path: globDir }, "call-lifecycle-glob-source"),
    reply().tool("glob", { pattern: "**/*.txt", path: globDir }, "call-lifecycle-glob-witness"),
    reply().text("lifecycle collection complete").stop(),
  )
  yield* prompt.loop({ sessionID: session.id })

  for (let index = 0; index < 4; index++) {
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `lifecycle recent protection ${index}` }],
    })
    yield* llm.text(`lifecycle-recent-${index}-${"context ".repeat(3_000)}`)
    yield* prompt.loop({ sessionID: session.id })
  }

  const persisted = lifecycleSnapshot(yield* MessageV2.filterCompactedEffect(session.id))
  expect(persisted).toHaveLength(6)
  expect(persisted.every((part) => part.output.includes(input.runtime))).toBe(true)
  const persistedByCallID = new Map(persisted.map((part) => [part.callID, part]))
  for (const callID of ["call-lifecycle-read-source", "call-lifecycle-read-witness"]) {
    const part = persistedByCallID.get(callID)
    expect(part).toBeDefined()
    if (!part) throw new Error(`missing stored lifecycle read result ${callID}`)
    expect(part.output.length).toBeGreaterThan(20_000)
    expect(part.output).not.toContain("(line truncated to 2000 chars)")
    expect(part.metadata.truncated).toBe(false)
  }
  const sideEffects = yield* lifecycleLedger(ledger)
  expect(sideEffects).toEqual([{ event: "start" }, { event: "complete" }])

  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "observe folded lifecycle history" }],
  })
  yield* llm.text(`lifecycle-folded-${input.runtime}`)
  yield* prompt.loop({ sessionID: session.id })
  const foldedBody = (yield* llm.hits).at(-1)?.body ?? {}
  const foldedText = JSON.stringify(foldedBody)
  for (const [tool, marker] of [
    ["read", markers.read],
    ["grep", `lifecycle-needle-39-${input.runtime}-`],
    ["glob", `lifecycle-glob-079-${input.runtime}-`],
  ] as const) {
    const sourceCallID = `call-lifecycle-${tool}-source`
    const witnessCallID = `call-lifecycle-${tool}-witness`
    const source = persistedByCallID.get(sourceCallID)
    const witness = persistedByCallID.get(witnessCallID)
    expect(source).toBeDefined()
    expect(witness).toBeDefined()
    if (!source) throw new Error(`missing stored lifecycle ${tool} source`)
    if (!witness) throw new Error(`missing stored lifecycle ${tool} witness`)
    expect(witness.output).toContain(marker)
    expectFoldedBuiltinPair({
      tool,
      body: foldedBody,
      sourceCallID,
      sourceOutput: source.output,
      witnessCallID,
      witnessOutput: witness.output,
    })
  }
  expect(occurrences(foldedText, "Duplicate tool output folded")).toBeGreaterThanOrEqual(3)
  expect(foldedText).toContain("call-lifecycle-read-witness")
  expect(foldedText).toContain("call-lifecycle-grep-witness")
  expect(foldedText).toContain("call-lifecycle-glob-witness")
  expect(foldedText).toContain(markers.read)
  expect(foldedText).toContain(`lifecycle-needle-39-${input.runtime}-`)
  expect(foldedText).toContain(`lifecycle-glob-079-${input.runtime}-`)

  return { llm, prompt, sessions, session, ledger, markers, persisted }
})

const assertOpenCodeLifecycleDurability = Effect.fn("test.assertOpenCodeLifecycleDurability")(function* (input: {
  sessions: Session.Interface
  sessionID: SessionID
  ledger: string
  persisted: ReturnType<typeof lifecycleSnapshot>
}) {
  expect(lifecycleSnapshot(yield* input.sessions.messages({ sessionID: input.sessionID }))).toEqual(input.persisted)
  expect(yield* lifecycleLedger(input.ledger)).toEqual([{ event: "start" }, { event: "complete" }])
})

const contextFoldingAutomaticLifecycle = (runtime: "ai-sdk" | "native") =>
  Effect.gen(function* () {
    const fixture = yield* seedFoldedOpenCodeLifecycle({ runtime })
    const before = (yield* fixture.llm.hits).length
    yield* fixture.prompt.prompt({
      sessionID: fixture.session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "trigger threshold automatic compaction" }],
    })
    yield* fixture.llm.text(`s08-threshold-trigger-${runtime}`, { usage: { input: 11_500, output: 10 } })
    yield* fixture.llm.text(`s08-threshold-summary-${runtime}`)
    yield* fixture.llm.text(`s08-threshold-continued-${runtime}`)
    const result = yield* fixture.prompt.loop({ sessionID: fixture.session.id })
    const hits = (yield* fixture.llm.hits).slice(before)

    expect(hits).toHaveLength(3)
    expect(JSON.stringify(hits[0]?.body ?? {})).toContain("Duplicate tool output folded")
    expectBoundedOriginalOpenCodeSummary(hits[1]?.body ?? {}, fixture.markers)
    expect(JSON.stringify(hits[2]?.body ?? {})).toContain(`s08-threshold-summary-${runtime}`)
    expect(JSON.stringify(hits[2]?.body ?? {})).not.toContain("Duplicate tool output folded")
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    expect(
      (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).some(
        (message) => message.info.role === "assistant" && message.info.summary === true,
      ),
    ).toBe(true)
    yield* assertOpenCodeLifecycleDurability({
      sessions: fixture.sessions,
      sessionID: fixture.session.id,
      ledger: fixture.ledger,
      persisted: fixture.persisted,
    })
    expect(yield* fixture.llm.pending).toBe(0)
  })

const contextFoldingOverflowLifecycle = (runtime: "ai-sdk" | "native", recovery: "success" | "terminal") =>
  Effect.gen(function* () {
    const fixture = yield* seedFoldedOpenCodeLifecycle({ runtime })
    yield* fixture.prompt.prompt({
      sessionID: fixture.session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `trigger ${recovery} context overflow` }],
    })
    const before = (yield* fixture.llm.hits).length
    yield* fixture.llm.error(413, { error: { message: "request entity too large" } })
    if (recovery === "success") {
      yield* fixture.llm.text(`s08-auto-summary-${runtime}`)
      yield* fixture.llm.text(`s08-overflow-recovered-${runtime}`)
    } else {
      yield* fixture.llm.error(413, { error: { message: "request entity too large during summary" } })
    }

    const result = yield* fixture.prompt.loop({ sessionID: fixture.session.id })
    const hits = (yield* fixture.llm.hits).slice(before)
    expect(JSON.stringify(hits[0]?.body ?? {})).toContain("Duplicate tool output folded")
    if (recovery === "success") {
      expect(hits).toHaveLength(3)
      expectBoundedOriginalOpenCodeSummary(hits[1]?.body ?? {}, fixture.markers)
      expect(JSON.stringify(hits[2]?.body ?? {})).toContain(`s08-auto-summary-${runtime}`)
      expect(JSON.stringify(hits[2]?.body ?? {})).not.toContain("Duplicate tool output folded")
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.finish).toBe("stop")
        expect(result.info.error).toBeUndefined()
      }
      expect(
        (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).some(
          (message) => message.info.role === "assistant" && message.info.summary === true,
        ),
      ).toBe(true)
    } else {
      expect(hits).toHaveLength(2)
      expectBoundedOriginalOpenCodeSummary(hits[1]?.body ?? {}, fixture.markers)
      expect(result.info.role).toBe("assistant")
      const terminal = (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).findLast(
        (message) => message.info.role === "assistant" && message.info.summary === true,
      )
      expect(terminal?.info.role).toBe("assistant")
      if (terminal?.info.role === "assistant") {
        expect(terminal.info.finish).toBe("error")
        expect(terminal.info.error?.name).toBe("ContextOverflowError")
      }
    }
    yield* assertOpenCodeLifecycleDurability({
      sessions: fixture.sessions,
      sessionID: fixture.session.id,
      ledger: fixture.ledger,
      persisted: fixture.persisted,
    })
    expect(yield* fixture.llm.pending).toBe(0)
  })

stableFoldingIt.instance(
  "runs builtin read/grep/glob settlement through stored history into the next AI SDK request",
  () => contextFoldingClosedLoop("ai-sdk"),
  30_000,
)

stableNativeFoldingIt.instance(
  "runs builtin read/grep/glob settlement through stored history into the next Native request",
  () => contextFoldingClosedLoop("native"),
  30_000,
)

it.instance(
  "keeps the full AI SDK outbound history when dynamic folding is disabled",
  () => contextFoldingDisabledClosedLoop("ai-sdk"),
  30_000,
)

nativeIt.instance(
  "keeps the full Native outbound history when dynamic folding is disabled",
  () => contextFoldingDisabledClosedLoop("native"),
  30_000,
)

stableFoldingIt.instance(
  "automatically compacts AI SDK folded history at the token threshold",
  () => contextFoldingAutomaticLifecycle("ai-sdk"),
  30_000,
)

stableNativeFoldingIt.instance(
  "automatically compacts Native folded history at the token threshold",
  () => contextFoldingAutomaticLifecycle("native"),
  30_000,
)

stableFoldingIt.instance(
  "recovers AI SDK overflow through an unprojected summary and a continued turn",
  () => contextFoldingOverflowLifecycle("ai-sdk", "success"),
  30_000,
)

stableNativeFoldingIt.instance(
  "recovers Native overflow through an unprojected summary and a continued turn",
  () => contextFoldingOverflowLifecycle("native", "success"),
  30_000,
)

stableFoldingIt.instance(
  "terminates AI SDK overflow when the full compaction request is also rejected",
  () => contextFoldingOverflowLifecycle("ai-sdk", "terminal"),
  30_000,
)

stableNativeFoldingIt.instance(
  "terminates Native overflow when the full compaction request is also rejected",
  () => contextFoldingOverflowLifecycle("native", "terminal"),
  30_000,
)

it.instance(
  "keeps a custom same-name read override unfolded after real settlement",
  () => contextFoldingOverrideFailsClosed("custom"),
  30_000,
)

withMcpReadOverride.instance(
  "keeps an MCP same-name read override unfolded after real settlement",
  () => contextFoldingOverrideFailsClosed("mcp"),
  30_000,
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("idle-only synthetic admission cannot overtake a concurrent human prompt", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const admissionStarted = yield* Deferred.make<void>()
    const admissionGate = yield* Deferred.make<void>()
    userPromptAdmissionStarted = admissionStarted
    userPromptAdmissionGate = admissionGate
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        userPromptAdmissionStarted = undefined
        userPromptAdmissionGate = undefined
      }),
    )
    yield* llm.hang

    const human = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "hold-human-admission" }],
      })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(admissionStarted), "human prompt did not enter admission")

    const wake = yield* prompt
      .promptIfIdle({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "synthetic DAG wake", synthetic: true }],
      })
      .pipe(Effect.forkChild({ startImmediately: true }))

    yield* Deferred.succeed(admissionGate, undefined)
    const wakeResult = yield* awaitWithTimeout(
      Fiber.join(wake),
      "idle-only prompt did not reject after human admission won",
    )
    expect(wakeResult._tag).toBe("None")
    expect(
      (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .some((part) => part.type === "text" && part.text === "synthetic DAG wake"),
    ).toBe(false)

    yield* llm.wait(1)
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(human)
  }),
)

it.instance("interrupting idle-only admission releases the reserved runner", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    const admissionStarted = yield* Deferred.make<void>()
    const admissionGate = yield* Deferred.make<void>()
    userPromptAdmissionStarted = admissionStarted
    userPromptAdmissionGate = admissionGate
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(admissionGate, undefined).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            userPromptAdmissionStarted = undefined
            userPromptAdmissionGate = undefined
          }),
        ),
      ),
    )

    const wake = yield* prompt
      .promptIfIdle({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "hold-human-admission", synthetic: true }],
      })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(admissionStarted), "idle-only prompt did not enter admission")

    yield* Fiber.interrupt(wake)
    yield* pollWithTimeout(
      run.assertNotBusy(chat.id).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: () => true as const,
        }),
      ),
      "interrupted idle-only admission left the runner busy",
      "1 second",
    )
  }),
)

it.instance("idle-only prompt resolves only after the full provider turn completes", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    let releaseTurn: (value: unknown) => void = () => {}
    yield* llm.hold(
      "wake handled",
      new Promise((resolve) => {
        releaseTurn = resolve
      }),
    )

    const wake = yield* prompt
      .promptIfIdle({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "synthetic DAG wake", synthetic: true }],
      })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(llm.wait(1), "idle-only prompt did not reach the provider")

    // The DAG orchestrator-unresponsive net (DagLoop.tryDeliverWake) re-reads
    // the wake batch as soon as promptIfIdle resolves and fails the workflow
    // if it still looks stalled. That judgement is only sound while
    // promptIfIdle waits for the FULL provider turn (runLoop) — resolving
    // after admission alone would create a mis-kill window. Pin the contract.
    const early = yield* Fiber.join(wake).pipe(
      Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("still-running" as const) }),
    )
    expect(early).toBe("still-running")

    releaseTurn(undefined)
    const result = yield* awaitWithTimeout(Fiber.join(wake), "idle-only prompt did not resolve after turn completion")
    expect(result._tag).toBe("Some")
  }),
)

it.instance("idle-only preparation keeps the provider stopped until activation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    let releaseTurn: (value: unknown) => void = () => {}
    yield* llm.hold(
      "wake handled",
      new Promise((resolve) => {
        releaseTurn = resolve
      }),
    )

    const prepared = Option.getOrThrow(
      yield* prompt.prepareIfIdle({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "fenced synthetic wake", synthetic: true }],
      }),
    )
    const beforeActivation = yield* llm.wait(1).pipe(
      Effect.as("provider-started" as const),
      Effect.timeoutOrElse({
        duration: "250 millis",
        orElse: () => Effect.succeed("provider-stopped" as const),
      }),
    )
    expect(beforeActivation).toBe("provider-stopped")

    yield* prepared.activate
    yield* awaitWithTimeout(llm.wait(1), "idle-only preparation did not activate the provider")
    releaseTurn(undefined)
    yield* awaitWithTimeout(prepared.result, "idle-only preparation did not finish")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    const queued = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === id)
    const queuedText = queued?.parts.find((part): part is SessionV1.TextPart => part.type === "text")
    if (!queued || !queuedText) throw new Error("expected queued text message")
    const edited = yield* prompt.editQueuedMessage({
      sessionID: chat.id,
      messageID: id,
      partID: queuedText.id,
      expectedText: queuedText.text,
      expectedPartIDs: queued.parts.map((part) => part.id),
      text: "edited second",
    })
    expect(edited.parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "edited second" })]))

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "edited second" })
  }),
)

it.instance("deleting a queued prompt removes it from the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queued delete" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")
    const run = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)

    const removed = yield* user(chat.id, "delete before next request")
    yield* user(chat.id, "keep for next request")
    const queued = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === removed.id)
    const queuedText = queued?.parts.find((part): part is SessionV1.TextPart => part.type === "text")
    if (!queued || !queuedText) throw new Error("expected removable queued message")
    expect(
      yield* prompt.deleteQueuedMessage({
        sessionID: chat.id,
        messageID: removed.id,
        partID: queuedText.id,
        expectedText: queuedText.text,
        expectedPartIDs: queued.parts.map((part) => part.id),
      }),
    ).toBeTrue()

    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.await(run)

    const secondInput = JSON.stringify((yield* llm.inputs).at(-1)?.messages ?? [])
    expect(secondInput).toContain("keep for next request")
    expect(secondInput).not.toContain("delete before next request")
  }),
)

snapshotFenceNoLLMServer.instance("rejects queued mutations after claim and before assistant persistence", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    snapshotFenceStarted = started
    snapshotFenceGate = gate
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(gate, undefined).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            snapshotFenceStarted = undefined
            snapshotFenceGate = undefined
          }),
        ),
      ),
    )

    const { directory } = yield* TestInstance
    yield* writeConfig(directory, cfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Admission fence" })
    const first = yield* user(chat.id, "first")
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: first.id,
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: directory, root: directory },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    } satisfies SessionV1.Assistant)
    const target = yield* user(chat.id, "queued")
    const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(started), "snapshot fence did not open")

    const claimed = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === target.id)
    const text = claimed?.parts.find((part): part is SessionV1.TextPart => part.type === "text")
    if (claimed?.info.role !== "user" || !text) throw new Error("expected claimed queued message")
    expect(claimed.info.time.consumed).toBeNumber()
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).some(
        (message) => message.info.role === "assistant" && message.info.parentID === target.id,
      ),
    ).toBeFalse()

    const assertConsumedConflict = <A>(exit: Exit.Exit<A, SessionPrompt.QueuedMessageError>) => {
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "QueuedMessageConflict",
          kind: "already_consumed",
        })
      }
    }
    assertConsumedConflict(
      yield* prompt
        .editQueuedMessage({
          sessionID: chat.id,
          messageID: target.id,
          partID: text.id,
          expectedText: text.text,
          expectedPartIDs: claimed.parts.map((part) => part.id),
          text: "must not edit",
        })
        .pipe(Effect.exit),
    )
    assertConsumedConflict(
      yield* prompt
        .deleteQueuedMessage({
          sessionID: chat.id,
          messageID: target.id,
          partID: text.id,
          expectedText: text.text,
          expectedPartIDs: claimed.parts.map((part) => part.id),
        })
        .pipe(Effect.exit),
    )

    yield* prompt.cancel(chat.id)
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.await(run)
  }),
)

it.instance("claims every user in a snapshot before the provider and preserves claims after abort", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const firstGate = yield* Deferred.make<void>()
    const secondGate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Snapshot claims" })

    yield* llm.hold("first", deferredAsPromise(firstGate))
    yield* llm.hold("second", deferredAsPromise(secondGate))

    const run = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)

    const earlier = yield* user(chat.id, "queued earlier")
    const latest = yield* user(chat.id, "queued latest")
    const staleEarlier = { ...earlier, time: { ...earlier.time } }
    yield* Deferred.succeed(firstGate, void 0)
    yield* llm.wait(2)

    const claimed = yield* sessions.messages({ sessionID: chat.id })
    const claimedEarlier = claimed.find((message) => message.info.id === earlier.id)
    const claimedLatest = claimed.find((message) => message.info.id === latest.id)
    if (claimedEarlier?.info.role !== "user" || claimedLatest?.info.role !== "user") {
      throw new Error("expected both queued users")
    }
    expect(claimedEarlier.info.time.consumed).toBeNumber()
    expect(claimedLatest.info.time.consumed).toBeNumber()
    expect(
      claimed.some((message) => message.info.role === "assistant" && message.info.parentID === earlier.id),
    ).toBeFalse()

    const earlierText = claimedEarlier.parts.find((part): part is SessionV1.TextPart => part.type === "text")
    if (!earlierText) throw new Error("expected earlier queued text")
    const rejected = yield* prompt
      .editQueuedMessage({
        sessionID: chat.id,
        messageID: earlier.id,
        partID: earlierText.id,
        expectedText: earlierText.text,
        expectedPartIDs: claimedEarlier.parts.map((part) => part.id),
        text: "must not replace consumed input",
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(rejected)).toBeTrue()
    if (Exit.isFailure(rejected)) {
      expect(Cause.squash(rejected.cause)).toMatchObject({
        _tag: "QueuedMessageConflict",
        kind: "already_consumed",
      })
    }

    yield* sessions.updateMessage(staleEarlier)
    yield* prompt.cancel(chat.id)
    yield* Deferred.succeed(secondGate, void 0)
    yield* Fiber.await(run)

    const afterAbort = (yield* sessions.messages({ sessionID: chat.id })).find(
      (message) => message.info.id === earlier.id,
    )
    expect(afterAbort?.info.role === "user" && afterAbort.info.time.consumed).toBe(claimedEarlier.info.time.consumed)
  }),
)

it.instance("claims ordinary users before a manual compaction request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const compaction = yield* SessionCompaction.Service
    const chat = yield* sessions.create({ title: "Compaction claims" })

    yield* user(chat.id, "establish history")
    yield* llm.text("history established")
    yield* prompt.loop({ sessionID: chat.id })

    const earlier = yield* user(chat.id, "queued before compaction")
    const latest = yield* user(chat.id, "also queued before compaction")
    yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
    yield* llm.text("summary")
    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    for (const id of [earlier.id, latest.id]) {
      const message = messages.find((item) => item.info.id === id)
      expect(message?.info.role === "user" && message.info.time.consumed).toBeNumber()
    }
    const compactionMessage = messages.find((message) => message.parts.some((part) => part.type === "compaction"))
    expect(compactionMessage?.info.role === "user" && compactionMessage.info.time.consumed).toBeUndefined()
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

it.instance("stores the slash invocation as visible text and hides the expanded command template", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: {
        probe: {
          template: "Expanded command instructions:\n$ARGUMENTS",
        },
      },
    }))
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("done")

    yield* prompt.command({
      sessionID: chat.id,
      command: "probe",
      arguments: "inspect layout",
    })

    const user = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.role === "user")
    const texts = user?.parts.filter((part): part is SessionV1.TextPart => part.type === "text") ?? []

    expect(texts.filter((part) => !part.synthetic).map((part) => part.text)).toEqual(["/probe inspect layout"])
    // Memory tells command invocations from pasted paths by this marker.
    expect(texts.find((part) => !part.synthetic)?.metadata?.command).toBe("probe")
    expect(texts.filter((part) => part.synthetic).map((part) => part.text)).toContain(
      "Expanded command instructions:\ninspect layout",
    )
    expect(JSON.stringify(yield* llm.inputs)).toContain("Expanded command instructions")
  }),
)

noLLMServer.instance(
  "dispatches /memory on, off, and status without running a model turn",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()

      const off = yield* prompt.command({ sessionID: chat.id, command: "memory", arguments: "off" })
      const on = yield* prompt.command({ sessionID: chat.id, command: "memory", arguments: "on" })
      // #396: a non-on/off argument is a status query — the reply must reflect
      // the service's true state instead of the old hardcoded "remains off".
      const status = yield* prompt.command({ sessionID: chat.id, command: "memory", arguments: "" })
      const unsupported = yield* prompt.command({ sessionID: chat.id, command: "memory", arguments: "topic 20" })

      expect(off.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "/memory off",
        "Memory off",
      ])
      expect(
        off.parts.find((part): part is SessionV1.TextPart => part.type === "text" && part.text === "/memory off")
          ?.metadata?.command,
      ).toBe("memory")
      expect(on.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "/memory on",
        "Memory on",
      ])
      expect(status.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "/memory",
        "Memory on",
      ])
      expect(unsupported.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "/memory topic 20",
        "Memory on",
      ])
      expect((yield* sessions.messages({ sessionID: chat.id })).every((message) => message.info.role === "user")).toBe(
        true,
      )
    }),
  { config: cfg },
)

withMemoryContext.instance("injects MEMORY data into the main model system context", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "use the project preference" }],
    })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: chat.id })

    expect(JSON.stringify((yield* llm.hits)[0]?.body)).toContain("project-memory-probe")
  }),
)

withMemoryContext.instance("does not inject MEMORY data into child agent sessions", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions } = yield* boot()
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({ title: "Child", parentID: parent.id })
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "inspect the delegated task" }],
    })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: child.id })

    expect(JSON.stringify((yield* llm.hits)[0]?.body)).not.toContain("project-memory-probe")
  }),
)

it.instance("dispatches /goal set through the Goal service and runs one loop turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const goalSvc = yield* Goal.Service
    yield* llm.text("working")

    const result = yield* prompt.command({
      sessionID: chat.id,
      command: "goal",
      arguments: "write the docs",
    })
    // kick dispatch returns the loop result (assistant WithParts)
    expect(result.info.role).toBe("assistant")
    const texts = (yield* sessions.messages({ sessionID: chat.id }))
      .flatMap((message) => message.parts)
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)

    expect(texts).toContain("/goal write the docs")
    expect(texts.some((text) => text.includes("目标已设定"))).toBe(true)
    const state = yield* goalSvc.load(chat.id)
    expect(state?.goal).toBe("write the docs")
    expect(state?.status).toBe("active")
    expect((yield* llm.inputs).length).toBe(1)
  }),
)

it.instance("returns /goal status without running a loop turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const goalSvc = yield* Goal.Service
    yield* goalSvc.set(chat.id, "status probe goal")

    const result = yield* prompt.command({
      sessionID: chat.id,
      command: "goal",
      arguments: "status",
    })
    const texts = result.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)

    expect(texts).toContain("/goal status")
    expect(texts.some((text) => text.includes("status probe goal"))).toBe(true)
    expect((yield* llm.inputs).length).toBe(0)
  }),
)

it.instance("dispatches /subgoal add through the Goal service without a loop turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const goalSvc = yield* Goal.Service
    yield* goalSvc.set(chat.id, "goal with subgoals")

    const result = yield* prompt.command({
      sessionID: chat.id,
      command: "subgoal",
      arguments: "step one",
    })
    const texts = result.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)

    expect(texts).toContain("/subgoal step one")
    const state = yield* goalSvc.load(chat.id)
    expect(state?.subgoals).toContain("step one")
    expect((yield* llm.inputs).length).toBe(0)
  }),
)

const noGoal = testEffect(makeHttp({ goal: false }))
noGoal.instance("falls through to the command registry when the Goal service is absent", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("noop")

    yield* prompt.command({
      sessionID: chat.id,
      command: "goal",
      arguments: "orphan request",
    })

    const texts = (yield* sessions.messages({ sessionID: chat.id }))
      .flatMap((message) => message.parts)
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)
    expect(texts.some((text) => text.includes("目标已设定"))).toBe(false)
    // Positive fall-through markers: the command registry path persists the
    // slash text and drives exactly one LLM turn (empty template expansion).
    expect(texts).toContain("/goal orphan request")
    expect((yield* llm.inputs).length).toBe(1)
  }),
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("aborted before completion")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("aborted before completion")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      // Let the shell reader publish its final truncation metadata before cancellation races it.
      yield* Effect.sleep(50)
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated, JSON.stringify(tool.state.metadata)).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("aborted before completion")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ref.providerID, modelID: ModelV2.ID.make("other-test-model") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "other-test-model": {
              ...cfg.provider.test.models["test-model"],
              id: "other-test-model",
              name: "Isolated variant alternative",
            },
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

function goalRuntime(call: GoalLoopJudgeLLM["Service"]["call"], onSettled = () => {}) {
  const goalLayer = Layer.effect(
    Goal.Service,
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      return Goal.Service.of({
        ...goal,
        clearLoopFiberIf: (sessionID, fiber) =>
          goal.clearLoopFiberIf(sessionID, fiber).pipe(Effect.tap(() => Effect.sync(onSettled))),
      })
    }),
  ).pipe(Layer.provide(Goal.defaultLayer))
  return GoalLoop.layer.pipe(
    Layer.provideMerge(makeHttp({ goalLayer })),
    Layer.provideMerge(Layer.succeed(GoalLoopJudgeLLM, { call })),
  )
}

for (const verdict of ["done", "blocked", "continue"] as const) {
  let started = false
  let settled = false
  let release: Deferred.Deferred<void>
  const race = testEffect(
    goalRuntime(
      () =>
        Effect.gen(function* () {
          started = true
          yield* Deferred.await(release)
          return JSON.stringify({ verdict, reason: "old response" })
        }),
      () => {
        settled = true
      },
    ),
  )
  race.instance(`Goal rejects stale ${verdict} while a new human turn is running`, () =>
    Effect.gen(function* () {
      started = false
      settled = false
      release = yield* Deferred.make<void>()
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const goal = yield* Goal.Service
      yield* seed(chat.id, { finish: "stop" })
      yield* goal.set(chat.id, "write the docs")
      yield* (yield* GoalLoop.Service).init()
      yield* pollWithTimeout(
        Effect.sync(() => started || undefined),
        "judge never started",
      )
      yield* llm.hang
      const work = yield* prompt
        .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Add the missing section first." }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)
      yield* Deferred.succeed(release, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => settled || undefined),
        "judge never settled",
      )
      expect(yield* goal.lastOutcome(chat.id)).toBeUndefined()
      expect(yield* goal.load(chat.id)).toMatchObject({ status: "active", turns_used: 0 })
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(work)
    }),
  )
}

for (const command of [
  { command: "goal", arguments: "status" },
  { command: "subgoal", arguments: "additional criterion" },
]) {
  let calls: string[] = []
  let release: Deferred.Deferred<void>
  const controls = testEffect(
    goalRuntime((opts) =>
      Effect.gen(function* () {
        calls.push(opts.user)
        yield* Deferred.await(release)
        return JSON.stringify({ verdict: "continue", reason: "more work remains" })
      }),
    ),
  )
  controls.instance(`Goal /${command.command} control preserves the pending work boundary`, () =>
    Effect.gen(function* () {
      calls = []
      release = yield* Deferred.make<void>()
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const goal = yield* Goal.Service
      yield* seed(chat.id, { finish: "stop" })
      yield* goal.set(chat.id, "write the docs")
      yield* (yield* GoalLoop.Service).init()
      yield* pollWithTimeout(
        Effect.sync(() => calls.length || undefined),
        "judge never started",
      )
      for (let i = 0; i < (command.command === "goal" ? 25 : 1); i++) {
        yield* prompt.command({ sessionID: chat.id, ...command })
      }
      if (command.command === "subgoal") {
        yield* pollWithTimeout(
          Effect.sync(() => calls.some((x) => x.includes("additional criterion")) || undefined),
          "new subgoal was not judged",
        )
      }
      yield* llm.hang
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(llm.wait(1), "control prevented continuation")
      expect(yield* goal.load(chat.id)).toMatchObject({ status: "active", turns_used: 1 })
      if (command.command === "goal") expect(calls).toHaveLength(1)
      const inputs = JSON.stringify(
        (yield* llm.inputs).map((input) =>
          Array.isArray(input.messages) ? input.messages.filter((m: { role: string }) => m.role === "user") : [],
        ),
      )
      expect(inputs).not.toContain("/goal status")
      if (command.command === "subgoal") expect(inputs).toContain("additional criterion")
      yield* prompt.cancel(chat.id)
    }),
  )
}

let goalJudges = 0
const autonomous = testEffect(
  goalRuntime(() =>
    Effect.sync(() =>
      JSON.stringify({
        verdict: ++goalJudges === 1 ? "continue" : "done",
        reason: "scripted progress",
      }),
    ),
  ),
)
autonomous.instance("Goal question cannot leave an autonomous continuation waiting for input", () =>
  Effect.gen(function* () {
    goalJudges = 0
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const goal = yield* Goal.Service
    const questions = yield* Question.Service
    yield* (yield* GoalLoop.Service).init()
    yield* llm.text("First step done.")
    yield* llm.tool("question", {
      questions: [
        {
          question: "Which option?",
          header: "Choice",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    })
    yield* llm.text("I chose A and completed the work.")
    yield* prompt.command({ sessionID: chat.id, command: "goal", arguments: "write the docs" })
    const outcome = yield* pollWithTimeout(goal.lastOutcome(chat.id), "Goal stuck waiting for a question", "5 seconds")
    expect(outcome.status).toBe("done")
    expect(yield* questions.list()).toHaveLength(0)
    expect((yield* llm.inputs).length).toBe(3)
  }),
)

for (const entry of ["prompt", "loop", "shell"] as const) {
  it.instance(`Goal idle commit serializes ${entry} admission without holding the execution`, () =>
    withSh(() =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* user(chat.id, "start work")
        const entered = yield* Deferred.make<void>()
        const attempted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const order: string[] = []
        const events = yield* EventV2Bridge.Service
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.data.sessionID === chat.id && event.data.status.type === "busy") order.push("busy")
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        const commit = yield* prompt
          .withIdle(
            chat.id,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              order.push("commit")
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* llm.hang
        const input =
          entry === "shell"
            ? prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.orDie)
            : entry === "loop"
              ? prompt.loop({ sessionID: chat.id })
              : prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "continue" }] }).pipe(Effect.orDie)
        const work = yield* Deferred.succeed(attempted, undefined).pipe(Effect.andThen(input), Effect.forkChild)
        yield* Deferred.await(attempted)
        yield* Effect.yieldNow
        expect((yield* (yield* SessionStatus.Service).get(chat.id)).type).toBe("idle")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(commit)
        yield* waitForBusy(chat.id)
        expect(order[0]).toBe("commit")
        // The commit lock is released before the provider/shell finishes.
        expect(Option.isNone(yield* prompt.withIdle(chat.id, Effect.void))).toBe(true)
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(work)
      }),
    ),
  )
}

it.instance("human prompt retains question interaction with an active Goal", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const goal = yield* Goal.Service
    const questions = yield* Question.Service
    yield* goal.set(chat.id, "write docs")
    yield* goal.markTurnDriven(chat.id)
    yield* llm.tool("question", {
      questions: [
        { question: "Which section?", header: "Section", options: [{ label: "API", description: "Document the API" }] },
      ],
    })
    yield* llm.text("Documented the API.")
    const work = yield* prompt
      .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Ask me which section to document." }] })
      .pipe(Effect.forkChild)
    const pending = yield* pollWithTimeout(
      questions.list().pipe(Effect.map((items) => items[0])),
      "human question was suppressed",
    )
    expect(yield* goal.isTurnDriven(chat.id)).toBe(false)
    yield* questions.reply({ requestID: pending.id, answers: [["API"]] })
    yield* Fiber.join(work)
    expect(yield* questions.list()).toHaveLength(0)
  }),
)

for (const dynamic of [false, true]) {
  it.instance(`review: repeated unfoldable tool results count toward the next request (dynamic=${dynamic})`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => {
        const config = providerCfg(url)
        return {
          ...config,
          compaction: { auto: true, dynamic, max_context_tokens: 25_000 },
          provider: {
            ...config.provider,
            test: {
              ...config.provider.test,
              models: {
                ...config.provider.test.models,
                "test-model": {
                  ...config.provider.test.models["test-model"],
                  limit: { context: 40_000, output: 5_000 },
                },
              },
            },
          },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Review repeated tool output" })
      const previous = yield* seed(chat.id, { finish: "tool-calls" })
      const body = "repeated tool result ".repeat(2000)
      for (let index = 0; index < 4; index++) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: previous.assistant.id,
          sessionID: chat.id,
          type: "tool",
          callID: "repeated-result-" + index,
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "status" },
            output: body,
            title: "Repeated large result",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
      }
      yield* llm.text("compact summary")
      yield* llm.text("continued answer")
      yield* prompt.loop({ sessionID: chat.id })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const compactions = messages.filter((message) => message.parts.some((part) => part.type === "compaction")).length
      expect(compactions).toBe(1)
    }),
  )
}

let controlledOrganizer: LLM.Interface["organizer"] = () => Effect.die("organizer fixture not configured")
const distillationIt = testEffect(makeHttp({ organizer: (input) => Effect.suspend(() => controlledOrganizer(input)) }))

const longThought = (label: string) => `${label} `.repeat(60).trim()
const organizedAs =
  (calls: string[]): LLM.Interface["organizer"] =>
  () =>
    Effect.succeed({
      transport: "engine" as const,
      model: "test/small",
      call:
        () =>
        async ({ prompt }) => {
          const label = prompt.match(/(tool|final|next)-thinking/)?.[1] ?? "unknown"
          calls.push(label)
          return { text: `adopted-${label}`, finishReason: "stop" }
        },
    })

for (const scenario of [
  { apiID: "qwen-test", global: true, model: undefined, expected: true },
  { apiID: "gpt-test", global: true, model: undefined, expected: true },
  { apiID: "anthropic/Claude-test", global: true, model: undefined, expected: true },
  { apiID: "qwen-test", global: false, model: true, expected: true },
  { apiID: "qwen-test", global: true, model: false, expected: false },
  { apiID: "gpt-test", global: false, model: true, expected: true },
]) {
  distillationIt.instance(
    `per-model reasoning distillation ${scenario.apiID} global=${scenario.global} model=${scenario.model}`,
    () =>
      Effect.gen(function* () {
        const { llm, dir } = yield* useServerConfig((url) => {
          const config = providerCfg(url)
          return {
            ...config,
            reasoningDistillation: { enabled: scenario.global },
            provider: {
              test: {
                ...config.provider.test,
                models: {
                  "test-model": {
                    ...config.provider.test.models["test-model"],
                    id: scenario.apiID,
                    reasoningDistillation: scenario.model === undefined ? undefined : { enabled: scenario.model },
                  },
                },
              },
            },
          }
        })
        yield* writeText(path.join(dir, "distillation-source.txt"), "source data")
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const calls: string[] = []
        controlledOrganizer = organizedAs(calls)
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read and explain" }],
        })
        yield* llm.push(
          reply()
            .reason(longThought("tool-thinking"))
            .tool("read", { filePath: path.join(dir, "distillation-source.txt") }, "read-source"),
          reply().text("answer").stop(),
        )
        yield* prompt.loop({ sessionID: chat.id })
        const sent = JSON.stringify((yield* llm.hits).at(-1)?.body)
        expect(calls).toEqual(scenario.expected ? ["tool"] : [])
        expect(sent).toContain(scenario.expected ? "adopted-tool" : "tool-thinking")
        expect(sent).not.toContain(scenario.expected ? "tool-thinking" : "adopted-tool")
        const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
        expect(parts.some((part) => part.type === "reasoning" && part.distillation !== undefined)).toBe(
          scenario.expected,
        )
      }),
  )
}

distillationIt.instance("organizes unsigned reasoning before content and continues with it", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Sync shaping",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "adopted-sync", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(
      reply().reason(longThought("sync-thinking")).text("phase-one-content").stop(),
      reply().text("final-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(1)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(2)
    const firstMessages = hits[0]?.body.messages
    const secondMessages = hits[1]?.body.messages
    expect(Array.isArray(firstMessages)).toBe(true)
    expect(Array.isArray(secondMessages)).toBe(true)
    if (Array.isArray(firstMessages) && Array.isArray(secondMessages)) {
      const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
      expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
      expect(digest(secondMessages.slice(0, firstMessages.length))).toBe(digest(firstMessages))
    }
    const sent = JSON.stringify(hits.at(-1)?.body)
    expect(sent).toContain("adopted-sync")
    expect(sent).not.toContain("sync-thinking")
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "adopted-sync")).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "final-answer")).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "phase-one-content")).toBe(false)
  }),
)

distillationIt.instance("leaves signed reasoning untouched in the same turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        reasoningDistillation: { enabled: true },
        provider: {
          test: {
            ...config.provider.test,
            npm: "@ai-sdk/anthropic",
            models: {
              "test-model": {
                ...config.provider.test.models["test-model"],
                id: "claude-fable-5-1",
                reasoning: true,
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Signed reasoning",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "must-not-adopt", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(thinkingPrefixReply("signed-signature", longThought("signed-thinking")))
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(0)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    const reasoning = parts.find((part) => part.type === "reasoning")
    expect(reasoning?.type === "reasoning" ? reasoning.text : undefined).toBe(longThought("signed-thinking"))
    expect(reasoning?.type === "reasoning" ? reasoning.metadata?.anthropic?.signature : undefined).toBe(
      "signed-signature",
    )
    expect(parts.some((part) => part.type === "text" && part.text === "fixture answer")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "must-not-adopt")).toBe(false)
  }),
)

distillationIt.instance("does not split encrypted OpenAI reasoning", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      return {
        ...config,
        reasoningDistillation: { enabled: true },
        provider: {
          test: {
            ...config.provider.test,
            npm: "@ai-sdk/openai",
            models: {
              "test-model": {
                ...config.provider.test.models["test-model"],
                id: "gpt-test",
                reasoning: true,
              },
            },
          },
        },
      }
    })
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "must-not-adopt", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(
      reply().reason(longThought("encrypted-thinking")).encryptedReason("ciphertext").text("encrypted-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(0)
    expect(yield* llm.hits).toHaveLength(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    const reasoning = parts.find((part) => part.type === "reasoning")
    expect(reasoning?.type === "reasoning" ? reasoning.text : undefined).toBe(longThought("encrypted-thinking"))
    expect(JSON.stringify(reasoning?.type === "reasoning" ? reasoning.metadata : undefined)).toContain("ciphertext")
    expect(parts.some((part) => part.type === "text" && part.text === "encrypted-answer")).toBe(true)
  }),
)

distillationIt.instance("does not split signed Gemini reasoning", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const config = providerCfg(url)
      const origin = new URL(url).origin
      return {
        ...config,
        reasoningDistillation: { enabled: true },
        provider: {
          test: {
            ...config.provider.test,
            npm: "@ai-sdk/google",
            models: {
              "test-model": {
                ...config.provider.test.models["test-model"],
                id: "gemini-2.5-flash",
                reasoning: true,
              },
            },
            options: {
              ...config.provider.test.options,
              baseURL: `${origin}/v1beta`,
            },
          },
        },
      }
    })
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "must-not-adopt", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(
      reply().reason(longThought("gemini-thinking")).signedReason("gemini-signature").text("gemini-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(0)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    const reasoning = parts.find((part) => part.type === "reasoning")
    expect(reasoning?.type === "reasoning" ? reasoning.text : undefined).toBe(longThought("gemini-thinking"))
    expect(reasoning?.type === "reasoning" ? reasoning.metadata?.google?.thoughtSignature : undefined).toBe(
      "gemini-signature",
    )
    expect(parts.some((part) => part.type === "text" && part.text === "gemini-answer")).toBe(true)
  }),
)

distillationIt.instance("falls back to the original reasoning when synchronous organization fails", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Sync fallback",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          throw new Error("organizer unavailable")
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(
      reply().reason(longThought("fallback-thinking")).text("phase-one-content").stop(),
      reply().text("fallback-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(1)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(2)
    expect(JSON.stringify(hits.at(-1)?.body)).toContain("fallback-thinking")
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "text" && part.text === "fallback-answer")).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "phase-one-content")).toBe(false)
  }),
)

distillationIt.instance("runs local hooks once around a synchronous continuation", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    yield* writeText(path.join(dir, "distillation-source.txt"), "source data")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Sync hooks",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const before = hookRecorded.length
    const calls: string[] = []
    controlledOrganizer = organizedAs(calls)
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "read and explain" }],
    })
    yield* llm.push(
      reply().reason(longThought("tool-thinking")).text("phase-one-content").stop(),
      reply().tool("read", { filePath: path.join(dir, "distillation-source.txt") }, "read-sync"),
      reply().text("hook-final").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    const events = hookRecorded.slice(before).map((payload) => payload.event)
    expect(events.filter((event) => event === "UserPromptSubmit")).toHaveLength(1)
    expect(events.filter((event) => event === "PreToolUse")).toHaveLength(1)
    expect(events.filter((event) => event === "PostToolUse")).toHaveLength(1)
    expect(events.filter((event) => event === "Stop")).toHaveLength(1)
    expect(calls).toEqual(["tool"])
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const reasoningParts = messages.flatMap((message) => message.parts).filter((part) => part.type === "reasoning")
    expect(reasoningParts).toHaveLength(1)
    expect(reasoningParts[0].type === "reasoning" ? reasoningParts[0].text : undefined).toBe("adopted-tool")
    const parts = messages.flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "text" && part.text === "hook-final")).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "phase-one-content")).toBe(false)
  }),
)

distillationIt.instance("each step's reasoning is rewritten before its first resend", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    yield* writeText(path.join(dir, "distillation-source.txt"), "source data")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const calls: string[] = []
    controlledOrganizer = organizedAs(calls)
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "read and explain" }],
    })
    yield* llm.push(
      // Each reasoning part splits before any content, so the stream stops and the next reply answers it.
      reply().reason(longThought("tool-thinking")).stop(),
      reply().tool("read", { filePath: path.join(dir, "distillation-source.txt") }, "read-source"),
      reply().reason(longThought("final-thinking")).stop(),
      reply().text("answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    // The tool step's reasoning is first resent by the second step, which already carries the rewrite.
    const hits = yield* llm.hits
    const second = JSON.stringify(hits.at(-1)?.body)
    expect(second).toContain("adopted-tool")
    expect(second).not.toContain("tool-thinking")
    // The turn waits for the final reasoning too, so both rewrites are committed before it returns.
    const turnParts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(turnParts.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
      "adopted-tool",
      "adopted-final",
    ])
    expect(calls.toSorted()).toEqual(["final", "tool"])

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "next" }],
    })
    yield* llm.text("next answer")
    yield* prompt.loop({ sessionID: chat.id })
    const next = JSON.stringify((yield* llm.hits).at(-1)?.body)
    expect(next).toContain("adopted-tool")
    expect(next).toContain("adopted-final")
    expect(next).not.toContain("thinking thinking")
    expect(calls.toSorted()).toEqual(["final", "tool"])
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
      "adopted-tool",
      "adopted-final",
    ])
    expect(parts.find((part) => part.type === "tool")).toMatchObject({
      callID: "read-source",
      state: { status: "completed" },
    })
  }),
)

distillationIt.instance("disposing the directory interrupts an in-flight rewrite", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const started = yield* Deferred.make<AbortSignal>()
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: (signal: AbortSignal) => () => {
          Deferred.doneUnsafe(started, Effect.succeed(signal))
          return new Promise<undefined>(() => {})
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think" }],
    })
    yield* llm.push(reply().reason(longThought("final-thinking")).text("answer").stop())
    const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    // The turn is blocked on the organizer, so disposing the directory must interrupt its call.
    const signal = yield* awaitWithTimeout(Deferred.await(started), "synchronous rewrite did not start")
    expect(signal.aborted).toBe(false)
    yield* Effect.promise(() => disposeInstance(dir))
    yield* pollWithTimeout(
      Effect.sync(() => signal.aborted || undefined),
      "disposing the directory did not abort",
    )
    yield* Fiber.await(loop)
  }),
)

distillationIt.instance("a rewrite committed elsewhere before a step's claim is carried by that step's request", () =>
  Effect.gen(function* () {
    // This process does not rewrite; another process sharing the database does.
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think" }],
    })
    yield* llm.push(reply().reason(longThought("final-thinking")).text("answer").stop())
    yield* prompt.loop({ sessionID: chat.id })
    const first = (yield* sessions.messages({ sessionID: chat.id })).find(
      (message) => message.info.role === "assistant",
    )
    const reasoning = first?.parts.find((part) => part.type === "reasoning")
    if (!first || !reasoning) throw new Error("missing first-turn reasoning")
    // The other process commits its rewrite after the next loop read history but before it persisted its attempt:
    // the trigger applies it in the claim's own transaction, ahead of the claim's re-read.
    yield* db.run(
      sql.raw(`CREATE TRIGGER foreign_reasoning_adoption AFTER INSERT ON message
        WHEN json_extract(NEW.data, '$.role') = 'assistant' AND NEW.id != '${first.info.id}'
        BEGIN UPDATE part SET data = json_set(data, '$.text', 'foreign-rewrite') WHERE id = '${reasoning.id}'; END`),
    )
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "next" }],
    })
    yield* llm.text("next answer")
    yield* prompt.loop({ sessionID: chat.id })
    yield* db.run(sql.raw("DROP TRIGGER foreign_reasoning_adoption"))
    const next = JSON.stringify((yield* llm.hits).at(-1)?.body)
    expect(next).toContain("foreign-rewrite")
    expect(next).not.toContain("final-thinking")
  }),
)

for (const command of ["new", "resume", "ordinary"] as const) {
  it.instance(`manual goal ${command} gets a fresh actual tool-call budget`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Synthetic Goal budget",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = path.join(dir, "first.txt")
      const second = path.join(dir, "manual-goal.txt")
      const blocked = path.join(dir, "past-new-budget.txt")
      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        parts: [{ type: "text", text: "Write the first fixture" }],
      })
      yield* llm.push(reply().tool("write", { filePath: first, content: "first" }), reply().text("first done").stop())
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* fs.exists(first)).toBe(true)
      if (command === "resume") {
        yield* goal.set(chat.id, "Write the second fixture")
        yield* goal.pauseForUserCancel(chat.id, "synthetic pause")
      }
      yield* llm.push(
        reply().tool("write", { filePath: second, content: "second" }),
        reply().tool("write", { filePath: blocked, content: "must not execute" }),
      )
      if (command === "ordinary") {
        yield* prompt.prompt({
          sessionID: chat.id,
          noReply: true,
          parts: [{ type: "text", text: "Write the second fixture" }],
        })
        yield* prompt.loop({ sessionID: chat.id })
      } else {
        yield* prompt.command({
          sessionID: chat.id,
          command: "goal",
          arguments: command === "new" ? "Write the second fixture" : "resume",
        })
      }
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs[2].tools ?? []).includes('"name":"write"')).toBe(true)
      expect(yield* fs.exists(second)).toBe(true)
      expect(yield* fs.exists(blocked)).toBe(false)
    }),
  )
}

for (const maxToolCalls of [1, 0] as const) {
  let judgeCalls = 0
  const automaticBudget = testEffect(
    goalRuntime(() =>
      Effect.sync(() => JSON.stringify({ verdict: ++judgeCalls === 1 ? "continue" : "done", reason: "synthetic" })),
    ),
  )
  automaticBudget.instance(`Goal automatic continuation preserves input tool budget (${maxToolCalls})`, () =>
    Effect.gen(function* () {
      judgeCalls = 0
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), maxToolCalls }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const fs = yield* FSUtil.Service
      const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const first = path.join(dir, "goal-first.txt")
      const second = path.join(dir, "goal-automatic.txt")
      yield* llm.push(
        reply().tool("write", { filePath: first, content: "first" }),
        reply().text("first turn done").stop(),
        reply().tool("write", { filePath: second, content: "automatic" }),
        reply().text("goal done").stop(),
      )
      yield* (yield* GoalLoop.Service).init()
      yield* prompt.command({ sessionID: chat.id, command: "goal", arguments: "Write synthetic fixtures" })
      yield* pollWithTimeout(goal.lastOutcome(chat.id), "Goal automatic budget fixture did not settle", "5 seconds")
      expect(yield* fs.exists(first)).toBe(true)
      expect(yield* fs.exists(second)).toBe(maxToolCalls === 0)
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs[2].tools ?? []).includes('"name":"write"')).toBe(maxToolCalls === 0)
    }),
  )
}

for (const stage of ["memory", "tools"] as const) {
  const delayedPreparation = testEffect(
    makeHttp(stage === "memory" ? { memoryPrepare: () => Effect.never } : { toolsReady: Effect.never }),
  )
  delayedPreparation.instance(`cancel during foreground ${stage} preparation prevents a model request`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      yield* user(chat.id, "prepare without sending")
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const status = yield* SessionStatus.Service
      const preparation = yield* pollWithTimeout(
        status
          .get(chat.id)
          .pipe(
            Effect.map((value) =>
              value.type === "busy" && value.preparation?.stage === stage ? value.preparation : undefined,
            ),
          ),
        `${stage} preparation was not observable`,
      )
      expect(preparation.startedAt).toBeGreaterThan(0)
      expect(preparation.startedAt).toBeLessThanOrEqual(Date.now())
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(run)
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect(yield* llm.hits).toHaveLength(0)
    }),
  )
}

distillationIt.instance("compacts instead of sending an oversized synchronous continuation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => {
      const base = providerCfg(url)
      return {
        ...base,
        reasoningDistillation: { enabled: true },
        provider: {
          ...base.provider,
          test: {
            ...base.provider.test,
            models: {
              ...base.provider.test.models,
              "test-model": {
                ...base.provider.test.models["test-model"],
                limit: { context: 12_000, output: 1_000 },
              },
            },
          },
        },
      }
    })
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Oversized sync continuation",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          throw new Error("organizer unavailable")
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think carefully" }],
    })
    yield* llm.push(
      reply().reason("x".repeat(100_000)).stop(),
      reply().text("compaction summary").stop(),
      reply().text("final answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    const bodies = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
    expect(bodies.some((body) => body.includes("Continue from the reasoning above"))).toBe(false)
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const parts = messages.flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "compaction")).toBe(true)
    const reasoningAssistant = messages.find(
      (message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "reasoning"),
    )
    expect(
      reasoningAssistant?.info.role === "assistant" ? reasoningAssistant.info.time.completed : undefined,
    ).toBeDefined()
  }),
)

distillationIt.instance("charges the split request whose finish chunk was cut", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => ({ text: "adopted", finishReason: "stop" }),
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think carefully" }],
    })
    yield* llm.push(reply().reason(longThought("step-1")).stop(), reply().text("final-answer").stop())
    yield* prompt.loop({ sessionID: chat.id })
    const assistant = (yield* sessions.messages({ sessionID: chat.id })).findLast(
      (message) => message.info.role === "assistant",
    )
    if (assistant?.info.role !== "assistant") throw new Error("missing assistant")
    expect(assistant.parts.some((part) => part.type === "text" && part.text === "final-answer")).toBe(true)
    expect(assistant.info.tokens.input).toBeGreaterThan(0)
    expect(assistant.info.tokens.reasoning).toBeGreaterThan(0)
  }),
)

distillationIt.instance("surfaces an organizer infrastructure defect instead of continuing silently", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    controlledOrganizer = () => Effect.die(new Error("organizer infrastructure failure"))
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think carefully" }],
    })
    yield* llm.push(reply().reason(longThought("step-1")).stop(), reply().text("final-answer").stop())
    yield* prompt.loop({ sessionID: chat.id })
    const assistant = (yield* sessions.messages({ sessionID: chat.id })).findLast(
      (message) => message.info.role === "assistant",
    )
    if (assistant?.info.role !== "assistant") throw new Error("missing assistant")
    expect(assistant.info.error).toBeDefined()
    expect(assistant.parts.some((part) => part.type === "text" && part.text === "final-answer")).toBe(false)
  }),
)

distillationIt.instance("organizes the last reasoning part when the continuation limit is exhausted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: `adopted-${organizerCalls}`, finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think carefully" }],
    })
    // Each request emits only reasoning until the fourth one, so the first three split and the last must be
    // organized in place after the continuation limit is reached.
    yield* llm.push(
      reply().reason(longThought("step-1")).stop(),
      reply().reason(longThought("step-2")).stop(),
      reply().reason(longThought("step-3")).stop(),
      reply().reason(longThought("step-4")).text("final-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(4)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(4)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    const reasoning = parts.filter((part) => part.type === "reasoning")
    expect(reasoning.map((part) => part.text)).toEqual(["adopted-1", "adopted-2", "adopted-3", "adopted-4"])
    expect(new Set(reasoning.map((part) => part.v2?.reasoningID)).size).toBe(4)
    expect(parts.some((part) => part.type === "text" && part.text === "final-answer")).toBe(true)
  }),
)

distillationIt.instance("organizes reasoning in place after visible text has started", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "adopted-late", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer first, think later" }],
    })
    // The reasoning part ends after visible text, so this request cannot split; it must be organized in place.
    yield* llm.push(reply().text("phase-one").reason(longThought("late-thinking")).stop())
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(1)
    const hits = (yield* llm.hits).filter(
      (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
    )
    expect(hits).toHaveLength(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "adopted-late")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning" && part.text === longThought("late-thinking"))).toBe(false)
    expect(parts.some((part) => part.type === "text" && part.text === "phase-one")).toBe(true)
  }),
)

distillationIt.instance("organizes reasoning in place after a tool call has started", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    yield* writeText(path.join(dir, "distillation-source.txt"), "source data")
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "adopted-after-tool", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "call a tool, then think" }],
    })
    // Tool activity and the reasoning part share one attempt, so this request cannot split and the part must be
    // organized in place.
    yield* llm.push(
      reply()
        .tool("read", { filePath: path.join(dir, "distillation-source.txt") }, "read-after-tool")
        .reason(longThought("after-tool")),
      reply().text("tool-answer").stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "adopted-after-tool")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning" && part.text === longThought("after-tool"))).toBe(false)
    expect(parts.find((part) => part.type === "tool")).toMatchObject({
      callID: "read-after-tool",
      state: { status: "completed" },
    })
    expect(parts.some((part) => part.type === "text" && part.text === "tool-answer")).toBe(true)
  }),
)

distillationIt.instance("does not split reasoning below the organizer minimum", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    let organizerCalls = 0
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => {
          organizerCalls++
          return { text: "must-not-adopt", finishReason: "stop" }
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "answer directly" }],
    })
    yield* llm.push(reply().reason("short thought").text("short-answer").stop())
    yield* prompt.loop({ sessionID: chat.id })
    expect(organizerCalls).toBe(0)
    expect(yield* llm.hits).toHaveLength(1)
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "short thought")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning" && part.text === "must-not-adopt")).toBe(false)
  }),
)

distillationIt.instance("cancelling a synchronous continuation interrupts the organizer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const started = yield* Deferred.make<void>()
    let signal: AbortSignal | undefined
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: (abort) => () => {
          signal = abort
          Deferred.doneUnsafe(started, Effect.void)
          return new Promise(() => {})
        },
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think" }],
    })
    yield* llm.push(reply().reason(longThought("sync-cancel")).text("phase-one").stop())
    const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(started), "sync organizer did not start")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(loop)
    yield* pollWithTimeout(
      Effect.sync(() => signal?.aborted || undefined),
      "synchronous organizer was not cancelled",
    )
    expect((yield* (yield* SessionStatus.Service).get(chat.id)).type).toBe("idle")
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "text" && part.text === "phase-one")).toBe(false)
  }),
)

for (const mode of ["failure", "timeout"] as const) {
  const readiness =
    mode === "failure"
      ? Effect.die(new Error("tool readiness fixture failed"))
      : Effect.never.pipe(Effect.timeout("1 millis"), Effect.orDie)
  const failedPreparation = testEffect(makeHttp({ toolsReady: readiness }))
  failedPreparation.instance(`foreground preparation ${mode} returns to idle without starting a model`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      yield* user(chat.id, "prepare without sending")
      yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
      expect((yield* (yield* SessionStatus.Service).get(chat.id)).type).toBe("idle")
      expect(yield* llm.hits).toHaveLength(0)
    }),
  )
}

const thinkingPrefixMemory = ["Replay fixture memory before"]
const thinkingPrefixIt = testEffect(makeHttp({ memoryContext: thinkingPrefixMemory }))
const nativeThinkingPrefixIt = testEffect(makeHttp({ memoryContext: thinkingPrefixMemory, native: true }))

function thinkingPrefixReply(signature?: string, thinking = "") {
  return raw({
    chunks: [
      {
        type: "message_start",
        message: {
          id: "fixture",
          type: "message",
          role: "assistant",
          model: "claude-fable-5-1",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      ...(thinking ? [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }] : []),
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "fixture answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].filter((event) => signature !== undefined || !("index" in event && event.index === 0)),
  })
}

for (const output of ["thinking", "text-only"] as const)
  for (const [runtime, runner] of [
    ["sdk", thinkingPrefixIt],
    ["native", nativeThinkingPrefixIt],
  ] as const)
    runner.instance(
      `does not replay a signed block after real prompt memory changes its system prefix (${runtime}, ${output})`,
      () =>
        Effect.gen(function* () {
          const { llm } = yield* useServerConfig((url) => {
            const config = providerCfg(url)
            return {
              ...config,
              provider: {
                test: {
                  ...config.provider.test,
                  npm: "@ai-sdk/anthropic",
                  models: {
                    "test-model": {
                      ...config.provider.test.models["test-model"],
                      id: "claude-fable-5-1",
                      reasoning: true,
                    },
                  },
                },
              },
            }
          })
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "Signed replay prefix fixture" })
          yield* llm.push(thinkingPrefixReply("opaque-first-response"))
          const first = yield* prompt.prompt({
            sessionID: session.id,
            model: ref,
            parts: [{ type: "text", text: "first question" }],
          })
          if (first.info.role !== "assistant") throw new Error("Missing fixture assistant")
          expect(first.info.error).toBeUndefined()
          expect(
            first.parts.some(
              (part) => part.type === "reasoning" && part.metadata?.anthropic?.signature === "opaque-first-response",
            ),
          ).toBe(true)
          const saved = structuredClone(first.parts)
          yield* llm.push(thinkingPrefixReply("opaque-unchanged-response"))
          yield* prompt.prompt({
            sessionID: session.id,
            model: ref,
            parts: [{ type: "text", text: "unchanged followup" }],
          })
          const unchangedHits = (yield* llm.hits).filter(
            (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
          )
          expect(createHash("sha256").update(JSON.stringify(unchangedHits[1].body.system)).digest("hex")).toBe(
            createHash("sha256").update(JSON.stringify(unchangedHits[0].body.system)).digest("hex"),
          )
          expect(createHash("sha256").update(JSON.stringify(unchangedHits[1].body.tools)).digest("hex")).toBe(
            createHash("sha256").update(JSON.stringify(unchangedHits[0].body.tools)).digest("hex"),
          )
          const system = unchangedHits[0].body.system
          expect(Array.isArray(system)).toBe(true)
          if (!Array.isArray(system)) throw new Error("Missing Anthropic system blocks")
          for (const part of system) {
            if (!part || typeof part !== "object" || !("text" in part))
              throw new Error("Malformed Anthropic system block")
            expect(typeof part.text).toBe("string")
          }
          expect(JSON.stringify(unchangedHits[1].body.messages)).toContain("opaque-first-response")
          thinkingPrefixMemory[0] = "Replay fixture memory after"
          yield* llm.push(thinkingPrefixReply(output === "thinking" ? "opaque-second-response" : undefined))
          yield* prompt.prompt({
            sessionID: session.id,
            model: ref,
            parts: [{ type: "text", text: "second question" }],
          })
          const hits = (yield* llm.hits).filter(
            (hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"),
          )
          expect(hits).toHaveLength(3)
          expect(hits[2].body.system).not.toEqual(hits[0].body.system)
          expect(JSON.stringify(hits[2].body.messages)).not.toContain("opaque-first-response")
          expect(JSON.stringify(hits[2].body.messages)).not.toContain("opaque-unchanged-response")
          expect(JSON.stringify(hits.map((hit) => hit.body))).not.toContain("thinkingReplay")
          const stored = yield* sessions.messages({ sessionID: session.id })
          for (const part of saved)
            if (part.type === "reasoning") part.metadata!.opencode.thinkingReplay.invalidated = true
          expect(stored.find((message) => message.info.id === first.info.id)?.parts).toEqual(saved)
          const fork = yield* sessions.fork({ sessionID: session.id })
          const forked = yield* sessions.messages({ sessionID: fork.id })
          const forkedThinking = forked.flatMap((message) => message.parts).filter((part) => part.type === "reasoning")
          expect(
            forkedThinking.find((part) => part.metadata?.anthropic?.signature === "opaque-first-response")?.metadata
              ?.opencode?.thinkingReplay?.invalidated,
          ).toBe(true)
          thinkingPrefixMemory[0] = "Replay fixture memory before"
          yield* llm.push(thinkingPrefixReply("opaque-restored-response"))
          yield* prompt.prompt({
            sessionID: session.id,
            model: ref,
            parts: [{ type: "text", text: "restored question" }],
          })
          const restored = (yield* llm.hits).at(-1)!
          expect(JSON.stringify(restored.body.messages)).not.toContain("opaque-first-response")
          expect(JSON.stringify(restored.body.messages)).not.toContain("opaque-unchanged-response")
          expect(JSON.stringify(restored.body.messages)).not.toContain("opaque-second-response")
          yield* llm.push(thinkingPrefixReply("opaque-fresh-response"))
          yield* prompt.prompt({ sessionID: session.id, model: ref, parts: [{ type: "text", text: "fresh followup" }] })
          const fresh = (yield* llm.hits).at(-1)!
          expect(JSON.stringify(fresh.body.messages)).toContain("opaque-restored-response")
          expect(JSON.stringify(fresh.body.messages)).not.toContain("opaque-first-response")
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              thinkingPrefixMemory[0] = "Replay fixture memory before"
            }),
          ),
        ),
    )

for (const [runtime, runner] of [
  ["sdk", thinkingPrefixIt],
  ["native", nativeThinkingPrefixIt],
] as const)
  for (const interleaved of [false, true])
    runner.instance(
      `does not reinsert Claude thinking after a different provider SDK and back (${runtime}, ${interleaved ? "interleaved DeepSeek" : "plain"})`,
      () =>
        Effect.gen(function* () {
          const { llm } = yield* useServerConfig((url) => {
            const config = providerCfg(url)
            return {
              ...config,
              provider: {
                test: {
                  ...config.provider.test,
                  npm: "@ai-sdk/anthropic",
                  models: {
                    "test-model": {
                      ...config.provider.test.models["test-model"],
                      id: "claude-fable-5-1",
                      reasoning: true,
                    },
                  },
                },
                other: interleaved
                  ? {
                      ...config.provider.test,
                      models: {
                        "test-model": {
                          ...config.provider.test.models["test-model"],
                          id: "deepseek-r1",
                          interleaved: { field: "reasoning_content" as const },
                        },
                      },
                    }
                  : config.provider.test,
              },
            }
          })
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "Provider switch replay fixture" })
          yield* llm.push(thinkingPrefixReply("before-provider-switch"))
          const first = yield* prompt.prompt({
            sessionID: session.id,
            model: ref,
            parts: [{ type: "text", text: "fixture first" }],
          })
          yield* llm.push(reply().text("other answer").stop())
          const switched = yield* prompt.prompt({
            sessionID: session.id,
            model: { providerID: ProviderV2.ID.make("other"), modelID: ref.modelID },
            parts: [{ type: "text", text: "other provider" }],
          })
          if (switched.info.role !== "assistant") throw new Error("Missing switched assistant")
          expect(switched.info.error).toBeUndefined()
          expect((yield* llm.hits).at(-1)!.body.model).toBe(interleaved ? "deepseek-r1" : "test-model")
          expect(JSON.stringify((yield* llm.hits).at(-1)!.body.messages)).not.toContain("before-provider-switch")
          yield* llm.push(thinkingPrefixReply("after-provider-switch"))
          yield* prompt.prompt({ sessionID: session.id, model: ref, parts: [{ type: "text", text: "back to Claude" }] })
          expect(JSON.stringify((yield* llm.hits).at(-1)!.body.messages)).not.toContain("before-provider-switch")
          const stored = yield* sessions.messages({ sessionID: session.id })
          expect(
            stored.find((message) => message.info.id === first.info.id)?.parts.find((part) => part.type === "reasoning")
              ?.metadata?.opencode?.thinkingReplay?.invalidated,
          ).toBe(true)
          const expected = structuredClone(first.parts)
          for (const item of expected)
            if (item.type === "reasoning") item.metadata!.opencode.thinkingReplay.invalidated = true
          expect(stored.find((message) => message.info.id === first.info.id)?.parts).toEqual(expected)
          const wire = JSON.stringify((yield* llm.hits).map((hit) => hit.body))
          expect(wire).not.toContain("thinkingReplay")
          expect(wire).not.toContain("sourceOrigins")
          for (const item of first.parts.filter((part) => part.type === "reasoning")) {
            const id = item.metadata?.opencode?.thinkingReplay?.block
            if (typeof id !== "string") throw new Error("Missing fixture origin")
            expect(wire).not.toContain(id)
          }
        }),
    )

for (const change of ["tools", "history"] as const) {
  const tools: Record<string, AITool> = {}
  const runner = testEffect(makeHttp({ mcpTools: tools }))
  runner.instance(`invalidates signed replay after actual ${change} prefix changes`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => {
        const config = providerCfg(url)
        return {
          ...config,
          provider: {
            test: {
              ...config.provider.test,
              npm: "@ai-sdk/anthropic",
              models: {
                "test-model": { ...config.provider.test.models["test-model"], id: "claude-fable-5-1", reasoning: true },
              },
            },
          },
        }
      })
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Mutable prefix fixture" })
      yield* llm.push(thinkingPrefixReply("before-prefix-change"))
      yield* prompt.prompt({
        sessionID: session.id,
        model: ref,
        parts: [{ type: "text", text: "synthetic fixture question" }],
      })
      if (change === "tools")
        tools.fixture_extra = aiTool({
          description: "new synthetic tool",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => "unused",
        })
      else {
        const history = yield* sessions.messages({ sessionID: session.id })
        const part = history.find((message) => message.info.role === "user")?.parts.find((part) => part.type === "text")
        if (!part || part.type !== "text") throw new Error("Missing synthetic user fixture")
        yield* sessions.updatePart({ ...part, text: "edited synthetic fixture question" })
      }
      yield* llm.push(thinkingPrefixReply("after-prefix-change"))
      yield* prompt.prompt({ sessionID: session.id, model: ref, parts: [{ type: "text", text: "fixture followup" }] })
      const hits = yield* llm.hits
      expect(JSON.stringify(hits.at(-1)!.body.messages)).not.toContain("before-prefix-change")
      if (change === "tools") expect(hits.at(-1)!.body.tools).not.toEqual(hits[0].body.tools)
      const stored = yield* sessions.messages({ sessionID: session.id })
      expect(
        stored
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "reasoning")
          .find((part) => part.metadata?.anthropic?.signature === "before-prefix-change")?.metadata?.opencode
          ?.thinkingReplay?.invalidated,
      ).toBe(true)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete tools.fixture_extra
        }),
      ),
    ),
  )
}

for (const native of [false, true]) {
  const signedToolRoundIt = testEffect(
    makeHttp({
      native,
      mcpTools: {
        fixture_replay: aiTool({
          description: "Synthetic replay fixture",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ content: [{ type: "text" as const, text: "tool fixture answer" }] }),
        }),
      },
    }),
  )
  signedToolRoundIt.instance(
    `preserves signed thinking across an actual complete tool round (${native ? "native" : "sdk"})`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => {
          const config = providerCfg(url)
          return {
            ...config,
            provider: {
              test: {
                ...config.provider.test,
                npm: "@ai-sdk/anthropic",
                models: {
                  "test-model": {
                    ...config.provider.test.models["test-model"],
                    id: "claude-fable-5-1",
                    reasoning: true,
                  },
                },
              },
            },
          }
        })
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Signed tool round fixture" })
        yield* llm.push(
          raw({
            chunks: [
              {
                type: "message_start",
                message: {
                  id: "fixture",
                  type: "message",
                  role: "assistant",
                  model: "claude-fable-5-1",
                  content: [],
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature: "before-tool-signature" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "fixture-tool", name: "fixture_replay", input: {} },
              },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 1 },
              { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ],
          }),
        )
        yield* llm.push(thinkingPrefixReply("after-tool-signature"))
        const first = yield* prompt.prompt({
          sessionID: session.id,
          model: ref,
          parts: [{ type: "text", text: "synthetic tool round" }],
        })
        if (first.info.role !== "assistant") throw new Error("Missing final assistant")
        expect(first.info.error).toBeUndefined()
        const toolHistory = yield* sessions.messages({ sessionID: session.id })
        expect(completedTool(toolHistory.flatMap((message) => message.parts))?.state.output).toBe("tool fixture answer")
        yield* llm.push(thinkingPrefixReply("next-round-signature"))
        yield* prompt.prompt({
          sessionID: session.id,
          model: ref,
          parts: [{ type: "text", text: "same context followup" }],
        })
        const body = (yield* llm.hits).at(-1)!.body
        expect(JSON.stringify(body.messages)).toContain("before-tool-signature")
        expect(JSON.stringify(body.messages)).toContain("after-tool-signature")
      }),
  )
}

const wrapperReads: Array<Parameters<Session.Interface["messages"]>[0]> = []
const wrapperLookups: Array<{ event: string; sessionID?: string }> = []
const wrapperTriggers: string[] = []
const realWrapperHooks = Layer.effect(
  SettingsHook.Service,
  Effect.gen(function* () {
    const service = yield* SettingsHook.Service
    return SettingsHook.Service.of({
      ...service,
      hasEvent: (event, sessionID) =>
        Effect.suspend(() => {
          wrapperLookups.push({ event, sessionID })
          return service.hasEvent ? service.hasEvent(event, sessionID) : Effect.succeed(true)
        }),
      trigger: (payload, context) =>
        Effect.suspend(() => {
          wrapperTriggers.push(payload.event)
          return service.trigger(payload, context)
        }),
    })
  }),
).pipe(Layer.provide(SettingsHook.defaultLayer))
const wrapperIt = testEffect(
  makeHttp({ settingsHookLayer: realWrapperHooks, observeMessages: (input) => wrapperReads.push(input) }),
)
const wrapperUnix = process.platform !== "win32" ? wrapperIt.instance : wrapperIt.instance.skip

wrapperUnix(
  "SessionPrompt wrapper without hooks calls trigger without a full history read or transcript snapshot",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "no-hook wrapper" })
      const file = path.join(
        Global.Path.data,
        "hooks",
        "transcripts",
        createHash("sha256").update(chat.id).digest("hex") + ".jsonl",
      )
      wrapperReads.length = 0
      wrapperTriggers.length = 0
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "No hook IO" }],
      })
      expect(wrapperTriggers).toContain("UserPromptSubmit")
      expect(wrapperReads.filter((read) => read.sessionID === chat.id && read.limit === undefined)).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    }),
)

wrapperUnix("SessionPrompt wrapper command receives truthful JSONL and exported/unset session environment", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const instance = yield* TestInstance
    const script = path.join(instance.directory, "wrapper-hook.ts")
    const audit = path.join(instance.directory, "wrapper-audit.json")
    yield* writeText(
      script,
      `const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},JSON.stringify({input,value:process.env.PROMPT_WRAPPER_VALUE,removed:!("PROMPT_WRAPPER_REMOVE" in process.env)}))`,
    )
    yield* writeText(
      path.join(instance.directory, ".opencode/hooks.json"),
      JSON.stringify({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
      }),
    )
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const chat = yield* sessions.create({ title: "hook wrapper context" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "WRAPPER_PRIOR_USER" }],
    })
    const file = yield* HookTranscript.environmentFile(chat.id)
    yield* writeText(file, "export PROMPT_WRAPPER_VALUE=SESSION_EXPORT\nunset PROMPT_WRAPPER_REMOVE\n")
    const previous = process.env.PROMPT_WRAPPER_REMOVE
    process.env.PROMPT_WRAPPER_REMOVE = "HOST_BASELINE"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.PROMPT_WRAPPER_REMOVE
        else process.env.PROMPT_WRAPPER_REMOVE = previous
      }),
    )
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "WRAPPER_NEXT_USER" }],
    })
    const result = decodeRecord(JSON.parse(yield* Effect.promise(() => Bun.file(audit).text())))
    expect(result).toMatchObject({ value: "SESSION_EXPORT", removed: true })
    const input = decodeRecord(result.input)
    const rows = (yield* Effect.promise(() => Bun.file(decodeString(input.transcript_path)).text()))
      .trim()
      .split("\n")
      .map((line) => decodeRecord(JSON.parse(line)))
    expect(rows.some((row) => row.type === "user" && JSON.stringify(row.message).includes("WRAPPER_PRIOR_USER"))).toBe(
      true,
    )
    expect(rows.every((row) => row.sessionId === chat.id)).toBe(true)
  }),
)

wrapperUnix("SessionPrompt wrapper materializes parent context for child-scoped SubagentStop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const instance = yield* TestInstance
    const script = path.join(instance.directory, "child-stop-hook.ts")
    const audit = path.join(instance.directory, "child-stop-audit.json")
    yield* writeText(script, `await Bun.write(${JSON.stringify(audit)},await Bun.stdin.text())`)
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const hooks = yield* SettingsHook.Service
    const parent = yield* sessions.create({ title: "child hook owner" })
    const child = yield* sessions.create({ parentID: parent.id, title: "scoped child" })
    if (!hooks.registerScoped || !hooks.hasEvent) throw new Error("production hook service lacks scoped registration")
    yield* hooks.registerScoped(child.id, {
      kind: "agent",
      origin: script,
      source: "builtin",
      child: true,
      hooks: { Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] },
    })
    expect(yield* hooks.hasEvent("SubagentStop", parent.id)).toBe(false)
    expect(yield* hooks.hasEvent("SubagentStop", child.id)).toBe(true)
    wrapperLookups.length = 0
    yield* llm.text("SCOPED_CHILD_DONE")
    yield* prompt.prompt({ sessionID: child.id, agent: "build", parts: [{ type: "text", text: "Finish the child" }] })
    const result = decodeRecord(JSON.parse(yield* Effect.promise(() => Bun.file(audit).text())))
    expect(result.agent_id).toBe(child.id)
    expect(wrapperLookups).toContainEqual({ event: "SubagentStop", sessionID: child.id })
    expect(decodeString(result.transcript_path).length).toBeGreaterThan(0)
    expect(yield* Effect.promise(() => Bun.file(decodeString(result.transcript_path)).exists())).toBe(true)
    const rows = (yield* Effect.promise(() => Bun.file(decodeString(result.agent_transcript_path)).text()))
      .trim()
      .split("\n")
      .map((line) => decodeRecord(JSON.parse(line)))
    expect(rows.some((row) => JSON.stringify(row.message).includes("SCOPED_CHILD_DONE"))).toBe(true)
  }),
)

wrapperUnix(
  "SessionPrompt wrapper full child completion without hooks creates neither parent nor child snapshots",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const parent = yield* sessions.create({ title: "no-hook parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "no-hook child" })
      wrapperTriggers.length = 0
      wrapperReads.length = 0
      yield* llm.text("NO_HOOK_CHILD_COMPLETED")
      const result = yield* prompt.prompt({
        sessionID: child.id,
        agent: "build",
        parts: [{ type: "text", text: "Complete without hooks" }],
      })
      expect(result.parts.some((part) => part.type === "text" && part.text === "NO_HOOK_CHILD_COMPLETED")).toBe(true)
      expect(wrapperTriggers).toContain("SubagentStop")
      expect(wrapperReads.filter((read) => read.sessionID === parent.id && read.limit === undefined)).toEqual([])
      for (const id of [parent.id, child.id]) {
        const snapshot = path.join(
          Global.Path.data,
          "hooks",
          "transcripts",
          createHash("sha256").update(id).digest("hex") + ".jsonl",
        )
        expect(yield* Effect.promise(() => Bun.file(snapshot).exists())).toBe(false)
      }
    }),
)

unix("SessionPrompt wrapper keeps transcript compatibility when a legacy hook service has no hasEvent", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const hooks = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    expect(hooks.hasEvent).toBeUndefined()
    const chat = yield* sessions.create({ title: "legacy hook interface" })
    const before = hookRecorded.length
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Legacy hook adapter" }],
    })
    expect(hookRecorded.slice(before).some((payload) => payload.event === "UserPromptSubmit")).toBe(true)
    const snapshot = path.join(
      Global.Path.data,
      "hooks",
      "transcripts",
      createHash("sha256").update(chat.id).digest("hex") + ".jsonl",
    )
    expect(yield* Effect.promise(() => Bun.file(snapshot).exists())).toBe(true)
  }),
)

distillationIt.instance("measures the context from the continuation request, not the split total", () =>
  Effect.gen(function* () {
    // Phase one's cut request is charged to the message for cost reporting, so the persisted tokens
    // accumulate two requests while the context only carries the continuation's prompt. The limit below
    // sits between them: the accumulated total would compact, the continuation's usage must not.
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      reasoningDistillation: { enabled: true },
      compaction: { auto: true, max_context_tokens: 12_000, tail_turns: 1 },
    }))
    const { prompt, sessions, chat } = yield* boot()
    controlledOrganizer = () =>
      Effect.succeed({
        transport: "engine" as const,
        model: "test/small",
        call: () => async () => ({ text: "adopted", finishReason: "stop" }),
      })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "think carefully" }],
    })
    yield* llm.push(
      reply().reason(longThought("step-1")).stop(),
      reply().text("final-answer").usage({ input: 7_000, output: 10 }).stop(),
    )
    yield* prompt.loop({ sessionID: chat.id })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "second turn" }],
    })
    yield* llm.push(reply().text("compaction summary").stop(), reply().text("second answer").stop())
    yield* prompt.loop({ sessionID: chat.id })
    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.some((part) => part.type === "compaction")).toBe(false)
  }),
)
