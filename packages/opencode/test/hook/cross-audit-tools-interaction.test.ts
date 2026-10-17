import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { jsonSchema, tool } from "ai"
import { SessionTools } from "@/session/tools"
import { SessionHooks } from "@/hook/session-hooks"
import { SettingsHook } from "@/hook/settings"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { hookCommand } from "../fixture/claude-hook"

// A server-provided tool marked `_meta["anthropic/requiresUserInteraction"] === true` always needs a real
// human confirmation. Only an explicit deny (or dontAsk) may settle it without one.

const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
let executions = 0
const make = (requiresUserInteraction: boolean | undefined, name: string) =>
  McpCatalog.bindTool(
    tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        executions++
        return { content: [{ type: "text" as const, text: "MCP_RAN" }] }
      },
    }),
    {
      server: "fixture",
      tool: name,
      source: "unknown",
      ...(requiresUserInteraction === undefined ? {} : { requiresUserInteraction }),
    },
  )
// resolve() wraps server tools in place, so every test needs fresh instances.
let mcpTools: Record<string, ReturnType<typeof make>> = {}
const freshTools = () => ({
  fixture_guarded: make(true, "guarded"),
  fixture_plain: make(undefined, "plain"),
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  fixture_string_true: make("true" as unknown as boolean, "string_true"),
})
const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed(mcpTools) }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
    Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]), registrations: () => Effect.succeed([]) }),
  ),
)

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" as const }]
const setup = (rules: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[] = ALLOW_ALL) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const id = SessionID.descending()
    executions = 0
    mcpTools = freshTools()
    const tools = yield* SessionTools.resolve({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      agent: { name: "build", permission: rules, options: {} } as any,
      model: ProviderTest.model(),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      session: { id, directory: instance.directory, permission: [] } as any,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      processor: {
        message: { id: MessageID.ascending(), sessionID: id },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as any,
      bypassAgentCheck: false,
      messages: [],
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      promptOps: {} as any,
    })
    return { tools: tools as Record<string, any>, id }
  })
const start = (tools: Record<string, any>, name: string, callID = `call-${name}`) =>
  Effect.tryPromise(() =>
    tools[name].execute({}, { toolCallId: callID, messages: [], abortSignal: new AbortController().signal }),
  ).pipe(Effect.forkScoped)
const pending = (message: string) =>
  Permission.Service.use((permission) =>
    pollWithTimeout(permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))), message),
  )

describe("MCP tools that require user interaction", () => {
  it.instance("a configured allow still surfaces a forced dialog that carries the metadata and no always", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup()
      const fiber = yield* start(tools, "fixture_guarded")
      const [request] = yield* pending("requiresUserInteraction tool did not ask")
      expect(request.metadata).toMatchObject({ requiresUserInteraction: true })
      expect(request.always).toEqual([])
      expect(executions).toBe(0)
      yield* Permission.Service.use((permission) => permission.reply({ requestID: request.id, reply: "once" }))
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      expect(executions).toBe(1)
    }),
  )

  it.instance("a hook allow does not replace the user's confirmation", () =>
    Effect.gen(function* () {
      const { tools, id } = yield* setup()
      yield* (yield* SessionHooks.Service).add(id, {
        event: "PreToolUse",
        hooks: [
          {
            type: "command",
            command: hookCommand(
              `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}))`,
            ),
          },
        ],
      })
      yield* (yield* SessionHooks.Service).add(id, {
        event: "PermissionRequest",
        hooks: [
          {
            type: "command",
            command: hookCommand(
              `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}))`,
            ),
          },
        ],
      })
      const fiber = yield* start(tools, "fixture_guarded")
      const [request] = yield* pending("hook allow replaced the required confirmation")
      expect(executions).toBe(0)
      yield* Permission.Service.use((permission) => permission.reply({ requestID: request.id, reply: "once" }))
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    }),
  )

  it.instance("an always reply is not remembered for the next call", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup()
      const first = yield* start(tools, "fixture_guarded", "first")
      const [firstRequest] = yield* pending("first call did not ask")
      yield* Permission.Service.use((permission) => permission.reply({ requestID: firstRequest.id, reply: "always" }))
      yield* Fiber.await(first)
      const second = yield* start(tools, "fixture_guarded", "second")
      const [secondRequest] = yield* pending("second call used the earlier always approval")
      expect(secondRequest.id).not.toBe(firstRequest.id)
      yield* Permission.Service.use((permission) => permission.reply({ requestID: secondRequest.id, reply: "reject" }))
      yield* Fiber.await(second)
    }),
  )

  it.instance("a host-authorized bypass does not replace the user's confirmation", () =>
    Effect.gen(function* () {
      const { tools, id } = yield* setup()
      const permission = yield* Permission.Service
      yield* permission.grantHookBypass!(id)
      yield* permission.applyHookUpdates(id, [{ type: "setMode", mode: "bypassPermissions", destination: "session" }])
      expect((yield* permission.hookPolicy(id)).mode).toBe("bypassPermissions")
      const fiber = yield* start(tools, "fixture_guarded")
      const [request] = yield* pending("bypass replaced the required confirmation")
      expect(executions).toBe(0)
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    }),
  )

  it.instance("dontAsk still denies without running the tool", () =>
    Effect.gen(function* () {
      const { tools, id } = yield* setup()
      yield* Permission.Service.use((permission) =>
        permission.applyHookUpdates(id, [{ type: "setMode", mode: "dontAsk", destination: "session" }]),
      )
      const exit = yield* Effect.tryPromise(() =>
        tools.fixture_guarded.execute(
          {},
          { toolCallId: "dont-ask", messages: [], abortSignal: new AbortController().signal },
        ),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(executions).toBe(0)
    }),
  )

  it.instance("an explicit deny still denies without a dialog", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup([{ permission: "fixture_guarded", pattern: "*", action: "deny" }])
      const exit = yield* Effect.tryPromise(() =>
        tools.fixture_guarded.execute(
          {},
          { toolCallId: "deny", messages: [], abortSignal: new AbortController().signal },
        ),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(executions).toBe(0)
      expect(yield* Permission.Service.use((permission) => permission.list())).toEqual([])
    }),
  )

  it.instance("an unmarked tool and a non-boolean marker keep the normal configured allow", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup()
      for (const name of ["fixture_plain", "fixture_string_true"]) {
        const result = yield* Effect.tryPromise(() =>
          tools[name].execute({}, { toolCallId: name, messages: [], abortSignal: new AbortController().signal }),
        )
        expect(JSON.stringify(result)).toContain("MCP_RAN")
      }
      expect(yield* Permission.Service.use((permission) => permission.list())).toEqual([])
    }),
  )
})
