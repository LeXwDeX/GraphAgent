// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  BRAND_ALLOWLIST,
  BRAND_PATTERN,
  checkTuiBrand,
  checkTuiRetired,
  formatViolations,
} from "../../script/check-tui-text"
import { en } from "../../src/i18n/en"
import { zhCN } from "../../src/i18n/zh-CN"

const SRC = path.join(import.meta.dir, "../../src")
const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-brand-"))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("current source tree has no upstream product words in string literals", () => {
  const result = checkTuiBrand()
  expect(formatViolations(result.violations)).toEqual([])
  expect(result.unused).toEqual([])
})

test("every allowance names an existing file, a fragment and a reason", () => {
  expect(BRAND_ALLOWLIST.length).toBeGreaterThan(0)
  for (const entry of BRAND_ALLOWLIST) {
    expect(existsSync(path.join(SRC, entry.file)), `${entry.file} should exist`).toBe(true)
    expect(entry.contains.trim()).not.toBe("")
    expect(entry.reason.trim().length, `${entry.file} needs a real reason`).toBeGreaterThanOrEqual(30)
  }
})

test("message tables carry no upstream product words", () => {
  for (const [name, table] of [
    ["zh-CN", zhCN],
    ["en", en],
  ] as const) {
    const hits = Object.entries(table).filter(([, value]) => BRAND_PATTERN.test(value))
    expect({ table: name, hits }).toEqual({ table: name, hits: [] })
  }
})

test("detects upstream words in string literals, template literals, JSX text and attributes", async () => {
  const root = await fixture({
    "ui/a.ts": [
      `const a = "Powered by OpenCode"`,
      "const b = `run opencode -s ${a}`",
      `const c = "https://github.com/anomalyco/x"`,
      `const d = process.env["OPENCODE_HOME"]`,
      "",
    ].join("\n"),
    "ui/b.tsx": `export const B = () => <text title="opencode">OpenCode</text>\n`,
  })
  const { violations } = checkTuiBrand({ root, exclude: [], allow: [] })
  expect(violations.map((violation) => [violation.file, violation.line, violation.text])).toEqual([
    ["ui/a.ts", 1, "Powered by OpenCode"],
    ["ui/a.ts", 2, "run opencode -s "],
    ["ui/a.ts", 3, "https://github.com/anomalyco/x"],
    ["ui/a.ts", 4, "OPENCODE_HOME"],
    ["ui/b.tsx", 1, "opencode"],
    ["ui/b.tsx", 1, "OpenCode"],
  ])
})

test("ignores comments, identifiers and property names", async () => {
  const root = await fixture({
    "ui/a.ts": `// OpenCode\n/* opencode */\nconst opencode = 1\nexport const value = { opencode, OpenCode: 2 }\n`,
  })
  expect(checkTuiBrand({ root, exclude: [], allow: [] }).violations).toEqual([])
})

test("skips the message tables by default", async () => {
  const root = await fixture({
    "i18n/en.ts": `export const en = { legacy: "opencode" }\n`,
    "ui/a.ts": `export const value = 1\n`,
  })
  expect(checkTuiBrand({ root, allow: [] }).violations).toEqual([])
})

test("an allowance covers only its own file and fragment, and unused ones are reported", async () => {
  const root = await fixture({
    "ui/a.ts": [
      `export const grammar = "https://github.com/anomalyco/tree-sitter-vue"`,
      `export const mixed = "https://github.com/anomalyco/opencode"`,
      "",
    ].join("\n"),
    "ui/b.ts": `export const other = "https://github.com/anomalyco/tree-sitter-clojure"\n`,
  })
  const allowed = { file: "ui/a.ts", contains: "anomalyco", reason: "fixture grammar download" }
  const unused = { file: "ui/c.ts", contains: "opencode", reason: "fixture entry without a hit" }
  const result = checkTuiBrand({ root, exclude: [], allow: [allowed, unused] })
  expect(result.violations.map((violation) => [violation.file, violation.line])).toEqual([
    ["ui/a.ts", 2],
    ["ui/b.ts", 1],
  ])
  expect(result.unused).toEqual([unused])
})

test("current source tree has no retired feature remnants", () => {
  const result = checkTuiRetired()
  expect(formatViolations(result.matches)).toEqual([])
  expect(result.files).toEqual([])
})

test("retired feature scan reads comments and finds resurrected files", async () => {
  const root = await fixture({
    "ui/a.ts": `// Zen models are free\nexport const gitlab = 1\nexport const frozen = 2\n`,
    "util/provider-origin.ts": `export const value = 1\n`,
    "component/bg-pulse-render.ts": `export const value = 1\n`,
  })
  const result = checkTuiRetired({ root })
  expect(result.matches.map((match) => [match.file, match.line])).toEqual([
    ["ui/a.ts", 1],
    ["ui/a.ts", 2],
  ])
  expect(result.files).toEqual(["component/bg-pulse-render.ts", "util/provider-origin.ts"])
})
