// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * PreToolUse hook of the case replay (Issue #1474), run for every tool call of the evaluation host. It is
 * installed in the isolated user hook chain by `seedCaseHome` (`case-run.ts`), never in a tracked file.
 *
 * A case replay asks a model for the first step of a recorded session and judges what the model decided to do.
 * Whatever it decides is stopped before it runs (`continue:false` ends the turn): no file changes, no shell
 * command runs, no subagent starts. Before stopping it, the hook appends the call to the audit file named by the
 * first argument, one JSON line each: the tool, the arguments exactly as the model gave them, and the call id.
 * The judge reads the first call back with `firstStoppedCall`.
 *
 * The audit is the only thing the hook decides on its own account, and it never changes the answer: an
 * unreadable payload, a missing audit file argument and a failed append all still stop the call.
 *
 * The hook starts once per tool call, so this file imports nothing but the Node built-ins and the tiny
 * `classify` module the delegation-timing hook also uses.
 *
 * Usage: bun case-hook.ts <audit-file>   (the hook payload arrives on stdin)
 */

import { appendFileSync, readFileSync } from "node:fs"
import { isRecord } from "../delegation-timing/classify"

const STOP = JSON.stringify({ continue: false, stopReason: "case replay: the first tool call is what is judged" })

/** A tool call the hook stopped. */
export interface StoppedCall {
  readonly tool: string
  /** The arguments as the model gave them, before the tool repaired or decoded them. */
  readonly input: Record<string, unknown>
  /** The id the model gave the call (`tool_use_id`). */
  readonly id?: string
}

/** The call a PreToolUse payload describes; `undefined` for anything that is not one. */
export function stoppedCallOf(payload: unknown): StoppedCall | undefined {
  if (!isRecord(payload) || typeof payload.tool_name !== "string" || payload.tool_name === "") return undefined
  const input = isRecord(payload.tool_input) ? payload.tool_input : {}
  return {
    tool: payload.tool_name,
    input,
    ...(typeof payload.tool_use_id === "string" ? { id: payload.tool_use_id } : {}),
  }
}

/** An audit line as the call it holds, or `undefined` when it is not one. */
function auditLine(line: string): StoppedCall | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.tool !== "string" || !isRecord(parsed.input)) return undefined
  return { tool: parsed.tool, input: parsed.input, ...(typeof parsed.id === "string" ? { id: parsed.id } : {}) }
}

/** The calls of an audit file's text, in the order they were written; lines that are not a call are skipped. */
function auditedCalls(audit: string): StoppedCall[] {
  return audit.split("\n").flatMap((line) => {
    const call = auditLine(line)
    return call ? [call] : []
  })
}

/**
 * The call the model made first. Parallel calls start one hook each and the hooks finish in no set order, so the
 * audit's own order is only the tie-break: `order` is the ids of the model's calls as the transcript lists them,
 * and the audited call whose id comes first in it is the first one. Calls whose id is not in `order` come last.
 */
export function firstStoppedCall(audit: string, order: readonly string[] = []): StoppedCall | undefined {
  const rank = (call: StoppedCall) => {
    const at = call.id === undefined ? -1 : order.indexOf(call.id)
    return at === -1 ? order.length : at
  }
  return auditedCalls(audit).reduce<StoppedCall | undefined>(
    (best, call) => (best === undefined || rank(call) < rank(best) ? call : best),
    undefined,
  )
}

function main() {
  const file = process.argv[2]
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    // Nothing to record; the call is still stopped.
  }
  const call = stoppedCallOf(payload)
  if (file && call) {
    try {
      appendFileSync(file, `${JSON.stringify(call)}\n`)
    } catch {
      // Losing a line only makes the judge fall back to the transcript.
    }
  }
  console.log(STOP)
}

if (import.meta.main) main()
