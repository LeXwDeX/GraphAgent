// Issue #777 — acceptance criterion 1: a real PreToolUse hook DENIAL must not
// terminate the worker; the model sees the denial as an ordinary tool result,
// corrects course, and finishes its report.
//
// This exercises the REAL settingsHook trigger path (a command hook whose
// stdout carries hookSpecificOutput.permissionDecision:"deny") plus the real
// tool pipeline with a scripted TestLLMServer — not a mocked LLMEvent stream.
//
// The `continue:false` stop control is pinned separately by
// test/hook/tool-hook-continue-false.test.ts and is intentionally not
// duplicated here.
import { SessionHooks } from "@/hook/session-hooks"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
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

it.live("a real PreToolUse denial is a tool result: the model corrects and finishes its report", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Tool rejection recovery",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* hooks.add(session.id, {
        event: "PreToolUse",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "guarded path is off limits",
              },
            })}'`,
          },
        ],
      })
      // Turn 1: the model tries the guarded write; the hook denies it.
      // Turn 2: the model adapts and finishes its report without the tool.
      yield* llm.tool("write", { filePath: path.join(dir, "secret.txt"), content: "nope" })
      yield* llm.text("The guarded path was denied, so I adjusted the plan and completed the report anyway.")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "write the file" }],
      })

      // The denial did NOT stop the loop: the model got its correction turn.
      expect(yield* llm.calls).toBe(2)

      const messages = yield* sessions.messages({ sessionID: session.id })
      const tools = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
      expect(tools).toHaveLength(1)
      expect(tools[0]?.state.status).toBe("completed")
      if (tools[0]?.type === "tool" && tools[0].state.status === "completed") {
        // The tool never executed and the denial reason is visible.
        expect(tools[0].state.metadata.hookDenied).toBe(true)
        expect(tools[0].state.output).toContain("[Tool denied by hook] guarded path is off limits")
      }
      const written = yield* Effect.promise(() =>
        fs.access(path.join(dir, "secret.txt")).then(
          () => true,
          () => false,
        ),
      )
      expect(written).toBe(false)

      // The final assistant message carries the model's report — the turn
      // ended cleanly, not with an error/abort marker.
      const lastAssistant = messages.filter((message) => message.info.role === "assistant").at(-1)
      expect(lastAssistant).toBeDefined()
      if (lastAssistant && lastAssistant.info.role === "assistant") {
        expect(lastAssistant.info.error).toBeUndefined()
        const text = lastAssistant.parts.find((part) => part.type === "text")
        expect(text && "text" in text ? text.text : "").toContain("completed the report")
      }
    }),
    { git: true, config: providerCfg },
  ),
)
