import { describe, expect } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Memory } from "@/memory/memory"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { MemorySearch } from "@/tool/memory-search"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
const memoryParameters = Schema.Struct({ query: Schema.String })
const memoryDefinition: Tool.Def<typeof memoryParameters> = {
  id: "memory_search",
  description: "memory search",
  parameters: memoryParameters,
  execute: () => Effect.succeed({ title: "memory", output: "attached", metadata: {} }),
}
const trigger: Plugin.Interface["trigger"] = (_name, _input, output) => Effect.succeed(output)
const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger,
    contextFoldingCompatibility: () =>
      Effect.succeed({ knownExternalDcp: "unknown", migrationNotice: "not-applicable" }),
  }),
)
const resolveIt = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Truncate.defaultLayer,
    pluginLayer,
    Layer.mock(Permission.Service, { ask: () => Effect.void }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([memoryDefinition]),
      registrations: () =>
        Effect.succeed([
          { definition: memoryDefinition, sourceKind: "host-builtin", registrationID: "test:memory_search" },
        ]),
    }),
  ),
)

describe("tool.memory_search", () => {
  it.instance("trims one natural-language query and persists only an attachment acknowledgement", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const info = yield* MemorySearch.MemorySearchTool
      const tool = yield* info.init()
      const sessionID = SessionID.make("ses_memory_search_tool")
      const result = yield* tool.execute({ query: "  architecture   context  " }, context(sessionID)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Memory.Service, {
              search: (input) =>
                Effect.sync(() => {
                  calls.push(input.query)
                  return { status: "attached" as const, count: 1, reused: false }
                }),
            }),
            Layer.mock(Session.Service, {
              get: () => Effect.succeed(session(sessionID)),
            }),
          ),
        ),
      )

      expect(calls).toEqual(["architecture context"])
      expect(result.output).toBe("Attached 1 memory topic to the current turn")
      expect(result.output).not.toContain("architecture")
      expect(result.output).not.toContain(".yaml")
      expect(result.output).not.toContain("/")
    }),
  )

  resolveIt.instance("resolves memory_search for a root session but not for a child session", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const sessionID = SessionID.make("ses_memory_tool_root")

      const root = yield* resolvedToolIDs(build, session(sessionID))
      const child = yield* resolvedToolIDs(build, session(SessionID.make("ses_memory_tool_child"), sessionID))

      expect(root).toContain("memory_search")
      expect(child).not.toContain("memory_search")
    }),
  )

  resolveIt.instance("respects agent and session denial while resolving memory_search", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const deny = { permission: "memory_search", pattern: "*", action: "deny" as const }
      const sessionID = SessionID.make("ses_memory_tool_denied")

      expect(
        yield* resolvedToolIDs({ ...build, permission: [...build.permission, deny] }, session(sessionID)),
      ).not.toContain("memory_search")
      expect(yield* resolvedToolIDs(build, { ...session(sessionID), permission: [deny] })).not.toContain(
        "memory_search",
      )
    }),
  )

  it.instance("rejects an empty query before retrieval", () =>
    Effect.gen(function* () {
      const info = yield* MemorySearch.MemorySearchTool
      const tool = yield* info.init()
      const exit = yield* tool
        .execute({ query: "   " }, context(SessionID.make("ses_memory_empty_query")))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("blocks retrieval at execution time when invoked for a child session", () =>
    Effect.gen(function* () {
      const state = { calls: 0 }
      const info = yield* MemorySearch.MemorySearchTool
      const tool = yield* info.init()
      const parentID = SessionID.make("ses_memory_parent_guard")
      const childID = SessionID.make("ses_memory_child_guard")
      const result = yield* tool.execute({ query: "architecture context" }, context(childID)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Memory.Service, {
              search: () =>
                Effect.sync(() => {
                  state.calls++
                  return { status: "attached" as const, count: 1, reused: false }
                }),
            }),
            Layer.mock(Session.Service, {
              get: () => Effect.succeed(session(childID, parentID)),
            }),
          ),
        ),
      )

      expect(state.calls).toBe(0)
      expect(result.output).toBe("Memory search is unavailable for this session")
    }),
  )
})

function resolvedToolIDs(agent: Agent.Info, info: Session.Info) {
  const userID = MessageID.make(`msg_${info.id}`)
  const processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> = {
    message: {
      id: MessageID.make(`msg_assistant_${info.id}`),
      role: "assistant",
      sessionID: info.id,
      parentID: userID,
      mode: agent.name,
      agent: agent.name,
      path: { cwd: info.directory, root: info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    },
    updateToolCall: () => Effect.succeed(undefined),
    completeToolCall: () => Effect.void,
  }
  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.die(new Error("prompt should not run while resolving tools")),
  }
  return SessionTools.resolve({
    agent,
    model: ProviderTest.model({
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    }),
    session: info,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps,
  }).pipe(Effect.map((tools) => Object.keys(tools)))
}

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_memory_search_tool"),
    callID: "call_memory_search_tool",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function session(id: SessionID, parentID?: SessionID): Session.Info {
  return {
    id,
    slug: "memory-search-tool",
    projectID: ProjectV2.ID.global,
    directory: "/tmp/opencode",
    parentID,
    title: "Memory search tool",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  }
}
