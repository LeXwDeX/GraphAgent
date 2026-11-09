// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, STOP_TIMEOUT_MS, timeoutFor } from "@/hook/exec/command"
import type { HookCommand, HookEvent } from "@/hook"

const original = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS

afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  else process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = original
})

const entry = (overrides: Partial<HookCommand> = {}): HookCommand => ({
  type: "command",
  command: "true",
  ...overrides,
})

const timeout = (overrides: Partial<HookCommand>, event: HookEvent) => timeoutFor(entry(overrides), event)

describe("hook default timeouts", () => {
  test("foreground command/HTTP/MCP hooks default to 30 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
    for (const type of ["command", "http", "mcp_tool"] as const)
      expect(timeout({ type, url: "https://example.com", server: "s", tool: "t" }, "PreToolUse")).toBe(30_000)
    expect(timeout({}, "PostToolUse")).toBe(30_000)
    expect(timeout({}, "Notification")).toBe(30_000)
  })

  test("Stop-class events default to 60 seconds", () => {
    expect(STOP_TIMEOUT_MS).toBe(60_000)
    for (const event of ["Stop", "SubagentStop", "TaskCompleted", "PreCompact", "PostCompact"] as const)
      expect(timeout({}, event)).toBe(60_000)
    // StopFailure is not part of the Stop-class table.
    expect(timeout({}, "StopFailure")).toBe(30_000)
  })

  test("background async and asyncRewake commands keep 600 seconds", () => {
    expect(BACKGROUND_TIMEOUT_MS).toBe(600_000)
    expect(timeout({ async: true }, "PreToolUse")).toBe(600_000)
    expect(timeout({ asyncRewake: true }, "Stop")).toBe(600_000)
    expect(timeout({ async: true, asyncRewake: true }, "UserPromptSubmit")).toBe(600_000)
  })

  test("handler-specific and event-specific defaults are unchanged", () => {
    expect(timeout({ type: "prompt", prompt: "x" }, "PreToolUse")).toBe(30_000)
    expect(timeout({ type: "agent", prompt: "x" }, "PreToolUse")).toBe(60_000)
    // Async does not extend the prompt/agent limits.
    expect(timeout({ type: "prompt", prompt: "x", async: true }, "PreToolUse")).toBe(30_000)
    expect(timeout({ type: "agent", prompt: "x", async: true }, "PreToolUse")).toBe(60_000)
    expect(timeout({}, "MessageDisplay")).toBe(10_000)
    for (const event of ["UserPromptSubmit", "PreModelSwitch", "PostModelSwitch"] as const)
      expect(timeout({}, event)).toBe(30_000)
  })

  test("SessionEnd keeps 1.5 seconds and honors the Claude protocol override", () => {
    expect(timeout({}, "SessionEnd")).toBe(1_500)
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = "4500"
    expect(timeout({}, "SessionEnd")).toBe(4_500)
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = "not-a-number"
    expect(timeout({}, "SessionEnd")).toBe(1_500)
  })

  test("an explicit timeout wins everywhere", () => {
    expect(timeout({ timeout: 5 }, "PreToolUse")).toBe(5_000)
    expect(timeout({ timeout: 5 }, "Stop")).toBe(5_000)
    expect(timeout({ timeout: 5, async: true }, "PreToolUse")).toBe(5_000)
    expect(timeout({ timeout: 5, type: "prompt", prompt: "x" }, "PreToolUse")).toBe(5_000)
    expect(timeout({ timeout: 5 }, "SessionEnd")).toBe(5_000)
  })

  test("the source layer never changes the default", () => {
    // Loader metadata is the only per-source field a handler carries; global
    // and project handlers with identical definitions resolve identically.
    const global = timeout({}, "PreToolUse")
    const project = timeout({ __sourceDir: "/plugins/example" }, "PreToolUse")
    expect(project).toBe(global)
    expect(timeout({ __sourceDir: "/plugins/example" }, "Stop")).toBe(STOP_TIMEOUT_MS)
  })
})
