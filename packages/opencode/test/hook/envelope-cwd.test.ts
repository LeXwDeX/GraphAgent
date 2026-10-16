import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { nativeHookCommand } from "../fixture/claude-hook"

const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

const EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"] as const

const payloadFor = (event: (typeof EVENTS)[number], toolName: string, toolInput: Record<string, unknown>) => {
  const base = { toolName, toolInput }
  if (event === "PostToolUse") return { ...base, event, toolResponse: "ok" } satisfies HookPayload
  if (event === "PostToolUseFailure") return { ...base, event, error: "failed" } satisfies HookPayload
  if (event === "PermissionDenied") return { ...base, event, reason: "denied" } satisfies HookPayload
  return { ...base, event } satisfies HookPayload
}

// Registers a native-format and a claude-code-format command hook, triggers the payload and
// returns the envelope each of them received on stdin.
const capture = (payload: HookPayload) =>
  Effect.gen(function* () {
    const hooks = yield* SettingsHook.Service
    const store = yield* SessionHooks.Service
    const id = SessionID.descending()
    yield* store.add(id, {
      event: payload.event,
      matcher: "*",
      hooks: [
        { type: "command", command: nativeHookCommand },
        { type: "command", command: nativeHookCommand + " # claude", inputFormat: "claude-code" },
      ],
    })
    const result = yield* hooks.trigger(payload, { sessionID: id, transcriptPath: "" })
    // Identical envelopes (same tool name casing, same cwd) are deduplicated into one context.
    expect(result.additionalContexts.length).toBeGreaterThan(0)
    return result.additionalContexts.map((text) => JSON.parse(text.slice("NATIVE_CONTEXT:".length)))
  })

describe("hook envelope cwd follows bash workdir", () => {
  for (const event of EVENTS) {
    it.instance(`${event}: absolute bash workdir becomes envelope cwd for every input format`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const workdir = path.join(test.directory, "sub", "deeper")
        const envelopes = yield* capture(payloadFor(event, "bash", { command: "ls", workdir }))
        for (const envelope of envelopes) {
          expect(envelope.cwd).toBe(workdir)
          expect(envelope.tool_input.workdir).toBe(workdir)
        }
        expect(envelopes.map((e) => e.tool_name)).toEqual(["bash", "Bash"])
      }),
    )
  }

  it.instance("relative workdir resolves against the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const envelopes = yield* capture(payloadFor("PreToolUse", "bash", { command: "ls", workdir: "pkg/../sub" }))
      for (const envelope of envelopes) {
        expect(envelope.cwd).toBe(path.join(test.directory, "sub"))
        expect(envelope.tool_input.workdir).toBe("pkg/../sub")
      }
    }),
  )

  it.instance("Claude-style tool name Bash also follows workdir", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workdir = path.join(test.directory, "sub")
      const envelopes = yield* capture(payloadFor("PreToolUse", "Bash", { command: "ls", workdir }))
      for (const envelope of envelopes) expect(envelope.cwd).toBe(workdir)
    }),
  )

  it.instance("bash without workdir keeps the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (const toolInput of [{ command: "ls" }, { command: "ls", workdir: "" }, { command: "ls", workdir: 5 }]) {
        const envelopes = yield* capture(payloadFor("PreToolUse", "bash", toolInput))
        for (const envelope of envelopes) expect(envelope.cwd).toBe(test.directory)
      }
    }),
  )

  it.instance("non-bash tools keep the instance directory even with a workdir field", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workdir = path.join(test.directory, "sub")
      const envelopes = yield* capture(payloadFor("PreToolUse", "read", { filePath: "a.ts", workdir }))
      for (const envelope of envelopes) expect(envelope.cwd).toBe(test.directory)
    }),
  )

  it.instance("non-tool events keep the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, { event: "UserPromptSubmit", hooks: [{ type: "command", command: nativeHookCommand }] })
      const result = yield* hooks.trigger({ event: "UserPromptSubmit", prompt: "hi" }, { sessionID: id, transcriptPath: "" })
      expect(JSON.parse(result.additionalContexts[0].slice("NATIVE_CONTEXT:".length)).cwd).toBe(test.directory)
    }),
  )
})
