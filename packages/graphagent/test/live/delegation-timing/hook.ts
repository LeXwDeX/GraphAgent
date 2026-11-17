// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * PreToolUse hook the delegation-timing host runs for every tool call (it is
 * installed in the isolated user hook chain, never in a tracked file).
 *
 * It ends a scenario at the model's first decisive call: a `task` call, or any
 * call that is not a plain read. A decisive call is stopped before it runs
 * (`continue:false` ends the turn), so no sub-agent starts and no file changes.
 * Reads go through the dedicated read tools (read, grep, glob, list), which the
 * host's `external_directory` denial keeps inside the fixture copy. The shell
 * never runs here: a shell call that only reads is denied with a pointer to
 * those tools and the turn goes on. Whether a command line is harmless cannot
 * be proven by looking at it, and its output would go to a remote model, so
 * the shell classification only records what the model meant to do; safety
 * does not rest on it. Every call is also appended to the
 * audit file named by the first argument, for diagnosis. What the model did is
 * read back from the session transcript, not from this file.
 *
 * Usage: bun hook.ts <audit-file>   (the hook payload arrives on stdin)
 */

import { appendFileSync, readFileSync } from "node:fs"
import { classifyCall, isDecisive, isRecord } from "./classify"

const STOP = JSON.stringify({ continue: false, stopReason: "delegation-eval: the scenario is decided" })
const SHELL_TOOLS = new Set(["bash", "shell"])
const NO_SHELL = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Shell commands do not run in this session. Use the read, grep, glob and list tools to look at files.",
  },
})

function audit(file: string | undefined, entry: Record<string, unknown>) {
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
  } catch {
    // The audit is a diagnostic aid; losing a line must not change what the hook decides.
  }
}

function main() {
  const file = process.argv[2]
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(0, "utf8"))
  } catch (error) {
    // An unreadable payload cannot be judged; stopping is the safe answer for an unattended eval.
    audit(file, { error: error instanceof Error ? error.message : "unreadable payload" })
    console.log(STOP)
    return
  }
  if (!isRecord(payload)) {
    console.log(STOP)
    return
  }
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : ""
  const input = isRecord(payload.tool_input) ? payload.tool_input : {}
  const kind = classifyCall({
    tool,
    input,
    ...(typeof payload.tool_use_id === "string" ? { callID: payload.tool_use_id } : {}),
  }).kind
  const decisive = isDecisive(kind)
  audit(file, {
    session: payload.session_id,
    agent: payload.agent_type,
    tool,
    kind,
    decisive,
    command: typeof input.command === "string" ? input.command.slice(0, 200) : undefined,
    background: input.background,
  })
  if (decisive) console.log(STOP)
  else if (SHELL_TOOLS.has(tool)) console.log(NO_SHELL)
}

main()
