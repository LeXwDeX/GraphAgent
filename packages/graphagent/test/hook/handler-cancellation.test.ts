import { expect, describe } from "bun:test"
import { Effect, Layer } from "effect"
import { MockLanguageModelV3 } from "ai/test"
import { SettingsHook, type HookCommand } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { Auth } from "@/auth"
import { MCP } from "@/mcp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { applyPreHookDecision } from "@/hook/pre-hook-decision"
import { testEffect } from "../lib/effect"

const base = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(Layer.mergeAll(base, CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))
type RunEvent =
  "PreToolUse" | "PostToolUse" | "PermissionRequest" | "PermissionDenied" | "TaskCreated" | "TaskCompleted"
const run = (entry: HookCommand, event: RunEvent = "PreToolUse") =>
  Effect.gen(function* () {
    const store = yield* SessionHooks.Service
    const settings = yield* SettingsHook.Service
    const id = SessionID.descending()
    yield* store.add(id, { event, hooks: [entry] })
    const payload =
      event === "TaskCreated" || event === "TaskCompleted"
        ? { event, taskID: "task-1", taskTitle: "audit task" }
        : { event, toolName: "bash", toolInput: {}, ...(event === "PostToolUse" ? { toolResponse: "done" } : {}) }
    return yield* settings.trigger(payload as any, { sessionID: id, transcriptPath: "" })
  })
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const generated = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
})
const providerLayer = (language: any) =>
  Layer.mergeAll(
    Layer.mock(Provider.Service, {
      defaultModel: () => Effect.succeed({ providerID: "audit" as any, modelID: "test" as any }),
      getModel: () => Effect.succeed(ProviderTest.model()),
      getLanguage: () => Effect.succeed(language),
    }),
    Layer.mock(Auth.Service, { get: () => Effect.succeed({ type: "api", key: "test-only" } as any) }),
  )

describe("hook handlers through real AI SDK and MCP invocation adapter", () => {
  it.instance("prompt PreToolUse rejection stops the turn and denies the tool by default", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: generated(JSON.stringify({ ok: false, reason: "prompt-real-handler" })),
      })
      const result = yield* run({ type: "prompt", prompt: "audit decision" }).pipe(Effect.provide(providerLayer(model)))
      expect(result.permissionDecision).toBe("deny")
      expect(result.preventContinuation).toBe(true)
      expect(result.stopReason).toBe("prompt-real-handler")
      expect(result.systemMessages).toContain("prompt-real-handler")
      expect(applyPreHookDecision({ command: "unsafe" }, result).stopReason).toBe("prompt-real-handler")
    }),
  )

  it.instance("prompt continueOnBlock denies only the tool and returns feedback", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: generated(JSON.stringify({ ok: false, reason: "adjust input" })),
      })
      const result = yield* run({ type: "prompt", prompt: "audit decision", continueOnBlock: true }).pipe(
        Effect.provide(providerLayer(model)),
      )
      expect(result.preventContinuation).toBeUndefined()
      expect(applyPreHookDecision({ command: "unsafe" }, result).deniedReason).toBe("adjust input")
    }),
  )

  it.instance("agent PreToolUse rejection denies the tool and continues", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: {
          content: [
            {
              type: "tool-call",
              toolCallId: "audit-output",
              toolName: "synthetic_output",
              input: JSON.stringify({ ok: false, reason: "agent-real-handler" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        },
      })
      const result = yield* run({ type: "agent", prompt: "emit audit decision" }).pipe(
        Effect.provide(providerLayer(model)),
      )
      expect(result.preventContinuation).toBeUndefined()
      expect(applyPreHookDecision({ command: "unsafe" }, result).deniedReason).toBe("agent-real-handler")
    }),
  )

  it.instance("prompt PostToolUse default stops while continueOnBlock feeds back", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: generated(JSON.stringify({ ok: false, reason: "post-check failed" })),
      })
      const stop = yield* run({ type: "prompt", prompt: "audit post" }, "PostToolUse").pipe(
        Effect.provide(providerLayer(model)),
      )
      const retry = yield* run({ type: "prompt", prompt: "audit post", continueOnBlock: true }, "PostToolUse").pipe(
        Effect.provide(providerLayer(model)),
      )
      expect(stop.preventContinuation).toBe(true)
      expect(stop.systemMessages).toContain("post-check failed")
      expect(retry.preventContinuation).toBeUndefined()
      expect(retry.additionalContexts).toEqual(["post-check failed"])
    }),
  )

  // The reference returns a TaskCreated/TaskCompleted veto as a tool error, so
  // the task write is refused and the reason reaches the model; only a
  // systemMessage would be user-visible and the write would still happen.
  // The turn itself keeps running (no continue:false).
  it.instance("prompt TaskCreated/TaskCompleted rejection blocks the write and keeps the turn running", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: generated(JSON.stringify({ ok: false, reason: "task veto" })),
      })
      for (const event of ["TaskCreated", "TaskCompleted"] as const) {
        const result = yield* run({ type: "prompt", prompt: "audit task" }, event).pipe(
          Effect.provide(providerLayer(model)),
        )
        expect(result.blocked?.reason).toBe("task veto")
        expect(result.preventContinuation).toBeUndefined()
      }
    }),
  )

  it.instance("prompt PermissionRequest and PermissionDenied outputs are discarded", () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV3({
        doGenerate: generated(JSON.stringify({ ok: false, reason: "cannot override permission" })),
      })
      for (const event of ["PermissionRequest", "PermissionDenied"] as const) {
        const result = yield* run({ type: "prompt", prompt: "audit permission" }, event).pipe(
          Effect.provide(providerLayer(model)),
        )
        expect(result.blocked).toBeUndefined()
        expect(result.preventContinuation).toBeUndefined()
        expect(result.permissionRequestDecision).toBeUndefined()
        expect(result.additionalContexts).toEqual([])
      }
    }),
  )

  it.instance("mcp handler maps its tool name and accepts the decision", () =>
    Effect.gen(function* () {
      let envelope: any
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: {
              execute: async (input: any) => {
                envelope = input
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse",
                          permissionDecision: "deny",
                          permissionDecisionReason: "mcp-real-handler",
                        },
                      }),
                    },
                  ],
                }
              },
            },
          } as any),
      })
      const result = yield* run({ type: "mcp", command: "mcp__audit__check" }).pipe(Effect.provide(mcp))
      expect(envelope.hook_event_name).toBe("PreToolUse")
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toBe("mcp-real-handler")
    }),
  )

  it.instance("prompt timeout must abort the underlying model request", () =>
    Effect.gen(function* () {
      let release!: () => void
      let signal: AbortSignal | undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      const model = new MockLanguageModelV3({
        doGenerate: async (input) => {
          signal = input.abortSignal
          await gate
          return generated("{}")
        },
      })
      const result = yield* run({ type: "prompt", prompt: "audit timeout", timeout: 0.03 }).pipe(
        Effect.provide(providerLayer(model)),
      )
      const aborted = signal?.aborted ?? false
      release()
      expect(result.blocked).toBeUndefined()
      expect(model.doGenerateCalls.length).toBe(1)
      expect(aborted).toBe(true)
    }),
  )

  it.instance("mcp timeout must abort the underlying tool request", () =>
    Effect.gen(function* () {
      let release!: () => void
      let signal: AbortSignal | undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: {
              execute: async (_input: any, options: any) => {
                signal = options.abortSignal
                await gate
                return { content: [] }
              },
            },
          } as any),
      })
      const result = yield* run({ type: "mcp", command: "mcp__audit__check", timeout: 0.03 }).pipe(Effect.provide(mcp))
      const aborted = signal?.aborted ?? false
      release()
      expect(result.blocked).toBeUndefined()
      expect(signal).toBeDefined()
      expect(aborted).toBe(true)
    }),
  )
})
