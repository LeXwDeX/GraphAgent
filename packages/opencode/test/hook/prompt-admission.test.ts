import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

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

// Plugin mock with per-session "chat.message" parking gates. Tests park a
// gate for a session; the trigger for that session then signals "entered"
// once the admission reaches the plugin callback and waits on the gate's
// promise before returning, letting the test cancel mid-admission
// deterministically. Sessions without a gate pass straight through.
interface ChatMessageGate {
  entered: boolean
  open: () => void
}
const chatMessageGates = new Map<string, ChatMessageGate>()
const pluginMock = Layer.suspend(() =>
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: ((_name: string, input: { sessionID?: string }, output: unknown) => {
        const gate = input?.sessionID ? chatMessageGates.get(input.sessionID) : undefined
        if (!gate) return Effect.succeed(output as never)
        const wait = new Promise<void>((resolve) => {
          gate.entered = true
          gate.open = resolve
        })
        return Effect.promise(() => wait.then(() => output as never))
      }) as Plugin.Interface["trigger"],
      list: () => Effect.succeed([]),
      contextFoldingCompatibility: () =>
        Effect.succeed({
          knownExternalDcp: "unknown",
          migrationNotice: "not-applicable",
        } as const),
      init: () => Effect.void,
    }),
  ),
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
      LayerNode.replace(Plugin.node, pluginMock),
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

for (const variant of ["block", "continue-false"] as const) {
  it.live(`UserPromptSubmit ${variant} must stop before invoking the model`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: "Audit prompt hook control", permission: [] })
        const output =
          variant === "block"
            ? { decision: "block", reason: "audit-block" }
            : { continue: false, stopReason: "audit-stop" }
        yield* hooks.add(session.id, {
          event: "UserPromptSubmit",
          hooks: [{ type: "command", command: "printf '%s' '" + JSON.stringify(output) + "'" }],
        })
        yield* llm.text("audit-model-was-called")
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "audit user prompt stop signal" }],
        })
        const calls = yield* llm.calls
        expect(calls).toBe(0)
        expect(result.info.role).toBe("user")
      }),
      { git: true, config: providerCfg },
    ),
  )
}

it.live("async hooks re-enter the real session after their caller has completed", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Async hook callback", permission: [] })
      const release = path.join(dir, "release")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            once: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"async finished"}'`,
          },
        ],
      })
      yield* llm.text("first response")
      yield* llm.text("rewake response")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "start async hook" }],
      })
      expect(yield* llm.calls).toBe(1)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 2 ? true : undefined))),
        "async hook did not invoke the model again",
      )
      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(
        messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text.includes("Async hook completed")),
        ),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancelled session discards a completing async Stop hook callback", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Cancel discards stop callback", permission: [] })
      const release = path.join(dir, "release")
      const completed = path.join(dir, "completed")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"result after cancel"}'; touch ${quote(completed)}`,
          },
        ],
      })
      yield* llm.text("first answer")
      yield* llm.text("must never be consumed after cancel")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      // The turn is over and the async Stop hook is parked on the release file.
      expect(yield* llm.calls).toBe(1)
      // User aborts the (idle) session: a callback completing afterwards must
      // not silently restart the session the user just cancelled.
      yield* prompt.cancel(session.id)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return (await fs.access(completed).then(
              () => true,
              () => false,
            ))
              ? true
              : undefined
          } catch {
            return undefined
          }
        }),
        "async Stop callback never completed",
      )
      // Give a (wrong) rewake ample time to admit a new turn.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancel parked inside chat.message admission strips a stale stop-chain rewake", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Fence stale rewake", permission: [] })
      const release = path.join(dir, "release")
      const completed = path.join(dir, "completed")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"stale verdict"}'; touch ${quote(completed)}`,
          },
        ],
      })
      yield* llm.text("first answer")
      yield* llm.text("must never be consumed by a stale rewake")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      // The turn is over; the async Stop callback is parked on the release file.
      expect(yield* llm.calls).toBe(1)

      // Park the rewake admission inside createUserMessage (plugin.trigger
      // "chat.message") BEFORE commit: the pre-admission chain check has
      // already passed at this point, so only a post-commit fence can stop it.
      const gate: ChatMessageGate = { entered: false, open: () => {} }
      chatMessageGates.set(session.id, gate)
      try {
        yield* Effect.promise(() => fs.writeFile(release, "go"))
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs.access(completed).then(
              () => true,
              () => undefined,
            ),
          ),
          "async Stop callback never completed",
        )
        yield* pollWithTimeout(
          Effect.sync(() => (gate.entered ? (true as const) : undefined)),
          "rewake admission never reached chat.message",
        )
        // Cancel lands while admission is parked in the plugin callback.
        yield* prompt.cancel(session.id)
        gate.open()
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
        // The stale rewake must not consume a model call.
        expect(yield* llm.calls).toBe(1)
        // Its committed message must be stripped from model input.
        const messages = yield* sessions.messages({ sessionID: session.id })
        const rewake = messages.find((message) =>
          message.parts.some(
            (part) =>
              part.type === "text" && part.text.includes("Async hook completed") && message.info.role === "user",
          ),
        )
        expect(rewake).toBeDefined()
        for (const part of rewake!.parts) {
          if (part.type !== "text") continue
          expect(part.ignored).toBe(true)
        }
      } finally {
        chatMessageGates.delete(session.id)
      }
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancel invalidates a stop-chain rewake queued behind a busy turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Cancel queued rewake", permission: [] })
      const release = path.join(dir, "release")
      const completed = path.join(dir, "completed")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"queued stale verdict"}'; touch ${quote(completed)}`,
          },
        ],
      })
      yield* llm.text("first answer")
      let openTurn!: () => void
      const turnGate = new Promise<void>((resolve) => {
        openTurn = resolve
      })
      yield* llm.hold("turn two answer", turnGate)
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn one" }] })
      expect(yield* llm.calls).toBe(1)
      // Turn two parks on the model gate: the runner is busy and the prompt
      // lock is held, so the rewake below queues behind it.
      const running = yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn two" }] })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 2 ? true : undefined))),
        "turn two never reached the model",
      )
      // Complete the stale Stop callback: its rewake waits on the prompt lock.
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(completed).then(
            () => true,
            () => undefined,
          ),
        ),
        "stale callback never completed",
      )
      // Cancel invalidates the chain and interrupts the busy turn; when the
      // queued rewake finally admits, its chain check must refuse it.
      yield* prompt.cancel(session.id)
      openTurn()
      yield* Fiber.join(running).pipe(Effect.ignore)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(2)
      // No stale rewake text ever reached a model request.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs).includes("Async hook completed")).toBe(false)
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("a fresh prompt after cancel re-establishes a working Stop rewake chain", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Rewake survives cancel", permission: [] })
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const addStopHook = (release: string, body: string) =>
        hooks.add(session.id, {
          event: "Stop",
          once: true,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' ${quote(body)}; touch ${quote(`${release}.completed`)}`,
            },
          ],
        })
      const releaseA = path.join(dir, "release-a")
      const releaseB = path.join(dir, "release-b")
      // Turn 1 with a pending Stop callback, then cancel: the callback dies.
      yield* addStopHook(releaseA, '{"systemMessage":"stale after cancel"}')
      yield* llm.text("first answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn one" }] })
      expect(yield* llm.calls).toBe(1)
      yield* prompt.cancel(session.id)
      yield* Effect.promise(() => fs.writeFile(releaseA, "go"))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(1)
      // A fresh prompt + fresh Stop callback must still rewake normally.
      yield* addStopHook(releaseB, '{"systemMessage":"fresh verdict"}')
      yield* llm.text("second answer")
      yield* llm.text("fresh rewake answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn two" }] })
      expect(yield* llm.calls).toBe(2)
      yield* Effect.promise(() => fs.writeFile(releaseB, "go"))
      yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return (await fs.access(`${releaseB}.completed`).then(
              () => true,
              () => false,
            ))
              ? true
              : undefined
          } catch {
            return undefined
          }
        }),
        "fresh Stop callback never completed",
      )
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
        "fresh Stop callback did not rewake a new turn",
      )
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancelling one session leaves another session's Stop rewake intact", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const sessionA = yield* sessions.create({ title: "Cancelled neighbour", permission: [] })
      const sessionB = yield* sessions.create({ title: "Independent neighbour", permission: [] })
      const releaseA = path.join(dir, "release-a")
      const releaseB = path.join(dir, "release-b")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const addStopHook = (sessionID: typeof sessionA.id, release: string, body: string) =>
        hooks.add(sessionID, {
          event: "Stop",
          once: true,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' ${quote(body)}`,
            },
          ],
        })
      yield* addStopHook(sessionA.id, releaseA, '{"systemMessage":"neighbour A verdict"}')
      yield* addStopHook(sessionB.id, releaseB, '{"systemMessage":"neighbour B verdict"}')
      yield* llm.text("a1")
      yield* prompt.prompt({ sessionID: sessionA.id, agent: "build", parts: [{ type: "text", text: "a turn" }] })
      yield* llm.text("b1")
      yield* prompt.prompt({ sessionID: sessionB.id, agent: "build", parts: [{ type: "text", text: "b turn" }] })
      expect(yield* llm.calls).toBe(2)
      yield* prompt.cancel(sessionA.id)
      yield* Effect.promise(() => Promise.all([fs.writeFile(releaseA, "go"), fs.writeFile(releaseB, "go")]))
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
        "session B Stop callback did not rewake a new turn",
      )
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      // Still exactly one rewake (B's): A's was invalidated, not deferred.
      expect(yield* llm.calls).toBe(3)
      const messagesA = yield* sessions.messages({ sessionID: sessionA.id })
      expect(messagesA.every((m) => m.parts.every((p) => !(p.type === "text" && p.text.includes("neighbour A"))))).toBe(
        true,
      )
      yield* hooks.clear(sessionA.id)
      yield* hooks.clear(sessionB.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("session cancellation aborts an executing pre-tool hook", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Cancel running hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const ready = path.join(dir, "hook.pid")
      const target = path.join(dir, "must-not-write.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "PreToolUse",
        hooks: [{ type: "command", command: `echo $$ > ${quote(ready)}; exec sleep 30` }],
      })
      yield* llm.tool("write", { filePath: target, content: "should be cancelled" })
      yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "cancel this operation" }] })
        .pipe(Effect.forkChild)
      const pid = yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return Number(await fs.readFile(ready, "utf8")) || undefined
          } catch {
            return undefined
          }
        }),
        "pre-tool hook never started",
      )
      yield* prompt.cancel(session.id)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "pre-tool hook survived session cancellation",
        2000,
      )
      expect(
        yield* Effect.promise(() =>
          fs.access(target).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("session cancellation aborts a post-tool hook and preserves the completed tool", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Cancel post-tool hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const ready = path.join(dir, "post-hook.pid")
      const target = path.join(dir, "written.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "PostToolUse",
        hooks: [{ type: "command", command: `echo $$ > ${quote(ready)}; exec sleep 30` }],
      })
      yield* llm.tool("write", { filePath: target, content: "completed before cancellation" })
      const running = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "write the file" }],
        })
        .pipe(Effect.forkChild)
      const pid = yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return Number(await fs.readFile(ready, "utf8")) || undefined
          } catch {
            return undefined
          }
        }),
        "post-tool hook never started",
      )
      yield* prompt.cancel(session.id)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "post-tool hook survived cancellation",
        2000,
      )
      const result = yield* Fiber.await(running)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isFailure(result)) return
      const tool = result.value.parts.find((part) => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("completed before cancellation")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("native tool failures run failure hooks and preserve their feedback", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Native failure hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* hooks.add(session.id, {
        event: "PostToolUseFailure",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"hookSpecificOutput":{"additionalContext":"failure-feedback: retry an existing file"}}'`,
          },
        ],
      })
      yield* llm.tool("read", { filePath: path.join(dir, "missing.txt") })
      yield* llm.text("I will retry a file that exists.")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "read the missing file" }],
      })
      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      const failed = parts.find((part) => part.type === "tool" && part.tool === "read")
      expect(failed?.type).toBe("tool")
      if (failed?.type !== "tool") return
      expect(failed?.state.status).toBe("error")
      if (failed?.state.status !== "error") return
      expect(failed.state.error).toContain("failure-feedback")
      expect(JSON.stringify(yield* llm.inputs)).toContain("failure-feedback")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("native write, edit and multi-file patch emit actual FileChanged paths", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Hook file events",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const capture = path.join(dir, "events.jsonl")
      const original = path.join(dir, "source.txt")
      const moved = path.join(dir, "moved.txt")
      const second = path.join(dir, "second.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "FileChanged",
        hooks: [{ type: "command", command: "cat >> " + quote(capture) }],
      })
      yield* llm.tool("write", { filePath: original, content: "before\n" })
      yield* llm.tool("edit", { filePath: original, oldString: "before", newString: "edited" })
      yield* llm.text("edited")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        parts: [{ type: "text", text: "exercise write and edit" }],
      })
      expect(yield* Effect.promise(() => fs.readFile(original, "utf8"))).toBe("edited\n")
      yield* llm.tool("apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: ${original}\n*** Move to: ${moved}\n@@\n-edited\n+after\n*** Add File: ${second}\n+second\n*** End Patch`,
      })
      yield* llm.text("done")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("gpt-hook-test") },
        parts: [{ type: "text", text: "exercise patch" }],
      })
      expect(yield* Effect.promise(() => fs.readFile(moved, "utf8"))).toBe("after\n")
      expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second\n")
      expect(
        yield* Effect.promise(() =>
          fs.access(original).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const records = (yield* Effect.promise(() => fs.readFile(capture, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records.map((record) => [record.path, record.change_type])).toEqual([
        [original, "add"],
        [original, "change"],
        [original, "delete"],
        [moved, "add"],
        [second, "add"],
      ])
    }),
    {
      git: true,
      config: (url) => {
        const config = providerCfg(url)
        const model = config.provider.test.models["test-model"]
        return {
          provider: {
            test: {
              ...config.provider.test,
              models: { ...config.provider.test.models, "gpt-hook-test": { ...model, id: "gpt-hook-test" } },
            },
          },
        }
      },
    },
  ),
)

for (const event of ["Stop", "StopFailure"] as const) {
  it.live(`${event} asyncRewake shares a bounded chain and resets for a new prompt`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: "Bounded Stop rewake audit", permission: [] })
        const marker = path.join(dir, "stops")
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        yield* hooks.add(session.id, {
          event,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `sleep 0.1; cat >> ${quote(marker)}; n=$(wc -l < ${quote(marker)}); if [ "$n" -le 14 ]; then printf '{"systemMessage":"hook revision %s"}' "$n"; fi`,
            },
          ],
        })
        for (let i = 0; i < 16; i++) {
          if (event === "StopFailure") yield* llm.error(400, { error: { message: `provider failure ${i}` } })
          else yield* llm.text(`response ${i}`)
        }
        const completedStops = (count: number) =>
          pollWithTimeout(
            Effect.promise(async () => {
              try {
                const lines = (await fs.readFile(marker, "utf8")).trim().split("\n")
                return lines.length >= count ? lines.map((line) => JSON.parse(line)) : undefined
              } catch {
                return undefined
              }
            }),
            `Stop chain did not finish ${count} events`,
            "15 seconds",
          )
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start" }] })
        const first = yield* completedStops(SettingsHook.MAX_STOP_CONTINUATIONS + 1)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
        expect(yield* llm.calls).toBe(SettingsHook.MAX_STOP_CONTINUATIONS + 1)
        expect(first[0].stop_hook_active).toBe(false)
        expect(first.slice(1).every((event) => event.stop_hook_active === true)).toBe(true)

        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "new input" }] })
        const both = yield* completedStops((SettingsHook.MAX_STOP_CONTINUATIONS + 1) * 2)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
        expect(yield* llm.calls).toBe((SettingsHook.MAX_STOP_CONTINUATIONS + 1) * 2)
        expect(both[SettingsHook.MAX_STOP_CONTINUATIONS + 1].stop_hook_active).toBe(false)
        yield* hooks.clear(session.id)
      }),
      { git: true, config: providerCfg },
    ),
  )
}
