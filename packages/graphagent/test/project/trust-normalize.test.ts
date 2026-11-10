// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { canonicalJSON, canonicalize, CATEGORY_FIELDS, TRUST_CATEGORIES } from "@/project/trust"

const fields = (category: (typeof TRUST_CATEGORIES)[number]) => CATEGORY_FIELDS[category].map((spec) => spec.field)

const HOOK_FIELDS = [
  "type",
  "event",
  "matcher",
  "command",
  "args",
  "server",
  "tool",
  "input",
  "url",
  "prompt",
  "headers",
  "allowedEnvVars",
  "timeout",
  "onFailure",
  "continueOnBlock",
  "model",
  "shell",
  "inputFormat",
  "if",
  "async",
  "asyncRewake",
  "options",
]

describe("per-category field lists", () => {
  test("hook-derived categories list execution fields explicitly", () => {
    expect(fields("hook")).toEqual(HOOK_FIELDS)
    expect(fields("skill-hook")).toEqual(HOOK_FIELDS)
    expect(fields("agent-hook")).toEqual([...HOOK_FIELDS, "agent"])
  })

  test("non-hook categories list their execution fields", () => {
    expect(fields("mcp")).toEqual(["type", "command", "cwd", "environment", "url", "headers", "timeout", "disabled"])
    expect(fields("command-shell")).toEqual(["command"])
    expect(fields("formatter")).toEqual(["command", "environment", "disabled"])
    expect(fields("lsp")).toEqual(["command", "env", "disabled"])
  })

  test("display-only and loader fields never enter a canonical entry", () => {
    const canonical = canonicalize("hook", {
      type: "command",
      command: "echo hi",
      statusMessage: "working",
      once: true,
      __source: { scope: "project", file: "/x/.agents/hooks.json" },
    })
    expect(canonical).toEqual({ type: "command", command: "echo hi" })
  })
})

describe("canonicalization", () => {
  test("key order does not affect the canonical JSON", () => {
    const first = canonicalize("hook", {
      type: "command",
      command: "echo hi",
      event: "Stop",
      matcher: "*",
      headers: { B: "2", A: "1" },
    })
    const second = canonicalize("hook", {
      headers: { A: "1", B: "2" },
      matcher: "*",
      event: "Stop",
      command: "echo hi",
      type: "command",
    })
    expect(canonicalJSON(first)).toBe(canonicalJSON(second))
  })

  test("nested objects are key-sorted", () => {
    const first = canonicalize("hook", { type: "mcp_tool", input: { b: 1, a: { d: 2, c: 3 } } })
    const second = canonicalize("hook", { type: "mcp_tool", input: { a: { c: 3, d: 2 }, b: 1 } })
    expect(canonicalJSON(first)).toBe(canonicalJSON(second))
  })

  test("environment and header values are dropped, key names are kept", () => {
    const first = canonicalize("mcp", {
      type: "local",
      command: ["bun"],
      environment: { TOKEN: "one", PATH: "/bin" },
      headers: { Authorization: "Bearer one" },
    })
    const second = canonicalize("mcp", {
      type: "local",
      command: ["bun"],
      environment: { TOKEN: "two", PATH: "/other" },
      headers: { Authorization: "Bearer two" },
    })
    expect(canonicalJSON(first)).toBe(canonicalJSON(second))
    expect(first.environment).toEqual(["PATH", "TOKEN"])
    expect(first.headers).toEqual(["Authorization"])
  })

  test("environment key names affect the canonical JSON", () => {
    const first = canonicalize("mcp", { type: "local", command: ["bun"], environment: { TOKEN: "x" } })
    const second = canonicalize("mcp", { type: "local", command: ["bun"], environment: { SECRET: "x" } })
    expect(canonicalJSON(first)).not.toBe(canonicalJSON(second))
  })

  test("header key names affect the canonical JSON", () => {
    const first = canonicalize("hook", { type: "http", url: "https://x", headers: { A: "1" } })
    const second = canonicalize("hook", { type: "http", url: "https://x", headers: { B: "1" } })
    expect(canonicalJSON(first)).not.toBe(canonicalJSON(second))
  })

  test("command, args, cwd, url, matcher and event affect the canonical JSON", () => {
    const base = (overrides: Record<string, unknown>) =>
      canonicalJSON(
        canonicalize("mcp", {
          type: "local",
          command: ["bun", "run", ".agents/a.ts"],
          cwd: "tools",
          environment: { TOKEN: "x" },
          ...overrides,
        }),
      )
    const reference = base({})
    expect(base({ command: ["bun", "run", ".agents/b.ts"] })).not.toBe(reference)
    expect(base({ command: ["bun", "run", ".agents/a.ts", "extra"] })).not.toBe(reference)
    expect(base({ cwd: "other" })).not.toBe(reference)
    expect(base({ environment: { OTHER: "x" } })).not.toBe(reference)

    const hook = (overrides: Record<string, unknown>) =>
      canonicalJSON(canonicalize("hook", { type: "command", command: "echo", ...overrides }))
    expect(hook({ command: "echo changed" })).not.toBe(hook({}))
    expect(hook({ args: ["one"] })).not.toBe(hook({}))
    expect(hook({ url: "https://x" })).not.toBe(hook({}))
    expect(hook({ matcher: "Bash" })).not.toBe(hook({}))
    expect(hook({ event: "Stop" })).not.toBe(hook({}))
  })

  test("fields outside the contract do not affect the canonical JSON", () => {
    const formatter = (overrides: Record<string, unknown>) =>
      canonicalJSON(canonicalize("formatter", { command: ["bun", "fmt"], ...overrides }))
    expect(formatter({ extensions: [".ts"] })).toBe(formatter({ extensions: [".js"] }))

    const lsp = (overrides: Record<string, unknown>) =>
      canonicalJSON(canonicalize("lsp", { command: ["node", "server.js"], ...overrides }))
    expect(lsp({ initialization: { a: 1 } })).toBe(lsp({ initialization: { a: 2 } }))

    const mcp = (overrides: Record<string, unknown>) =>
      canonicalJSON(canonicalize("mcp", { type: "remote", url: "https://x", ...overrides }))
    expect(mcp({ oauth: { client_secret: "one" } })).toBe(mcp({ oauth: { client_secret: "two" } }))
  })

  test("allowedEnvVars is deduplicated and sorted", () => {
    const canonical = canonicalize("hook", { type: "http", allowedEnvVars: ["B", "A", "B"] })
    expect(canonical.allowedEnvVars).toEqual(["A", "B"])
  })
})
