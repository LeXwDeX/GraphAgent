// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises"
import type { HookCommand } from "@/hook"

/**
 * A fake external command guard for the #1324 tests: an ordinary command hook
 * that answers a PreToolUse call the way a real guard speaks the Claude Code
 * protocol. It is a test script with no connection to any real guard.
 *
 * - a command containing `reset --hard`: `permissionDecision: "deny"` with a reason;
 * - a command, URL or URI containing `needs-confirmation`: `permissionDecision: "ask"`;
 * - anything else (and every other event): silent, exit 0.
 *
 * Every invocation appends `{ event, permission_mode, tool_name, subject }` to
 * the log file named by its first argument, so a test sees what an external
 * process is told about the session it guards.
 */
const SCRIPT = `
const fs = require("node:fs")
const input = JSON.parse(fs.readFileSync(0, "utf8"))
const toolInput = input.tool_input || {}
const subject = String(toolInput.command ?? toolInput.url ?? toolInput.uri ?? "")
fs.appendFileSync(
  process.argv[1],
  JSON.stringify({
    event: input.hook_event_name,
    permission_mode: input.permission_mode,
    tool_name: input.tool_name,
    subject,
  }) + "\\n",
)
if (input.hook_event_name !== "PreToolUse") process.exit(0)
const verdict = /reset --hard/.test(subject) ? "deny" : /needs-confirmation/.test(subject) ? "ask" : undefined
if (verdict)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict,
        permissionDecisionReason: "fake guard " + verdict + ": " + subject,
      },
    }),
  )
`

/** The guard as one hook entry; `extra` overrides fields such as `timeout` or `onFailure`. */
export const fakeGuardEntry = (log: string, extra: Partial<HookCommand> = {}): HookCommand => ({
  type: "command",
  command: process.execPath,
  args: ["-e", SCRIPT, log],
  inputFormat: "claude-code",
  ...extra,
})

/**
 * A user-level `hooks.json` that puts `entry` in front of the tools `matcher` names (the shell and fetch tools by
 * default), and the same guard after them.
 */
export const guardHooks = (log: string, entry: HookCommand = fakeGuardEntry(log), matcher = "Bash|WebFetch") => ({
  PreToolUse: [{ matcher, hooks: [entry] }],
  PostToolUse: [{ matcher, hooks: [fakeGuardEntry(log)] }],
})

export interface GuardCall {
  readonly event: string
  readonly permission_mode?: string
  readonly tool_name: string
  readonly subject: string
}

/** What the guard saw, in order; an empty list when it never ran. */
export const readGuardLog = async (log: string): Promise<GuardCall[]> => {
  const text = await fs.readFile(log, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): GuardCall => JSON.parse(line))
}

export * as FakeCommandGuard from "./fake-command-guard"
