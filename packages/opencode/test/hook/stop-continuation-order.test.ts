import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { decodeRecord, decodeString } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
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

const root = LayerNode.group([
  // HookMessage notices (stopReason landing) are published through this bridge.
  EventV2Bridge.node,
  SessionPrompt.node,
  SessionHooks.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)

const providerCfg = (url: string) => ({
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
        baseURL: url,
      },
    },
  },
})

// Claude Code: a blocking Stop hook's reason is delivered to the model as the
// newest input so it continues working on it.
it.live("Stop hook block reason is the latest model input on the continuation turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Stop continuation order", permission: [] })
      yield* hooks.add(session.id, {
        event: "Stop",
        hooks: [
          {
            type: "command",
            command: `grep -q '"stop_hook_active":true' || printf '%s' '{"decision":"block","reason":"STOP-REASON-MARKER run the tests"}'`,
          },
        ],
      })
      yield* llm.text("first answer")
      yield* llm.text("second answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      expect(yield* llm.calls).toBe(2)
      const second: { messages: { role: string; content: unknown }[] } = JSON.parse(
        JSON.stringify((yield* llm.inputs)[1]),
      )
      const last = second.messages[second.messages.length - 1]
      expect(last.role).toBe("user")
      expect(JSON.stringify(last.content)).toContain("STOP-REASON-MARKER")
      // The reason follows the assistant reply it responds to, not the original prompt.
      const previous = second.messages[second.messages.length - 2]
      expect(previous.role).toBe("assistant")
      expect(JSON.stringify(previous.content)).toContain("first answer")
      const user = second.messages.findLast((message) => message.role === "user" && message !== last)
      expect(JSON.stringify(user?.content)).not.toContain("STOP-REASON-MARKER")
    }),
    { git: true, config: providerCfg },
  ),
)

// `{ continue: false, stopReason }` stops the turn, so its reason can never be
// model feedback. CC still shows it; V2 lands it as a HookMessage and V1 must too.
it.live("Stop hook continue:false lands its stopReason as a user-visible notice", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* sessions.create({ title: "Stop reason", permission: [] })
      yield* hooks.add(session.id, {
        event: "Stop",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '${JSON.stringify({ continue: false, stopReason: "STOPPED-MARKER" })}'`,
          },
        ],
      })
      const notices: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== LegacyEvent.HookMessage.type) return Effect.void
        const data = decodeRecord(event.data)
        if (data.sessionID === session.id) notices.push(decodeString(data.message))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => (typeof off === "function" ? Effect.sync(off) : off))
      yield* llm.text("only answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      // continue:false ends the turn: no continuation request is made.
      expect(yield* llm.calls).toBe(1)
      expect(notices).toEqual(["STOPPED-MARKER"])
    }),
    { git: true, config: providerCfg },
  ),
)

// Claude Code bounds consecutive Stop continuations at 8 by default and lets
// CLAUDE_CODE_STOP_HOOK_BLOCK_CAP raise the bound. The cap is read while the
// turn loop runs, so 2 allows exactly two continuation turns (three calls).
it.live("honors CLAUDE_CODE_STOP_HOOK_BLOCK_CAP when capping Stop continuations", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const previous = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = "2"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
          else process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previous
        }),
      )
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Stop cap", permission: [] })
      yield* hooks.add(session.id, {
        event: "Stop",
        hooks: [{ type: "command", command: `printf '%s' '{"decision":"block","reason":"KEEP-GOING"}'` }],
      })
      yield* llm.text("first answer")
      yield* llm.text("second answer")
      yield* llm.text("third answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      expect(yield* llm.calls).toBe(3)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("Stop additionalContext alone ends the turn and is retained for the next prompt", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Stop context only", permission: [] })
      yield* hooks.add(session.id, {
        event: "Stop",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"NEXT-TURN-NOTE"}}'`,
          },
        ],
      })
      yield* llm.text("finished")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      expect(yield* llm.calls).toBe(1)
      yield* llm.text("next answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "next request" }] })
      expect(yield* llm.calls).toBe(2)
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("NEXT-TURN-NOTE")
    }),
    { git: true, config: providerCfg },
  ),
)
