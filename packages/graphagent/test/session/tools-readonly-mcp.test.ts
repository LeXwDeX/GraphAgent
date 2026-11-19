// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never`.
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { mcpEntries } from "../fixture/tool-registry"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * #1454: the MCP tools that declare `readOnlyHint` can be called by the read-only built-in subagents. The grant is
 * made where the call is judged (`SessionTools`' ask), on top of the agent's own rules: a deny the user wrote still
 * refuses the call, and for an unattended run the `ask` and `readonly` tiers of `dag.permission` do not take the
 * grant for an allow the user wrote.
 */

const config: { tier: "allow" | "ask" | "readonly" | undefined } = { tier: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const configLayer = TestConfig.layer({
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})

let mcpRuns = 0
const makeMcp = (name: string, options: { readOnly?: boolean; baseKey?: string } = {}) =>
  McpCatalog.bindTool(
    tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        mcpRuns++
        return { content: [{ type: "text" as const, text: "MCP_RAN" }] }
      },
    }),
    {
      server: "srv",
      tool: name,
      source: "unknown",
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(options.baseKey === undefined ? {} : { baseKey: options.baseKey }),
    },
  )
// `resolve` wraps server tools in place, so each case needs fresh instances.
let mcpTools: Record<string, ReturnType<typeof makeMcp>> = {}

// The rules of an explore-shaped agent: everything is denied but what is listed; the user's rules follow them.
const NATIVE = Permission.fromConfig({ "*": "deny", read: "allow" })
let userRules: PermissionV1.Rule[] = []

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
      tools: () => Effect.succeed([]),
      resolve: () => Effect.sync(() => mcpEntries(mcpTools)),
    }),
    Layer.mock(Agent.Service, {
      // What `Agent.permissionPolicy` returns for an agent: its native rules, then the user's, and which are the user's.
      permissionPolicy: () =>
        Effect.sync(() => ({
          native: NATIVE,
          rules: [...NATIVE, ...userRules],
          userRuleIndices: userRules.map((_, index) => NATIVE.length + index),
        })),
    }),
  ),
)

type Tools = Record<string, { execute: (args: unknown, options: unknown) => Promise<{ output?: string }> }>

const rule = (permission: string, action: PermissionV1.Rule["action"]): PermissionV1.Rule => ({
  permission,
  pattern: "*",
  action,
})

// `srv_call_1a2b3c4d` is a key that was rewritten: the tool was `srv_call` before (#1459).
const REWRITTEN = "srv_call_1a2b3c4d"

/** The tools of one session as the model's runtime would run them, for an agent of `agent`'s shape and the user's rules. */
const resolveTools = (
  sessionID: SessionID,
  user: PermissionV1.Rule[] = [],
  agent: { native?: boolean; mode?: "subagent" | "primary" } = {},
) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    mcpRuns = 0
    userRules = user
    mcpTools = {
      srv_lookup: makeMcp("lookup", { readOnly: true }),
      srv_other: makeMcp("other", { readOnly: true }),
      srv_update: makeMcp("update"),
      [REWRITTEN]: makeMcp("call", { readOnly: true, baseKey: "srv_call" }),
    }
    return (yield* SessionTools.resolve({
      agent: {
        name: "explore",
        native: agent.native ?? true,
        mode: agent.mode ?? "subagent",
        permission: [...NATIVE, ...user],
        options: {},
      } as never,
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

const options = (name: string) => ({
  toolCallId: `call-${name}`,
  messages: [],
  abortSignal: new AbortController().signal,
})

/** What one call of a tool comes to: its output, or the message of the error the pipeline rejects with. */
const settle = (tools: Tools, name: string) =>
  Effect.promise(() =>
    tools[name].execute({}, options(name)).then(
      (value) => ({ ok: true as const, output: value.output ?? "" }),
      (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    ),
  )

const start = (tools: Tools, name: string) =>
  Effect.tryPromise(() => tools[name].execute({}, options(name))).pipe(Effect.forkScoped)

/** Registers a DAG node run for the session, so its asks are the unattended kind. */
const asNode = (sessionID: SessionID) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const owner = { kind: "dag_node" as const, workflowID: "dag_unused", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_${sessionID}`,
        childSessionID: sessionID,
        parentSessionID: SessionID.make("ses_tools_readonly_mcp_root"),
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

describe("a read-only MCP tool and the agents that may call it (#1454)", () => {
  it.instance("a tool that declares readOnlyHint runs without a question; one that does not is refused", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(SessionID.descending())

      const lookup = yield* settle(tools, "srv_lookup")
      expect(lookup.ok).toBe(true)
      expect(lookup.ok ? lookup.output : "").toContain("MCP_RAN")
      expect(mcpRuns).toBe(1)
      expect(yield* permission.list()).toEqual([])

      const update = yield* settle(tools, "srv_update")
      expect(update.ok).toBe(false)
      expect(update.ok ? "" : update.message).toContain("prevents you from using this specific tool call")
      // The refused call ran nothing and asked nothing.
      expect(mcpRuns).toBe(1)
      expect(yield* permission.list()).toEqual([])
    }),
  )

  it.instance("a deny the user wrote refuses the call; a read-only tool it does not name still runs", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools(SessionID.descending(), [rule("srv_lookup", "deny")])

      const refused = yield* settle(tools, "srv_lookup")
      expect(refused.ok).toBe(false)
      expect(refused.ok ? "" : refused.message).toContain("prevents you from using this specific tool call")
      expect(mcpRuns).toBe(0)

      expect((yield* settle(tools, "srv_other")).ok).toBe(true)
      expect(mcpRuns).toBe(1)

      // A deny for the whole server closes every one of its tools.
      const server = yield* resolveTools(SessionID.descending(), [rule("srv_*", "deny")])
      for (const name of ["srv_lookup", "srv_other", REWRITTEN])
        expect((yield* settle(server, name)).ok, name).toBe(false)
      expect(mcpRuns).toBe(0)
    }),
  )

  it.instance("a rewritten key is called as before, and a deny written for the key it had refuses it", () =>
    Effect.gen(function* () {
      const open = yield* resolveTools(SessionID.descending())
      expect((yield* settle(open, REWRITTEN)).ok).toBe(true)
      expect(mcpRuns).toBe(1)

      const denied = yield* resolveTools(SessionID.descending(), [rule("srv_call", "deny")])
      expect((yield* settle(denied, REWRITTEN)).ok).toBe(false)
      expect(mcpRuns).toBe(0)
      // The tools whose keys never changed are not touched by that rule.
      expect((yield* settle(denied, "srv_lookup")).ok).toBe(true)
    }),
  )

  it.instance("an agent that is not one of the read-only built-ins is not given the grant", () =>
    Effect.gen(function* () {
      // Same rules, but a custom agent, and a primary one: the native deny stays.
      for (const agent of [{ native: false }, { mode: "primary" as const }]) {
        const tools = yield* resolveTools(SessionID.descending(), [], agent)
        const refused = yield* settle(tools, "srv_lookup")
        expect(refused.ok, JSON.stringify(agent)).toBe(false)
        expect(mcpRuns).toBe(0)
      }
    }),
  )

  it.instance("under the ask tier the grant is not the user's allow: the call still waits for the user", () =>
    withTier(
      "ask",
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const id = SessionID.descending()
        yield* asNode(id)
        const tools = yield* resolveTools(id)

        const call = yield* start(tools, "srv_lookup")
        const request = yield* pendingRequest
        expect(request.permission).toBe("srv_lookup")
        expect(request.metadata).toEqual({ source: "mcp" })
        expect(mcpRuns).toBe(0)
        yield* permission.reply({ requestID: request.id, reply: "once" })
        expect(Exit.isSuccess(yield* Fiber.await(call))).toBe(true)
        expect(mcpRuns).toBe(1)

        // An allow the user wrote for exactly this tool does free it, as for any other MCP tool. The tools are
        // resolved again, which starts the count of runs over.
        const named = yield* resolveTools(id, [rule("srv_lookup", "allow")])
        expect((yield* settle(named, "srv_lookup")).ok).toBe(true)
        expect(mcpRuns).toBe(1)
        expect(yield* permission.list()).toEqual([])
      }),
    ),
  )

  it.instance("under the readonly tier the grant is not the user's allow: the call is refused", () =>
    withTier(
      "readonly",
      Effect.gen(function* () {
        const id = SessionID.descending()
        yield* asNode(id)
        const tools = yield* resolveTools(id)

        const refused = yield* settle(tools, "srv_lookup")
        expect(refused.ok).toBe(false)
        expect(refused.ok ? "" : refused.message).toContain('dag.permission is "readonly"')
        expect(mcpRuns).toBe(0)

        // The user's own allow for exactly this tool lets it through the read-only tool surface. It stands after the
        // grants in the rules, so it is the rule that decides, and its index must still say it is the user's.
        const named = yield* resolveTools(id, [rule("srv_lookup", "allow")])
        expect((yield* settle(named, "srv_lookup")).ok).toBe(true)
        expect(mcpRuns).toBe(1)
      }),
    ),
  )
})
