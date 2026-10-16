import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookRewake } from "@/hook/rewake"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { MockLanguageModelV3 } from "ai/test"
import { tool as aiTool, jsonSchema, type ToolExecutionOptions } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import path from "node:path"
import fs from "node:fs/promises"

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(Layer.mergeAll(layer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const rewakeGates = new Map<string, { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>()
const lateRewake = Layer.succeed(
  HookRewake.Service,
  HookRewake.Service.of({
    rewake: ({ sessionID }) =>
      Effect.gen(function* () {
        const gate = rewakeGates.get(sessionID)
        if (!gate) return
        yield* Deferred.succeed(gate.entered, undefined)
        yield* Deferred.await(gate.release)
      }),
  }),
)
const raceLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(lateRewake),
)
const raceIt = testEffect(Layer.mergeAll(raceLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const completionGates = new Map<
  string,
  { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void>; calls: number }
>()
const gatedSessionHooks = Layer.effect(
  SessionHooks.Service,
  Effect.gen(function* () {
    const actual = yield* SessionHooks.Service
    return SessionHooks.Service.of({
      ...actual,
      complete: (sessionID, id, token, succeeded) => {
        const gate = completionGates.get(sessionID)
        if (!gate || gate.calls++ > 0) return actual.complete(sessionID, id, token, succeeded)
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.entered, undefined)
          yield* Deferred.await(gate.release)
          yield* actual.complete(sessionID, id, token, succeeded)
        })
      },
    })
  }),
).pipe(Layer.provide(SessionHooks.defaultLayer))
const gatedLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(gatedSessionHooks),
)
const gatedIt = testEffect(Layer.mergeAll(gatedLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

type MCPResult = { content: { type: "text"; text: string }[]; isError?: boolean }
const tool = (execute: (input: Record<string, unknown>, options: ToolExecutionOptions) => Promise<MCPResult>) =>
  Layer.mock(MCP.Service, {
    tools: () =>
      Effect.succeed({
        test_check: aiTool({
          inputSchema: jsonSchema<Record<string, unknown>>({ type: "object", properties: {} }),
          execute,
        }),
      }),
  })

const preTool = { event: "PreToolUse" as const, toolName: "Read", toolInput: {} }
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const modelLayer = (model: MockLanguageModelV3) =>
  Layer.mergeAll(
    Layer.mock(Provider.Service, {
      defaultModel: () => Effect.succeed({ providerID: ProviderV2.ID.make("audit"), modelID: ModelV2.ID.make("test") }),
      getModel: () => Effect.succeed(ProviderTest.model()),
      getLanguage: () => Effect.succeed(model),
    }),
    Layer.mock(Auth.Service, { get: () => Effect.succeed({ type: "api" as const, key: "test-only" }) }),
  )

describe("MCP hook stdout and once ownership", () => {
  it.instance("a successful HTTP once hook is consumed", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let calls = 0
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/review-http/SKILL.md",
        hooks: { PreToolUse: [{ once: true, hooks: [{ type: "http", url: "http://localhost/review-once" }] }] },
      })
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls++
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })))
        }),
      )
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(http))
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(http))
      expect(calls).toBe(1)
    }),
  )

  for (const type of ["prompt", "agent"] as const) {
    it.instance(`a successful ${type} once hook is consumed`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        const model = new MockLanguageModelV3({
          doGenerate: {
            content:
              type === "prompt"
                ? [{ type: "text", text: JSON.stringify({ ok: true }) }]
                : [
                    {
                      type: "tool-call",
                      toolCallId: "once",
                      toolName: "synthetic_output",
                      input: JSON.stringify({ ok: true }),
                    },
                  ],
            finishReason: { unified: type === "prompt" ? "stop" : "tool-calls", raw: "stop" },
            usage,
            warnings: [],
          },
        })
        yield* hooks.registerScoped!(sessionID, {
          kind: "skill",
          origin: `skill:/review-${type}/SKILL.md`,
          hooks: { PreToolUse: [{ once: true, hooks: [{ type, prompt: "Return ok true" }] }] },
        })
        const services = modelLayer(model)
        yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(services))
        yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(services))
        expect(model.doGenerateCalls).toHaveLength(1)
      }),
    )
  }

  it.instance("a successful MCP once hook is consumed", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      let calls = 0
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/review-once/SKILL.md",
        hooks: { PreToolUse: [{ once: true, hooks: [{ type: "mcp_tool", server: "test", tool: "check" }] }] },
      })
      const mcp = tool(async () => {
        calls++
        return { content: [{ type: "text", text: "{}" }] }
      })
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
      expect(calls).toBe(1)
      expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(0)
    }),
  )

  it.instance("cancelling a claimed foreground group releases it for retry", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let calls = 0
      let started!: () => void
      const running = new Promise<void>((resolve) => {
        started = resolve
      })
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/review-cancel/SKILL.md",
        hooks: { PreToolUse: [{ once: true, hooks: [{ type: "mcp_tool", server: "test", tool: "check" }] }] },
      })
      const mcp = tool(async (_input, options) => {
        calls++
        if (calls > 1) return { content: [{ type: "text", text: "{}" }] }
        started()
        return new Promise((_resolve, reject) => {
          if (!options.abortSignal) throw new Error("missing hook cancellation signal")
          options.abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        })
      })
      const first = yield* hooks
        .trigger(preTool, { sessionID, transcriptPath: "" })
        .pipe(Effect.provide(mcp), Effect.forkChild)
      yield* Effect.promise(() => running)
      yield* Fiber.interrupt(first)
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
      expect(calls).toBe(2)
    }),
  )

  for (const succeeded of [false, true]) {
    gatedIt.instance(`interruption during once completion ${succeeded ? "retains success" : "releases failure"}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const sessionID = SessionID.descending()
        const attempts = path.join(instance.directory, `once-completion-${succeeded}`)
        const gate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          calls: 0,
        }
        completionGates.set(sessionID, gate)
        yield* hooks.registerScoped!(sessionID, {
          kind: "skill",
          origin: `skill:/review-once-completion-${succeeded}/SKILL.md`,
          hooks: {
            PreToolUse: [
              {
                once: true,
                hooks: [
                  {
                    type: "command",
                    command: `printf x >> ${quote(attempts)}; exit ${succeeded ? 0 : 1}`,
                  },
                ],
              },
            ],
          },
        })
        const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
        const first = yield* run().pipe(Effect.forkChild)
        yield* Deferred.await(gate.entered)
        const cancellation = yield* Fiber.interrupt(first).pipe(Effect.forkChild)
        // The first trigger is suspended inside the real SessionHooks.complete
        // boundary. Give cancellation a scheduler turn before releasing it.
        yield* Effect.sleep("10 millis")
        yield* Deferred.succeed(gate.release, undefined)
        yield* Fiber.join(cancellation)
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
        yield* run()
        expect(yield* Effect.promise(() => fs.readFile(attempts, "utf8"))).toBe(succeeded ? "x" : "xx")
        expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(succeeded ? 0 : 1)
        completionGates.delete(sessionID)
      }),
    )
  }

  it.instance("a failed MCP once hook remains available", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let calls = 0
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/review-failure/SKILL.md",
        hooks: { PreToolUse: [{ once: true, hooks: [{ type: "mcp_tool", server: "test", tool: "check" }] }] },
      })
      const mcp = tool(async () => {
        calls++
        return calls === 1
          ? { isError: true, content: [{ type: "text", text: "failed" }] }
          : { content: [{ type: "text", text: "{}" }] }
      })
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
      yield* hooks.trigger(preTool, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
      expect(calls).toBe(2)
    }),
  )

  it.instance("an async once hook retries after failure and retires after success", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      const attempts = path.join(instance.directory, "async-once-attempts")
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin: "skill:/review-async/SKILL.md",
        hooks: {
          PreToolUse: [
            {
              once: true,
              hooks: [
                {
                  type: "command",
                  command: `printf x >> ${quote(attempts)}; test $(wc -c < ${quote(attempts)}) -gt 1`,
                  async: true,
                },
              ],
            },
          ],
        },
      })
      const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
      yield* run()
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .readFile(attempts, "utf8")
            .then((text) => (text === "x" ? true : undefined))
            .catch(() => undefined),
        ),
        "first async hook did not start",
      )
      yield* pollWithTimeout(
        run().pipe(
          Effect.flatMap(() => store.list(sessionID, "PreToolUse")),
          Effect.map((entries) => (entries.length === 0 ? true : undefined)),
        ),
        "failed async once did not retry and retire",
      )
      yield* run()
      expect(yield* Effect.promise(() => fs.readFile(attempts, "utf8"))).toBe("xx")
    }),
  )

  it.instance("clearing a session cancels its async hook and permits a fresh registration", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const hooks = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const started = path.join(instance.directory, "async-once-started")
      const first = {
        kind: "skill" as const,
        origin: "skill:/review-async-cancel/SKILL.md",
        hooks: {
          PreToolUse: [
            {
              once: true,
              hooks: [{ type: "command", command: `printf x >> ${quote(started)}; sleep 30`, async: true }],
            },
          ],
        },
      }
      yield* hooks.registerScoped!(sessionID, first)
      const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
      yield* run()
      yield* pollWithTimeout(
        Effect.promise(() =>
          Bun.file(started)
            .exists()
            .then((exists) => (exists ? true : undefined)),
        ),
        "async command did not start",
      )
      yield* hooks.clearSession!(sessionID)
      yield* hooks.registerScoped!(sessionID, {
        ...first,
        hooks: {
          PreToolUse: [
            { once: true, hooks: [{ type: "command", command: `printf y >> ${quote(started)}`, async: true }] },
          ],
        },
      })
      yield* run()
      yield* pollWithTimeout(
        Effect.promise(() => fs.readFile(started, "utf8").then((text) => (text === "xy" ? true : undefined))),
        "new async once did not run",
      )
    }),
  )

  for (const placement of ["handler", "group"] as const) {
    raceIt.instance(`a completed async ${placement} once hook cannot release a later run`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const hooks = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        const counter = path.join(instance.directory, `late-finalizer-${placement}`)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        rewakeGates.set(sessionID, { entered, release })
        const script = `const fs=require("node:fs");const file=${JSON.stringify(counter)};let n=0;try{n=Number(fs.readFileSync(file,"utf8"))}catch{};n++;fs.writeFileSync(file,String(n));if(n===1){console.error("retry");process.exit(2)}setTimeout(()=>process.exit(0),10000)`
        const command = { type: "command" as const, command: process.execPath, args: ["-e", script], asyncRewake: true }
        yield* hooks.registerScoped!(sessionID, {
          kind: "skill",
          origin: `skill:/review-late-finalizer-${placement}/SKILL.md`,
          hooks: {
            PreToolUse: [
              {
                ...(placement === "group" ? { once: true } : {}),
                hooks: [{ ...command, ...(placement === "handler" ? { once: true } : {}) }],
              },
            ],
          },
        })
        const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
        yield* run()
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .readFile(counter, "utf8")
              .then((value) => (value === "1" ? true : undefined))
              .catch(() => undefined),
          ),
          "first async once execution did not start",
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"))
        yield* run()
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .readFile(counter, "utf8")
              .then((value) => (value === "2" ? true : undefined))
              .catch(() => undefined),
          ),
          "second async once execution did not start",
        )
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("100 millis")
        yield* run()
        yield* Effect.sleep("300 millis")
        expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("2")
        yield* hooks.clearSession!(sessionID)
        rewakeGates.delete(sessionID)
      }),
    )
  }

  for (const slowSucceeds of [false, true]) {
    raceIt.instance(`a once group waits for every async handler; slow success=${slowSucceeds}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const sessionID = SessionID.descending()
        const fastCount = path.join(instance.directory, `group-fast-${slowSucceeds}`)
        const slowCount = path.join(instance.directory, `group-slow-${slowSucceeds}`)
        const releaseSlow = path.join(instance.directory, `group-release-${slowSucceeds}`)
        const entered = yield* Deferred.make<void>()
        const releaseRewake = yield* Deferred.make<void>()
        rewakeGates.set(sessionID, { entered, release: releaseRewake })
        yield* hooks.registerScoped!(sessionID, {
          kind: "skill",
          origin: `skill:/group-async-${slowSucceeds}/SKILL.md`,
          hooks: {
            PreToolUse: [
              {
                once: true,
                hooks: [
                  {
                    type: "command",
                    command: `printf x >> ${quote(fastCount)}; echo retry >&2; exit 2`,
                    asyncRewake: true,
                  },
                  {
                    type: "command",
                    command: `printf x >> ${quote(slowCount)}; while [ ! -f ${quote(releaseSlow)} ]; do sleep 0.01; done; exit ${slowSucceeds ? 0 : 1}`,
                    async: true,
                  },
                ],
              },
            ],
          },
        })
        const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
        yield* run()
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .readFile(slowCount, "utf8")
              .then((text) => (text === "x" ? true : undefined))
              .catch(() => undefined),
          ),
          "slow grouped hook did not start",
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"))
        const entry = (yield* store.list(sessionID, "PreToolUse"))[0]
        if (!entry) throw new Error("once group disappeared before all handlers settled")
        expect(yield* store.claim(sessionID, entry.id)).toBeUndefined()
        yield* run()
        yield* Effect.promise(() => fs.writeFile(releaseSlow, "go"))
        yield* Deferred.succeed(releaseRewake, undefined)
        rewakeGates.delete(sessionID)
        if (slowSucceeds) {
          yield* pollWithTimeout(
            store.list(sessionID, "PreToolUse").pipe(Effect.map((items) => (items.length === 0 ? true : undefined))),
            "successful once group was not consumed after all handlers settled",
          )
          yield* run()
          expect(yield* Effect.promise(() => fs.readFile(slowCount, "utf8"))).toBe("x")
        } else {
          const token = yield* pollWithTimeout(
            store.claim(sessionID, entry.id),
            "all-failed once group did not release its claim",
          )
          yield* store.complete(sessionID, entry.id, token, false)
          expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(1)
          yield* run()
          yield* pollWithTimeout(
            Effect.promise(() =>
              fs
                .readFile(slowCount, "utf8")
                .then((text) => (text === "xx" ? true : undefined))
                .catch(() => undefined),
            ),
            "all-failed once group did not retry",
          )
        }
        if (!slowSucceeds)
          yield* pollWithTimeout(
            Effect.promise(() =>
              fs
                .readFile(fastCount, "utf8")
                .then((text) => (text === "xx" ? true : undefined))
                .catch(() => undefined),
            ),
            "all-failed group's fast handler did not retry",
          )
        expect(yield* Effect.promise(() => fs.readFile(fastCount, "utf8"))).toBe(slowSucceeds ? "x" : "xx")
        yield* hooks.clearSession!(sessionID)
      }),
    )
  }

  for (const foregroundSucceeds of [false, true]) {
    it.instance(`mixed once group waits for async settlement; foreground success=${foregroundSucceeds}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const sessionID = SessionID.descending()
        const foreground = path.join(instance.directory, `mixed-foreground-${foregroundSucceeds}`)
        const background = path.join(instance.directory, `mixed-background-${foregroundSucceeds}`)
        const release = path.join(instance.directory, `mixed-release-${foregroundSucceeds}`)
        yield* hooks.registerScoped!(sessionID, {
          kind: "skill",
          origin: `skill:/mixed-once-${foregroundSucceeds}/SKILL.md`,
          hooks: {
            PreToolUse: [
              {
                once: true,
                hooks: [
                  {
                    type: "command",
                    command: `printf x >> ${quote(foreground)}; exit ${foregroundSucceeds ? 0 : 1}`,
                  },
                  {
                    type: "command",
                    command: `printf x >> ${quote(background)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; exit ${foregroundSucceeds ? 1 : 0}`,
                    async: true,
                  },
                ],
              },
            ],
          },
        })
        const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
        yield* run()
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .readFile(background, "utf8")
              .then((text) => (text === "x" ? true : undefined))
              .catch(() => undefined),
          ),
          "mixed group's async handler did not start",
        )
        const entry = (yield* store.list(sessionID, "PreToolUse"))[0]
        if (!entry) throw new Error("mixed once group disappeared before background settled")
        expect(yield* store.claim(sessionID, entry.id)).toBeUndefined()
        yield* run()
        yield* Effect.promise(() => fs.writeFile(release, "go"))
        yield* pollWithTimeout(
          store.list(sessionID, "PreToolUse").pipe(Effect.map((items) => (items.length === 0 ? true : undefined))),
          "mixed once group did not retire after its successful handler",
        )
        yield* run()
        expect(yield* Effect.promise(() => fs.readFile(foreground, "utf8"))).toBe("x")
        expect(yield* Effect.promise(() => fs.readFile(background, "utf8"))).toBe("x")
      }),
    )
  }

  it.instance("clearing a running multi-handler once group cannot release a replacement claim", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      const counter = path.join(instance.directory, "group-clear-counter")
      const origin = "skill:/group-clear/SKILL.md"
      const slow = (mark: string) => ({
        type: "command" as const,
        command: `printf ${mark} >> ${quote(counter)}; sleep 30`,
        async: true,
      })
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin,
        hooks: { PreToolUse: [{ once: true, hooks: [slow("a"), slow("b")] }] },
      })
      const run = () => hooks.trigger(preTool, { sessionID, transcriptPath: "" })
      yield* run()
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .readFile(counter, "utf8")
            .then((text) => (text.length === 2 ? true : undefined))
            .catch(() => undefined),
        ),
        "both grouped handlers did not start",
      )
      yield* hooks.clearSession!(sessionID)
      expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(0)
      yield* hooks.registerScoped!(sessionID, {
        kind: "skill",
        origin,
        hooks: {
          PreToolUse: [{ once: true, hooks: [{ type: "command", command: `printf z >> ${quote(counter)}` }] }],
        },
      })
      yield* run()
      expect(yield* store.list(sessionID, "PreToolUse")).toHaveLength(0)
      const text = yield* Effect.promise(() => fs.readFile(counter, "utf8"))
      expect(text).toHaveLength(3)
      expect(text).toContain("z")
    }),
  )

  it.instance("MCP plain text reaches prompt context, later session start, and model switch", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const mcp = tool(async () => ({ content: [{ type: "text", text: "MCP_PLAIN_CONTEXT" }] }))
      for (const event of [
        "UserPromptSubmit",
        "SessionStart:clear",
        "SessionStart:compact",
        "PostModelSwitch",
      ] as const) {
        const sessionID = SessionID.descending()
        const name =
          event === "UserPromptSubmit"
            ? "UserPromptSubmit"
            : event === "PostModelSwitch"
              ? "PostModelSwitch"
              : "SessionStart"
        yield* store.add(sessionID, { event: name, hooks: [{ type: "mcp_tool", server: "test", tool: "check" }] })
        const payload =
          event === "UserPromptSubmit"
            ? { event: "UserPromptSubmit" as const, prompt: "hello" }
            : event === "PostModelSwitch"
              ? { event: "PostModelSwitch" as const, fromModel: "a", toModel: "b" }
              : {
                  event: "SessionStart" as const,
                  source: event.endsWith("compact") ? ("compact" as const) : ("clear" as const),
                }
        const result = yield* hooks.trigger(payload, { sessionID, transcriptPath: "" }).pipe(Effect.provide(mcp))
        expect(result.additionalContexts).toEqual(["MCP_PLAIN_CONTEXT"])
      }
    }),
  )

  it.instance("WorktreeCreate reads an MCP text path as stdout", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "WorktreeCreate",
        hooks: [{ type: "mcp_tool", server: "test", tool: "check" }],
      })
      const mcp = tool(async () => ({ content: [{ type: "text", text: process.cwd() }] }))
      const result = yield* hooks
        .trigger({ event: "WorktreeCreate", name: "test" }, { sessionID, transcriptPath: "" })
        .pipe(Effect.provide(mcp))
      expect(result.worktreePath).toBe(process.cwd())
      expect(result.blocked).toBeUndefined()
    }),
  )
})
