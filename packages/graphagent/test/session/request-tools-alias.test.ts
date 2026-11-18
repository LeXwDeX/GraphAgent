// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent and user fixtures use `as never`.
import { describe, expect, test } from "bun:test"
import { dynamicTool, jsonSchema } from "ai"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"
import { LLMRequestPrep } from "@/session/llm/request"

/**
 * #1459: the tools of a request are filtered once more by the deny rules of the agent and the session. A rewritten MCP
 * key (`srv_call_1a2b3c4d`, once `srv_call`) is also removed by a deny written for the key it had before.
 */

const remote = (tool: string, baseKey?: string) =>
  McpCatalog.bindTool(
    dynamicTool({
      description: `remote ${tool}`,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ content: [] }),
    }),
    { server: "srv", tool, source: "unknown", ...(baseKey === undefined ? {} : { baseKey }) },
  )

const rule = (permission: string, action: PermissionV1.Rule["action"]): PermissionV1.Rule => ({
  permission,
  pattern: "*",
  action,
})

const keys = (agent: PermissionV1.Ruleset, session?: PermissionV1.Ruleset, native?: PermissionV1.Ruleset) =>
  Object.keys(
    LLMRequestPrep.resolveTools({
      tools: { srv_call_1a2b3c4d: remote("call", "srv_call"), srv_plain: remote("plain"), srv_other: remote("other") },
      agent: { permission: agent } as never,
      permission: session,
      nativePermission: native,
      user: {} as never,
    }),
  ).toSorted()

describe("LLMRequestPrep.resolveTools with a rewritten MCP key", () => {
  test("a deny written for the key it had before removes the tool, from the agent, the session or the native rules", () => {
    const all = ["srv_call_1a2b3c4d", "srv_other", "srv_plain"]
    expect(keys([])).toEqual(all)
    expect(keys([rule("*", "allow"), rule("srv_call", "deny")])).toEqual(["srv_other", "srv_plain"])
    expect(keys([rule("*", "allow")], [rule("srv_call", "deny")])).toEqual(["srv_other", "srv_plain"])
    expect(keys([rule("*", "allow")], [], [rule("srv_call", "deny")])).toEqual(["srv_other", "srv_plain"])
  })

  test("an ask, an allow, a later allow and a rule about another key leave it in", () => {
    const all = ["srv_call_1a2b3c4d", "srv_other", "srv_plain"]
    expect(keys([rule("*", "allow"), rule("srv_call", "ask")])).toEqual(all)
    expect(keys([rule("*", "allow"), rule("srv_call", "allow")])).toEqual(all)
    expect(keys([rule("srv_call", "deny"), rule("srv_call", "allow")])).toEqual(all)
    expect(keys([rule("*", "allow"), rule("srv_gone", "deny")])).toEqual(all)
  })

  test("a deny of its own key or of a plain key works as before", () => {
    expect(keys([rule("*", "allow"), rule("srv_call_1a2b3c4d", "deny")])).toEqual(["srv_other", "srv_plain"])
    expect(keys([rule("*", "allow"), rule("srv_plain", "deny")])).toEqual(["srv_call_1a2b3c4d", "srv_other"])
    expect(keys([rule("*", "deny"), rule("srv_plain", "allow")])).toEqual(["srv_plain"])
  })
})
