// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import path from "node:path"

/**
 * Source-text guards for the rules in `packages/tui/AGENTS.md` that used to be checked by
 * hand with grep (sections 5, 7 and 11). They walk `src/` with the runtime instead of
 * shelling out, so they run in `bun test` wherever the suite runs. Matching is per line and
 * includes comments, exactly like the grep commands they replace.
 */

const SRC = path.join(import.meta.dir, "..", "src")

interface SourceFile {
  /** Path relative to `src/`, POSIX separators. */
  file: string
  text: string
}

async function readSources() {
  const result: SourceFile[] = []
  for (const entry of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
    result.push({ file: entry.split(path.sep).join("/"), text: await Bun.file(path.join(SRC, entry)).text() })
  }
  return result.sort((a, b) => a.file.localeCompare(b.file))
}

const sources = await readSources()

/** `file:line: text` for every matching line, optionally limited to some files or minus some files. */
function hits(pattern: RegExp, scope: { only?: readonly string[]; except?: readonly string[] } = {}) {
  const found: string[] = []
  for (const { file, text } of sources) {
    if (scope.only && !scope.only.includes(file)) continue
    if (scope.except?.includes(file)) continue
    const lines = text.split("\n")
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  }
  return found
}

function filesOf(found: readonly string[]) {
  return [...new Set(found.map((entry) => entry.slice(0, entry.indexOf(":"))))].sort()
}

test("the scan sees the files the guards depend on", () => {
  const names = new Set(sources.map((entry) => entry.file))
  for (const file of ["app.tsx", "config/keybind.ts", "context/ticker.ts", "ui/width.ts"]) {
    expect(names.has(file)).toBe(true)
  }
})

// The ticker owns all timing. The frame clock keeps a fallback timer for frames the renderer
// does not produce, and the win32 adapter polls outside the render path.
const TIMER_FILES = ["context/frame-clock.ts", "context/ticker.ts", "terminal-win32.ts"]
const TIMERS = /setTimeout|setInterval/

test("setTimeout and setInterval stay in the ticker, the frame clock and the win32 adapter", () => {
  expect(hits(TIMERS, { except: TIMER_FILES })).toEqual([])
})

test("every allowed timer file still uses a timer", () => {
  expect(filesOf(hits(TIMERS, { only: TIMER_FILES }))).toEqual(TIMER_FILES)
})

test("Bun.stringWidth is only called from ui/width.ts", () => {
  expect(hits(/stringWidth/, { except: ["ui/width.ts"] })).toEqual([])
})

test("no blinking or fade-in animation remains", () => {
  expect(hits(/BLINK|createFadeIn/)).toEqual([])
})

test("config/keybind.ts defines no dag_ keys", () => {
  expect(hits(/dag_[a-z_]*/, { only: ["config/keybind.ts"] })).toEqual([])
})

// Components draw with theme tokens. Three places build a color without one, each for a reason
// given in AGENTS.md section 7; a fourth is a new exception and has to be argued there first.
test("color literals only appear in the three documented exceptions", () => {
  const found = filesOf(hits(/#[0-9a-fA-F]{6}\b|RGBA\.from/)).filter((file) => !file.startsWith("theme/"))
  expect(found).toEqual(["component/error-component.tsx", "context/local.tsx", "routes/session/index.tsx"])
})

test("the retired plugin slot API does not come back", () => {
  expect(hits(/@graphagent\/plugin|@opencode-ai\/plugin|pluginRuntime|api\??\.slots|Slot name=/)).toEqual([])
})
