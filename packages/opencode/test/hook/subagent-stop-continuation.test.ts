import { decodeJsonRecord } from "../lib/hook-json"
import { SessionHooks } from "@/hook/session-hooks"
import fs from "node:fs/promises"
import path from "node:path"
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

// Claude Code: a blocking SubagentStop hook makes the subagent keep working;
// the Task result handed to the parent is the subagent's FINAL answer.
it.live("SubagentStop continuation result is returned to the parent", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const audit = path.join(dir, "subagent-stop.jsonl")
      const session = yield* sessions.create({
        title: "Subagent stop continuation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* hooks.add(session.id, {
        event: "SubagentStop",
        hooks: [
          {
            type: "command",
            command: `tee -a ${JSON.stringify(audit)} | grep -q '"stop_hook_active":true' || printf '%s' '{"decision":"block","reason":"also verify the result"}'`,
          },
        ],
      })
      yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
      yield* llm.text("STALE-FIRST-SUB-ANSWER")
      yield* llm.text("FINAL-VERIFIED-SUB-ANSWER")
      yield* llm.text("parent done")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      expect(yield* llm.calls).toBe(4)
      const parentFollowUp = JSON.stringify((yield* llm.inputs)[3])
      expect(parentFollowUp).toContain("FINAL-VERIFIED-SUB-ANSWER")
      expect(parentFollowUp).not.toContain("STALE-FIRST-SUB-ANSWER")
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => decodeJsonRecord(line))
      expect(rows).toHaveLength(2)
      expect(
        rows.every(
          (row) =>
            row.session_id === session.id && Array.isArray(row.background_tasks) && Array.isArray(row.session_crons),
        ),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)
