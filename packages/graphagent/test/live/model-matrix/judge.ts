// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What decides a run: the helpers a scenario's `judge` is written with, and the replay tier's two script checks
 * (`trap` and `contract`, see `Script` in `types.ts`). Everything here reads a `RunView` and returns the criteria
 * that were not met, in words; an empty list means met.
 */

import type { Call, RunView, Script, ScriptFamily } from "./types"

export type Needle = string | RegExp

export function describeNeedle(needle: Needle): string {
  return typeof needle === "string" ? JSON.stringify(needle) : String(needle)
}

export function describeNeedles(needles: readonly Needle[]): string {
  return `[${needles.map(describeNeedle).join(", ")}]`
}

/** Whether `text` holds `needle`: a substring, or a match of a pattern (its `g` and `y` flags are ignored). Case matters. */
export function holds(text: string, needle: Needle): boolean {
  if (typeof needle === "string") return text.includes(needle)
  return new RegExp(needle.source, needle.flags.replace(/[gy]/g, "")).test(text)
}

/** The scenario names a tool: the run must have at least one completed call of it. */
export function ranTool(run: RunView, tool: string): string[] {
  const done = run.calls.some((call) => call.tool === tool && call.status === "completed")
  return done ? [] : [`calls: no completed ${tool} call`]
}

export function replyHas(run: RunView, needle: Needle): string[] {
  return holds(run.reply, needle) ? [] : [`reply: missing ${describeNeedle(needle)}`]
}

/** The distinct `src/...` paths the reply names, sorted. */
export function replyPaths(run: RunView): string[] {
  return [...new Set(run.reply.match(/src\/[\w.-]+/g) ?? [])].sort()
}

/** The reply names exactly these `src/...` paths: no other, and none missing. */
export function replyPathsAre(run: RunView, expected: readonly string[]): string[] {
  const got = replyPaths(run)
  const want = [...expected].sort()
  const same = got.length === want.length && got.every((path, index) => path === want[index])
  return same ? [] : [`reply: paths ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`]
}

/**
 * The replay tier's checks of one run against its script. A `trap` that did not catch (the call is missing, did
 * not fail, or its text lacks an entry) and a `contract` entry no completed call satisfies each give one line in
 * the fixed format the replay test throws.
 */
export function scriptFailures(id: string, family: ScriptFamily, script: Script, calls: readonly Call[]): string[] {
  const label = `${id} [${family}]`
  const failures: string[] = []
  const { trap } = script
  if (trap) {
    const hit = calls[trap.call]
    const text = hit?.text ?? ""
    if (!hit || hit.status !== "error" || !trap.includes.every((needle) => holds(text, needle))) {
      const got = `${hit?.status ?? "no call"} ${JSON.stringify(text.slice(0, 200))}`
      failures.push(
        `trap ${label} call ${trap.call}: expected error containing ${describeNeedles(trap.includes)}, got ${got}`,
      )
    }
  }
  for (const entry of script.contract ?? []) {
    const met = calls.some(
      (call) =>
        call.tool === entry.tool &&
        call.status === "completed" &&
        entry.includes.every((needle) => holds(call.text, needle)),
    )
    if (!met)
      failures.push(`contract ${label} ${entry.tool}: no completed call contains ${describeNeedles(entry.includes)}`)
  }
  return failures
}
