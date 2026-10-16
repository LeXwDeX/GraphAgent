import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { SessionShare } from "@/share/session"
import { SettingsHook } from "@/hook/settings"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// SessionStart source coverage at the prompt-admission boundary: `startup` (SessionShare.create),
// `resume` (first admission of a pre-existing top-level session in this instance). SettingsHook is
// replaced with a recorder so each source can return a distinct additionalContext.

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

const sources: Array<{ sessionID: string; source: string }> = []
const settingsHook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload, ctx) =>
      Effect.sync(() => {
        if (payload.event !== "SessionStart") return { additionalContexts: [], systemMessages: [] }
        sources.push({ sessionID: ctx.sessionID ?? "", source: payload.source })
        return { additionalContexts: [`ctx-${payload.source}`], systemMessages: [] }
      }),
    hasEvent: (event) => Effect.succeed(event === "SessionStart"),
    list: () => Effect.succeed([]),
    fileWatchPaths: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  SessionShare.node,
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
      LayerNode.replace(SettingsHook.node, settingsHook),
    ],
  }),
)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// Seed an earlier turn directly through the Session service so that no prompt admission has
// touched the session yet (a session that "existed before this instance started").
const seedHistory = (sessions: Session.Interface, sessionID: SessionID) =>
  Effect.gen(function* () {
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: ref,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: id,
      sessionID,
      type: "text",
      text: "earlier turn",
    })
  })

const syntheticTexts = (messages: ReadonlyArray<{ info: { role: string }; parts: ReadonlyArray<any> }>) =>
  messages
    .filter((message) => message.info.role === "user")
    .map((message) =>
      message.parts.flatMap((part) => (part.type === "text" && part.synthetic ? [part.text as string] : [])),
    )

const forSession = (id: string) => sources.filter((entry) => entry.sessionID === id).map((entry) => entry.source)

it.live("resume fires once on the first admission of a pre-existing top-level session", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pre-existing", permission: [] })
      yield* seedHistory(sessions, session.id)
      yield* llm.text("one")
      yield* llm.text("two")

      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "first" }] })
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "second" }] })

      expect(forSession(session.id)).toEqual(["resume"])
      const messages = yield* sessions.messages({ sessionID: session.id })
      const users = syntheticTexts(messages)
      // [seeded, first, second]
      expect(users).toEqual([[], ["ctx-resume"], []])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("resume does not fire for a session that has no earlier messages", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Empty", permission: [] })
      yield* llm.text("one")
      yield* llm.text("two")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "first" }] })
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "second" }] })
      expect(forSession(session.id)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("resume does not fire for child sessions", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent", permission: [] })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", permission: [] })
      yield* seedHistory(sessions, child.id)
      yield* llm.text("one")
      yield* prompt.prompt({ sessionID: child.id, agent: "build", parts: [{ type: "text", text: "first" }] })
      expect(forSession(child.id)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("startup still fires from SessionShare.create and no resume follows on its first admission", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const share = yield* SessionShare.Service
      const session = yield* share.create({ title: "Fresh", permission: [] })
      // Even with earlier history, a session created in this instance already had its startup.
      yield* seedHistory(sessions, session.id)
      yield* llm.text("one")
      yield* llm.text("two")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "first" }] })
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "second" }] })

      expect(forSession(session.id)).toEqual(["startup"])
      const users = syntheticTexts(yield* sessions.messages({ sessionID: session.id }))
      expect(users).toEqual([[], ["ctx-startup"], []])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("SessionShare.create does not fire SessionStart for child sessions", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const sessions = yield* Session.Service
      const share = yield* SessionShare.Service
      const parent = yield* sessions.create({ title: "Parent", permission: [] })
      const child = yield* share.create({ parentID: parent.id, title: "Child", permission: [] })
      expect(forSession(child.id)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)
