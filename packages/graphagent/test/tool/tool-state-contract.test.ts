// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1069 state-ownership gate for the tool layer. Tool modules must not keep
// runtime object state in module-level mutable bindings, and background work
// must start through the BackgroundJob registry so the Lifecycle contract can
// observe every job. oxlint cannot express either rule, so this gate scans the
// sources, following test/policy/repo-dependencies.test.ts.

import { describe, expect, it } from "bun:test"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const TOOL_SOURCES = new Bun.Glob("src/tool/**/*.ts")

// `file:binding` → why this module-level mutable state is not runtime state.
// A stale entry fails the test: the file must still declare and mutate it.
const DECLARED_STATE = new Map<string, string>([
  [
    "src/tool/edit.ts:locks",
    "process-global edit mutex: edits of one absolute path must serialize across directory instances",
  ],
  [
    "src/tool/json-schema.ts:cache",
    "derived schema memo: WeakMap keyed by schema identity, pure derivation, no runtime state",
  ],
])

// `file` → job kind. Starting background work from a new tool fails the gate
// until the author registers it through Lifecycle and lists it here.
const BACKGROUND_STARTERS = new Map<string, string>([
  ["src/tool/shell.ts", "bash"],
  ["src/tool/task.ts", "task"],
])

async function toolSources(): Promise<ReadonlyArray<{ readonly file: string; readonly source: string }>> {
  const files = await Array.fromAsync(TOOL_SOURCES.scan({ cwd: ROOT, onlyFiles: true }))
  expect(files.length, "expected tool source files").toBeGreaterThan(20)
  return Promise.all(
    files.sort().map(async (file) => ({ file, source: await Bun.file(path.join(ROOT, file)).text() })),
  )
}

/** Drop block comments so prose examples cannot trip the declarations scan. */
function withoutBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("tool state contract (#1069)", () => {
  it("keeps runtime object state out of module-level mutable bindings", async () => {
    const offenders: string[] = []
    const declared = new Set<string>()
    for (const { file, source: raw } of await toolSources()) {
      const source = withoutBlockComments(raw)
      for (const match of source.matchAll(/^let\s+(\w+)/gm)) offenders.push(`${file}: module-level \`let ${match[1]}\``)
      for (const match of source.matchAll(
        /^const\s+(\w+)\s*(?::[^=\n]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/gm,
      )) {
        const name = match[1]
        // Only a mutated container carries runtime state; read-only lookup
        // tables stay valid.
        if (!new RegExp(`\\b${name}\\.(?:set|add|delete|clear)\\b`).test(source)) continue
        const key = `${file}:${name}`
        if (DECLARED_STATE.has(key)) {
          declared.add(key)
          continue
        }
        offenders.push(`${file}: module-level container \`${name}\` is mutated`)
      }
    }
    for (const [key, reason] of DECLARED_STATE)
      expect(declared, `${key} no longer declares module-level mutable state; drop its exemption (${reason})`).toContain(
        key,
      )
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  it("starts background work through the registered BackgroundJob path", async () => {
    const starters: string[] = []
    for (const { file, source } of await toolSources())
      if (/background\s*\.\s*start\s*\(/.test(withoutBlockComments(source))) starters.push(file)
    expect(
      starters.sort(),
      "background.start call sites changed; register the new job through Lifecycle and add it to BACKGROUND_STARTERS",
    ).toEqual([...BACKGROUND_STARTERS.keys()].sort())
  })
})
