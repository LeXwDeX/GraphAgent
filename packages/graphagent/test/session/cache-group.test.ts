// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { CacheGroup } from "@/session/llm/cache-group"

const agent = { name: "build", prompt: "You are a builder." }
const system = ["shared system", "shared rules"]
const tools: Record<string, unknown> = {
  read: {
    description: "Read a file",
    inputSchema: { jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
  },
}

type Overrides = {
  readonly agent?: { readonly name: string; readonly prompt?: string }
  readonly system?: readonly string[]
  readonly tools?: Record<string, unknown>
}

const input = (overrides: Overrides = {}) => ({ agent, system, tools, ...overrides })

describe("CacheGroup.cacheGroupOf", () => {
  test("ignores the session id and node-specific user system fragments", () => {
    const first = { ...input(), sessionID: "session-a", user: { system: "<dag-node-a>" } }
    const second = { ...input(), sessionID: "session-b", user: { system: "<dag-node-b>" } }
    expect(CacheGroup.cacheGroupOf(first)).toBe(CacheGroup.cacheGroupOf(second))
  })

  test("changes with the agent name or prompt", () => {
    const base = CacheGroup.cacheGroupOf(input())
    expect(CacheGroup.cacheGroupOf(input({ agent: { name: "plan", prompt: agent.prompt } }))).not.toBe(base)
    expect(CacheGroup.cacheGroupOf(input({ agent: { name: agent.name, prompt: "A different role." } }))).not.toBe(base)
  })

  test("changes with any system fragment", () => {
    const base = CacheGroup.cacheGroupOf(input())
    expect(CacheGroup.cacheGroupOf(input({ system: ["shared system", "shared rules", "extra"] }))).not.toBe(base)
    expect(CacheGroup.cacheGroupOf(input({ system: ["shared rules", "shared system"] }))).not.toBe(base)
    expect(CacheGroup.cacheGroupOf(input({ system: ["shared system", "changed rules"] }))).not.toBe(base)
  })

  test("changes with a tool schema", () => {
    const base = CacheGroup.cacheGroupOf(input())
    const changed = input({
      tools: {
        read: {
          description: "Read a file",
          inputSchema: { jsonSchema: { type: "object", properties: { path: { type: "number" } } } },
        },
      },
    })
    expect(CacheGroup.cacheGroupOf(changed)).not.toBe(base)
  })

  test("returns a prompt_cache_key within the provider limit", () => {
    const key = CacheGroup.cacheGroupOf(input())
    expect(key.startsWith("cg_")).toBe(true)
    expect(key).toHaveLength(51)
    expect(key.length).toBeLessThanOrEqual(64)
  })
})
