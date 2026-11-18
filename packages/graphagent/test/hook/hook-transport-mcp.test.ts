// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { jsonSchema, tool } from "ai"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
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
        hooks: [
          {
            type: "mcp_tool",
            server: "audit",
            tool: "check",
            inputFormat: "claude-code",
            input: { path: "${tool_input.file_path}" },
          },
        ],
      })
      const result = yield* hook
        .trigger(
          { event: "PreToolUse", toolName: "read", toolInput: { filePath: "/tmp/fixture.txt" } },
          { sessionID, transcript: () => Effect.succeed("") },
        )
        .pipe(Effect.provide(mcp))
      expect(input).toEqual({ path: "/tmp/fixture.txt" })
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toBe("fixture")
    }),
  )

  it.instance("reads structuredContent as one JSON line when the server also returns text", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      // The real tool conversion over a client that answers with readable text and the decision as structuredContent.
      const client = Object.assign(Object.create(null), {
        callTool: async () => ({
          content: [{ type: "text", text: "A readable summary that is not JSON" }],
          structuredContent: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "from structuredContent",
            },
          },
        }),
      })
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: McpCatalog.convertTool(
              { name: "check", inputSchema: { type: "object", properties: {} } },
              client,
              undefined,
              "audit",
            ),
          }),
      })
      yield* store.add(sessionID, {
        event: "PreToolUse",
        hooks: [{ type: "mcp_tool", server: "audit", tool: "check" }],
      })
      const result = yield* hook
        .trigger(
          { event: "PreToolUse", toolName: "read", toolInput: {} },
          { sessionID, transcript: () => Effect.succeed("") },
        )
        .pipe(Effect.provide(mcp))
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toBe("from structuredContent")
    }),
  )

  // A server tool that records its call and answers with a hook decision that names it.
  const answering = (called: string[], server: string, name: string) =>
    McpCatalog.bindTool(
      tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          called.push(`${server}/${name}`)
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `${server}/${name}`,
                  },
                }),
              },
            ],
          }
        },
      }),
      { server, tool: name, source: "unknown" },
    )

  // What the `mcp_tool` hook of `server` and `name` decides, over a service that hands out `registry`.
  const decide = (registry: Record<string, ReturnType<typeof answering>>, server: string, name: string) =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, { event: "PreToolUse", hooks: [{ type: "mcp_tool", server, tool: name }] })
      return yield* hook
        .trigger(
          { event: "PreToolUse", toolName: "read", toolInput: {} },
          { sessionID, transcript: () => Effect.succeed("") },
        )
        .pipe(Effect.provide(Layer.mock(MCP.Service, { tools: () => Effect.succeed(registry) })))
    })

  it.instance("finds the tool a hook names by its binding when two tools share one sanitized key", () =>
    Effect.gen(function* () {
      const called: string[] = []
      // Server `a.b`'s `c` and server `a`'s `b.c` both sanitize to `a_b_c`, so the service hands them out under
      // keys that carry a hash suffix: neither can be rebuilt from the names in the hook.
      const registry = {
        a_b_c_1a2b3c4d: answering(called, "a.b", "c"),
        a_b_c_5e6f7a8b: answering(called, "a", "b.c"),
      }

      const dotted = yield* decide(registry, "a.b", "c")
      expect(called).toEqual(["a.b/c"])
      expect(dotted.permissionDecisionReason).toBe("a.b/c")

      const other = yield* decide(registry, "a", "b.c")
      expect(called).toEqual(["a.b/c", "a/b.c"])
      expect(other.permissionDecisionReason).toBe("a/b.c")
    }),
  )

  it.instance("calls only the server a hook names when another server's name sanitizes to the same", () =>
    Effect.gen(function* () {
      const called: string[] = []
      // `a:b` and `a_b` both read `a_b` once `:` is replaced; both have a `check`. `a:b` comes first.
      const registry = {
        a_b_check_1111aaaa: answering(called, "a:b", "check"),
        a_b_check_2222bbbb: answering(called, "a_b", "check"),
      }

      const underscored = yield* decide(registry, "a_b", "check")
      expect(called).toEqual(["a_b/check"])
      expect(underscored.permissionDecisionReason).toBe("a_b/check")

      const colon = yield* decide(registry, "a:b", "check")
      expect(called).toEqual(["a_b/check", "a:b/check"])
      expect(colon.permissionDecisionReason).toBe("a:b/check")
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
        .trigger(
          { event: "PreToolUse", toolName: "Read", toolInput: {} },
          { sessionID, transcript: () => Effect.succeed("") },
        )
        .pipe(Effect.provide(mcp))
      expect(result.blocked).toBeUndefined()
    }),
  )
})
