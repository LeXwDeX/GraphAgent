import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// D2 (hooks-goal-completeness): session-scoped hooks registered via
// SessionHooks.add (the in-memory store the HTTP API now feeds) participate in
// the SettingsHook.trigger pipeline identically to on-disk hooks. Covers the
// producer-side behaviors the route contract relies on:
//   register → fires on matching event
//   once:true → fires once then auto-removes
//   SessionEnd → clears the session's hook store

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

const CTX = "session-hook-fired-ctx"

describe("SessionHooks → SettingsHook.trigger integration (D2)", () => {
  it.instance("registered hook fires on the matching event", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* sessionHooks.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [{ type: "command", command: `printf '%s' '${CTX}'` }],
      })
      const r = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "hi" },
        { sessionID, transcriptPath: "" },
      )
      expect(r.additionalContexts).toContain(CTX)
    }),
  )

  it.instance("once:true hook fires once then is auto-removed", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* sessionHooks.add(sessionID, {
        event: "UserPromptSubmit",
        once: true,
        hooks: [{ type: "command", command: `printf '%s' '${CTX}'` }],
      })

      const r1 = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "first" },
        { sessionID, transcriptPath: "" },
      )
      expect(r1.additionalContexts).toContain(CTX)
      // Auto-removed after its first execution (trigger's once-cleanup path).
      expect(yield* sessionHooks.list(sessionID, "UserPromptSubmit")).toHaveLength(0)

      const r2 = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "second" },
        { sessionID, transcriptPath: "" },
      )
      expect(r2.additionalContexts).not.toContain(CTX)
    }),
  )

  it.instance("SessionEnd clears the session hook store", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* sessionHooks.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [{ type: "command", command: `printf '%s' '${CTX}'` }],
      })
      expect((yield* sessionHooks.listAll(sessionID)).length).toBe(1)

      yield* hook.trigger({ event: "SessionEnd", reason: "delete" }, { sessionID, transcriptPath: "" })

      expect((yield* sessionHooks.listAll(sessionID)).length).toBe(0)
    }),
  )
})
