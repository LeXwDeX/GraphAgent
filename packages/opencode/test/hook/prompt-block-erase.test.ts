import { SessionHooks } from "@/hook/session-hooks"
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

// Claude Code: a UserPromptSubmit block (decision:"block" or exit 2) stops the
// prompt before it reaches the model; the reason is shown to the user and is not
// added to context. The block message ends with the submitted text unless the hook
// sets suppressOriginalPrompt; either way the text never reaches the model.
for (const suppress of [false, true]) {
  it.live(`blocked UserPromptSubmit prompt and reason never reach the model (suppressOriginalPrompt ${suppress})`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: "Prompt block erase", permission: [] })
        const output = JSON.stringify({
          decision: "block",
          reason: "secret detected",
          ...(suppress
            ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } }
            : {}),
        })
        yield* hooks.add(session.id, {
          event: "UserPromptSubmit",
          hooks: [
            {
              type: "command",
              command: `grep -q SECRET-TOKEN-1234 && printf '%s' '${output}' || true`,
            },
          ],
        })
        yield* llm.text("second-turn-response")
        const blocked = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "my key is SECRET-TOKEN-1234" }],
        })
        expect(yield* llm.calls).toBe(0)
        // The user sees the reason (non-synthetic, so clients render it) but the
        // part is ignored for model input.
        expect(blocked.parts).toEqual([
          expect.objectContaining({
            type: "text",
            text: suppress
              ? "[Hook stopped] secret detected"
              : "[Hook stopped] secret detected\n\nOriginal prompt: my key is SECRET-TOKEN-1234",
            ignored: true,
          }),
        ])
        expect(blocked.parts[0]).not.toHaveProperty("synthetic", true)
        expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id })).includes("SECRET-TOKEN-1234")).toBe(
          !suppress,
        )
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "hello again" }],
        })
        expect(yield* llm.calls).toBe(1)
        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).not.toContain("SECRET-TOKEN-1234")
        expect(inputs).not.toContain("secret detected")
        expect(inputs).toContain("hello again")
      }),
      { git: true, config: providerCfg },
    ),
  )
}
