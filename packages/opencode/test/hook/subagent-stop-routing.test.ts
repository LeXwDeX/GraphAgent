import { decodeJsonRecord, decodeRecord, decodeString } from "../lib/hook-json"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
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
import { SessionRetry } from "@/session/retry"
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
  HookLifecycle.node,
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

// Claude Code: `Stop` fires when the MAIN agent finishes; a task-tool subagent
// finishing fires `SubagentStop` only (task.ts fires it for the child).
it.live("subagent completion must not fire main-agent Stop hooks", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const capture = path.join(dir, "stop-events.jsonl")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".opencode", "hooks.json"),
          JSON.stringify({
            Stop: [{ hooks: [{ type: "command", command: `cat >> '${capture}'; echo >> '${capture}'` }] }],
          }),
        )
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Subagent stop routing",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
      yield* llm.text("sub answer")
      yield* llm.text("parent done")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      const events = (yield* Effect.promise(() => fs.readFile(capture, "utf8")))
        .split("\n")
        .filter((line) => line.trim())
        .map((line): { session_id: string; hook_event_name: string } => JSON.parse(line))
      expect(events.map((e) => e.session_id)).toEqual([session.id])
    }),
    { git: true, config: providerCfg },
  ),
)

const writeStopCapture = (dir: string, event: "Stop" | "SubagentStop" = "Stop") =>
  Effect.promise(async () => {
    const capture = path.join(dir, "stop-events.jsonl")
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        [event]: [{ hooks: [{ type: "command", command: `cat >> '${capture}'; echo >> '${capture}'` }] }],
      }),
    )
    return capture
  })

// A child session created through the public API (`POST /session {parentID}`)
// is not driven by TaskTool; its own prompt loop emits the parent-scoped SubagentStop.
it.live("SDK-created child session emits parent-scoped SubagentStop", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const capture = yield* writeStopCapture(dir, "SubagentStop")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "SDK parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "SDK child" })
      yield* llm.text("child answer")
      yield* prompt.prompt({ sessionID: child.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
      const events = (yield* Effect.promise(() => fs.readFile(capture, "utf8")))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => decodeJsonRecord(line))
      expect(events).toEqual([
        expect.objectContaining({ session_id: parent.id, agent_id: child.id, hook_event_name: "SubagentStop" }),
      ])
    }),
    { git: true, config: providerCfg },
  ),
)

// A recovered historical DAG attempt has no live Start claim in this process.
// Its owner suppresses per-loop Stop even while resuming multiple model turns.
it.live("recovered DAG child loops do not replay historical SubagentStop", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const capture = yield* writeStopCapture(dir, "SubagentStop")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const lifecycle = yield* HookLifecycle.Service
      const parent = yield* sessions.create({ title: "Recovered DAG parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Recovered DAG child" })
      yield* lifecycle.delegateChildStop(child.id)
      for (const text of ["resume accepted input", "submit updated result"]) {
        yield* llm.text(text)
        yield* prompt.prompt({ sessionID: child.id, agent: "build", parts: [{ type: "text", text }] })
      }
      expect(yield* Effect.promise(() => fs.readFile(capture, "utf8").catch(() => ""))).toBe("")
      expect(yield* lifecycle.claimChildStop(child.id, "historical-attempt")).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
)

// `{ continue: false, stopReason }` cannot reach the model (the turn stops), but
// CC still shows the reason; the V2 turn bridge lands it as a HookMessage, and
// the Task tool's SubagentStop consumer must do the same.
it.live("SubagentStop continue:false lands its stopReason as a user-visible notice", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const notice = JSON.stringify({ continue: false, stopReason: "SUBAGENT-STOPPED" })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".opencode", "hooks.json"),
          JSON.stringify({
            SubagentStop: [{ hooks: [{ type: "command", command: `printf '%s' '${notice}'` }] }],
          }),
        )
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* sessions.create({
        title: "Subagent stop reason",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const notices: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== LegacyEvent.HookMessage.type) return Effect.void
        const data = decodeRecord(event.data)
        if (data.sessionID === session.id) notices.push(decodeString(data.message))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => (typeof off === "function" ? Effect.sync(off) : off))
      yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
      yield* llm.text("sub answer")
      yield* llm.text("parent done")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      expect(notices).toContain("SUBAGENT-STOPPED")
    }),
    { git: true, config: providerCfg },
  ),
)

// task.ts fails a foreground child that ended in error without firing
// SubagentStop, so the child's own loop must still emit StopFailure.
it.live("failed foreground subagent still fires StopFailure", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const capture = path.join(dir, "stop-failure-events.jsonl")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".opencode", "hooks.json"),
          JSON.stringify({
            StopFailure: [{ hooks: [{ type: "command", command: `cat >> '${capture}'; echo >> '${capture}'` }] }],
          }),
        )
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Subagent failure routing",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
      // Every 4xx/5xx is resent by the shared retry layer, so the child ends in
      // error only after the attempt cap. retry-after-ms: 0 keeps the backoff
      // out of the test's wall clock.
      for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_RETRIES; attempt++) {
        yield* llm.error(503, { error: { message: "subagent request rejected" } }, { "retry-after-ms": "0" })
      }
      yield* llm.text("parent done")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      const events = (yield* Effect.promise(() => fs.readFile(capture, "utf8").catch(() => "")))
        .split("\n")
        .filter((line) => line.trim())
        .map((line): { session_id: string; hook_event_name: string } => JSON.parse(line))
      const child = events.filter((event) => event.session_id !== session.id)
      expect(child.map((event) => event.hook_event_name)).toEqual(["StopFailure"])
    }),
    { git: true, config: providerCfg },
  ),
)
