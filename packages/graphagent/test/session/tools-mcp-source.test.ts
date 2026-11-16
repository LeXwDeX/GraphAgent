// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never`.
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { describe, expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { builtinEntry, mcpEntries } from "../fixture/tool-registry"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * #1324 P2: under the `ask` tier an unattended session hands its edit, bash and
 * MCP calls to the user. A request cannot tell an MCP tool from a built-in by
 * its key, so `SessionTools` marks the requests of MCP server tools with
 * `metadata.source: "mcp"` and the permission evaluation trusts that mark only.
 */

const config: { tier: "allow" | "ask" | "readonly" | undefined } = { tier: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const configLayer = TestConfig.layer({
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})

let mcpRuns = 0
const makeMcp = (name: string, requiresUserInteraction?: boolean) =>
  McpCatalog.bindTool(
    tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        mcpRuns++
        return { content: [{ type: "text" as const, text: "MCP_RAN" }] }
      },
    }),
    { server: "srv", tool: name, source: "unknown", ...(requiresUserInteraction ? { requiresUserInteraction } : {}) },
  )
// `resolve` wraps server tools in place, so each case needs fresh instances.
let mcpTools: Record<string, ReturnType<typeof makeMcp>> = {}

const bashDefinition = {
  id: "bash",
  description: "Fixture shell that asks for its own command",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (args: { command: string }, ctx: Tool.Context) =>
    ctx
      .ask({ permission: "bash", patterns: [args.command], always: ["echo *"], metadata: { command: args.command } })
      .pipe(Effect.as({ title: "ran", output: `BASH_RAN ${args.command}`, metadata: {} })),
}
const readDefinition = {
  id: "read",
  description: "Fixture reader that asks for the file it reads",
  parameters: Schema.Struct({ filePath: Schema.String }),
  execute: (args: { filePath: string }, ctx: Tool.Context) =>
    ctx
      .ask({ permission: "read", patterns: [args.filePath], always: ["*"], metadata: {} })
      .pipe(Effect.as({ title: "read", output: `READ_RAN ${args.filePath}`, metadata: {} })),
}
// The `agent` tool never asks: a node talks to its owning parent through it.
const agentDefinition = {
  id: "agent",
  description: "Fixture agent tool that never asks",
  parameters: Schema.Struct({ message: Schema.String }),
  execute: (args: { message: string }) =>
    Effect.succeed({ title: "sent", output: `AGENT_RAN ${args.message}`, metadata: {} }),
}
const definitions = [bashDefinition, readDefinition, agentDefinition]

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(configLayer),
    ),
    database,
    events,
    bridge,
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.sync(() => mcpTools) }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed(definitions),
      resolve: () =>
        Effect.sync(() => [...definitions.map((definition) => builtinEntry(definition)), ...mcpEntries(mcpTools)]),
    }),
  ),
)

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" as const }]

type Tools = Record<string, { execute: (args: unknown, options: unknown) => Promise<{ output?: string }> }>

/** The tools of one session as the model's runtime would run them, wrapped by the real pipeline. */
const resolveTools = (sessionID: SessionID, rules: ReadonlyArray<(typeof ALLOW_ALL)[number]> = ALLOW_ALL) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    mcpRuns = 0
    mcpTools = { srv_lookup: makeMcp("lookup"), srv_guarded: makeMcp("guarded", true) }
    return (yield* SessionTools.resolve({
      agent: { name: "general", permission: rules, options: {} } as never,
      model: ProviderTest.model(),
      session: { id: sessionID, directory: instance.directory, permission: [] } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })) as unknown as Tools
  })

const start = (tools: Tools, name: string, args: unknown = {}) =>
  Effect.tryPromise(() =>
    tools[name].execute(args, {
      toolCallId: `call-${name}`,
      messages: [],
      abortSignal: new AbortController().signal,
    }),
  ).pipe(Effect.forkScoped)

/** Registers a DAG node run for the session, so its asks are the unattended kind. */
const asNode = (sessionID: SessionID) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const owner = { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_${sessionID}`,
        childSessionID: sessionID,
        parentSessionID: SessionID.make("ses_tools_mcp_source_root"),
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

const pendingRequest = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* pollWithTimeout(permission.list().pipe(Effect.map((list) => list[0])), "the call did not ask the user")
})

const withTier = <A, E, R>(tier: typeof config.tier, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      config.tier = tier
    }),
    () => body,
    () =>
      Effect.sync(() => {
        config.tier = undefined
      }),
  )

describe("MCP source mark and the ask tier (#1324)", () => {
  it.instance("an MCP server tool's request carries metadata.source mcp; a built-in tool's does not", () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const id = SessionID.descending()
        yield* asNode(id)
        const tools = yield* resolveTools(id)

        const mcp = yield* start(tools, "srv_lookup")
        const mcpRequest = yield* pendingRequest
        expect(mcpRequest.permission).toBe("srv_lookup")
        expect(mcpRequest.sessionID).toBe(id)
        expect(mcpRequest.metadata).toEqual({ source: "mcp" })
        expect(mcpRuns).toBe(0)
        yield* permission.reply({ requestID: mcpRequest.id, reply: "once" })
        expect(Exit.isSuccess(yield* Fiber.await(mcp))).toBe(true)
        expect(mcpRuns).toBe(1)

        const shell = yield* start(tools, "bash", { command: "echo hi" })
        const bashRequest = yield* pendingRequest
        expect(bashRequest.permission).toBe("bash")
        expect(bashRequest.sessionID).toBe(id)
        expect(bashRequest.metadata).toEqual({ command: "echo hi" })
        yield* permission.reply({ requestID: bashRequest.id, reply: "once" })
        expect(Exit.isSuccess(yield* Fiber.await(shell))).toBe(true)
      }),
    ),
  )

  it.instance("an MCP tool that requires user interaction keeps its own metadata beside the mark", () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const id = SessionID.descending()
        yield* asNode(id)
        const tools = yield* resolveTools(id)

        const guarded = yield* start(tools, "srv_guarded")
        const request = yield* pendingRequest
        expect(request.metadata).toEqual({
          requiresUserInteraction: true,
          mcpServer: "srv",
          mcpTool: "guarded",
          source: "mcp",
        })
        yield* permission.reply({ requestID: request.id, reply: "once" })
        expect(Exit.isSuccess(yield* Fiber.await(guarded))).toBe(true)
      }),
    ),
  )

  it.instance(
    "an allow the user wrote for exactly this MCP tool frees its call; a server wildcard allow does not",
    () =>
      withTier(
        "ask",
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const id = SessionID.descending()
          yield* asNode(id)

          // The agent's rules carry the user's allow for this one tool after the default.
          const exact = yield* resolveTools(id, [
            ...ALLOW_ALL,
            { permission: "srv_lookup", pattern: "*", action: "allow" },
          ])
          const freed = yield* Effect.tryPromise(() =>
            exact.srv_lookup.execute(
              {},
              { toolCallId: "call-exact", messages: [], abortSignal: new AbortController().signal },
            ),
          )
          expect(freed.output).toContain("MCP_RAN")
          expect(yield* permission.list()).toEqual([])

          // A server-wide wildcard names more than this tool: the call waits for the user again.
          const wildcard = yield* resolveTools(id, [
            ...ALLOW_ALL,
            { permission: "srv_*", pattern: "*", action: "allow" },
          ])
          const call = yield* start(wildcard, "srv_lookup")
          const request = yield* pendingRequest
          expect(request.permission).toBe("srv_lookup")
          expect(mcpRuns).toBe(0)
          yield* permission.reply({ requestID: request.id, reply: "once" })
          expect(Exit.isSuccess(yield* Fiber.await(call))).toBe(true)
          expect(mcpRuns).toBe(1)
        }),
      ),
  )

  it.instance("read, the agent tool and every call under the default tier run without a question", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const id = SessionID.descending()
      yield* asNode(id)
      const tools = yield* resolveTools(id)

      yield* withTier(
        "ask",
        Effect.gen(function* () {
          const read = yield* Effect.tryPromise(() =>
            tools.read.execute(
              { filePath: "src/a.ts" },
              { toolCallId: "call-read", messages: [], abortSignal: new AbortController().signal },
            ),
          )
          expect(read.output).toContain("READ_RAN src/a.ts")
          const agent = yield* Effect.tryPromise(() =>
            tools.agent.execute(
              { message: "hello" },
              { toolCallId: "call-agent", messages: [], abortSignal: new AbortController().signal },
            ),
          )
          expect(agent.output).toContain("AGENT_RAN hello")
          expect(yield* permission.list()).toEqual([])
        }),
      )

      // Under the default tier the node's MCP and shell calls are settled by the safety list.
      yield* withTier(
        undefined,
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise(() =>
            tools.srv_lookup.execute(
              {},
              { toolCallId: "call-mcp", messages: [], abortSignal: new AbortController().signal },
            ),
          )
          expect(result.output).toContain("MCP_RAN")
          const shell = yield* Effect.tryPromise(() =>
            tools.bash.execute(
              { command: "echo hi" },
              { toolCallId: "call-bash", messages: [], abortSignal: new AbortController().signal },
            ),
          )
          expect(shell.output).toContain("BASH_RAN echo hi")
          expect(yield* permission.list()).toEqual([])
        }),
      )
    }),
  )

  it.instance("a session that is not an unattended run is never asked, whatever the tier", () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        // No child run is registered: an ordinary session whose agent allows everything.
        const id = SessionID.descending()
        const tools = yield* resolveTools(id)
        const result = yield* Effect.tryPromise(() =>
          tools.srv_lookup.execute(
            {},
            { toolCallId: "call-mcp", messages: [], abortSignal: new AbortController().signal },
          ),
        )
        expect(result.output).toContain("MCP_RAN")
        expect(yield* permission.list()).toEqual([])
      }),
    ),
  )
})
