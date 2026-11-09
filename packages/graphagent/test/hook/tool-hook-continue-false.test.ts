// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionHooks } from "@/hook/session-hooks"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { Database } from "@graphagent/core/database/database"
import { SessionProjector } from "@graphagent/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"

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

// Claude Code: `continue:false` from a PreToolUse/PostToolUse hook stops the
// agent after the hooks run (unlike permissionDecision:"deny", which only
// blocks this one call and lets the model continue).
for (const event of ["PreToolUse", "PostToolUse"] as const) {
  it.live(`${event} continue:false must stop the agent loop`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({
          title: "Tool hook continue false",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* hooks.add(session.id, {
          event,
          hooks: [
            {
              type: "command",
              command: `printf '%s' '${JSON.stringify({ continue: false, stopReason: "budget exhausted" })}'`,
            },
          ],
        })
        yield* llm.tool("write", { filePath: path.join(dir, "a.txt"), content: "a" })
        yield* llm.tool("write", { filePath: path.join(dir, "b.txt"), content: "b" })
        yield* llm.text("kept going")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "write two files" }],
        })
        // The hook asked to stop: no further model turn may run after the first tool call.
        expect(yield* llm.calls).toBe(1)
        const messages = yield* sessions.messages({ sessionID: session.id })
        const tools = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
        expect(tools).toHaveLength(1)
        // The stop reason is surfaced on the tool result the user sees.
        expect(JSON.stringify(tools[0])).toContain("[Hook stopped] budget exhausted")
        // PreToolUse stop prevents the call itself; PostToolUse stops after it ran.
        const written = yield* Effect.promise(() =>
          fs.access(path.join(dir, "a.txt")).then(
            () => true,
            () => false,
          ),
        )
        expect(written).toBe(event === "PostToolUse")
      }),
      { git: true, config: providerCfg },
    ),
  )
}
