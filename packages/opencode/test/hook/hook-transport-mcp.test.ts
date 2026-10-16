import { jsonSchema, tool } from "ai"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { MCP } from "@/mcp"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(layer)

describe("official MCP tool hook transport", () => {
  it.instance("substitutes the event input and applies text JSON output", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let input: unknown
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: tool({
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async (args: unknown) => {
                input = args
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse",
                          permissionDecision: "deny",
                          permissionDecisionReason: "fixture",
                        },
                      }),
                    },
                  ],
                }
              },
            }),
          }),
      })
      yield* store.add(sessionID, {
        event: "PreToolUse",
        hooks: [{ type: "mcp_tool", server: "audit", tool: "check", input: { path: "${tool_input.file_path}" } }],
      })
      const result = yield* hook
        .trigger(
          { event: "PreToolUse", toolName: "Read", toolInput: { file_path: "/tmp/fixture.txt" } },
          { sessionID, transcriptPath: "" },
        )
        .pipe(Effect.provide(mcp))
      expect(input).toEqual({ path: "/tmp/fixture.txt" })
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toBe("fixture")
    }),
  )

  it.instance("does not turn an MCP isError result into a hook decision", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: tool({
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => ({
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ decision: "block", reason: "ignore me" }) }],
              }),
            }),
          }),
      })
      yield* store.add(sessionID, {
        event: "PreToolUse",
        hooks: [{ type: "mcp_tool", server: "audit", tool: "check" }],
      })
      const result = yield* hook
        .trigger({ event: "PreToolUse", toolName: "Read", toolInput: {} }, { sessionID, transcriptPath: "" })
        .pipe(Effect.provide(mcp))
      expect(result.blocked).toBeUndefined()
    }),
  )
})
