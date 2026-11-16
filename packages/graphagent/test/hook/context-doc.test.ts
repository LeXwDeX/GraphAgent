// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { HOOK_BINDINGS, sourceName, type HookBinding } from "@/hook/bindings"
import { unknownNames } from "../lib/hook-sources"

/**
 * Issue #1070: `hook/CONTEXT.md` is the contract of every hook event. Its two
 * generated blocks are rendered from `HOOK_BINDINGS`, and every code name the
 * hand-written text mentions has to exist. After a change to the table, render
 * the blocks again with `HOOK_CONTEXT_WRITE=1 bun test test/hook/context-doc.test.ts`.
 */

const DOC = path.resolve(import.meta.dir, "../../src/hook/CONTEXT.md")
const entries: [string, HookBinding][] = Object.entries(HOOK_BINDINGS)

const count = (kind: HookBinding["source"]["kind"]) =>
  entries.filter(([, binding]) => binding.source.kind === kind).length
const yesNo = (value: boolean) => (value ? "yes" : "no")
const label = (binding: HookBinding) =>
  binding.source.kind === "unbound"
    ? "none"
    : `${binding.source.kind === "lifecycle" ? "lifecycle" : "event"} \`${sourceName(binding)}\``

function renderSummary(): string {
  const gating = entries.filter(([, binding]) => binding.gating).length
  return [
    `${entries.length} events: ${count("lifecycle")} derive from a lifecycle value, ${count("ownerEvent")} from an owner event, ${count("unbound")} from nothing. ${gating} are gating.`,
    "",
    "| Event | Source | Gating |",
    "| --- | --- | --- |",
    ...entries.map(([event, binding]) => `| \`${event}\` | ${label(binding)} | ${yesNo(binding.gating)} |`),
  ].join("\n")
}

function renderContracts(): string {
  return entries
    .map(([event, binding]) =>
      [
        `### \`${event}\``,
        "",
        `- Source: ${label(binding)}${binding.source.kind === "unbound" ? `. ${binding.source.reason}` : ""}`,
        `- Gating: ${yesNo(binding.gating)}`,
        `- Fires: ${binding.when}`,
        `- Exactly once: ${binding.once}`,
        `- Trigger sites: ${binding.sites.map((site) => `\`${site}\``).join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n")
}

const REGIONS: Record<string, () => string> = { "hook-summary": renderSummary, "hook-contracts": renderContracts }

const region = (name: string) => new RegExp(`(<!-- ${name}:start -->\\n)([\\s\\S]*?)(\\n?<!-- ${name}:end -->)`)

// Rendering is a maintenance step, not a check: it rewrites the file and the
// assertions below then run against the result.
if (process.env.HOOK_CONTEXT_WRITE === "1") {
  let text = readFileSync(DOC, "utf8")
  for (const [name, render] of Object.entries(REGIONS))
    text = text.replace(region(name), `$1${render()}\n<!-- ${name}:end -->`)
  writeFileSync(DOC, text)
}

const doc = readFileSync(DOC, "utf8")

describe("hook/CONTEXT.md", () => {
  for (const [name, render] of Object.entries(REGIONS)) {
    test(`the ${name} block is rendered from the binding table`, () => {
      const body = doc.match(region(name))?.[2]
      expect(body, `${name} markers are missing from hook/CONTEXT.md`).toBeDefined()
      expect(body?.trim()).toBe(render())
    })
  }

  test("every event has a contract section", () => {
    for (const [event] of entries) expect(doc, event).toContain(`### \`${event}\``)
  })

  test("every code name the document mentions exists", () => {
    const lifecycle = entries.flatMap(([, binding]) =>
      binding.source.kind === "lifecycle" ? [sourceName(binding)] : [],
    )
    expect(unknownNames(doc, lifecycle)).toEqual([])
  })

  test("the document states the present Stop semantics", () => {
    const stop = doc.slice(
      doc.indexOf("## Stop, StopFailure and SubagentStop"),
      doc.indexOf("## Writes to session state"),
    )
    expect(stop).toContain("A natural end fires Stop")
    expect(stop).toContain("A block continues the turn")
    expect(stop).toContain("A failure fires StopFailure")
    expect(stop).toContain("A cancellation fires neither")
  })
})
