// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  ENGLISH_BASELINE_PATH,
  collectTuiEnglish,
  compareEnglishBaseline,
  formatEnglishBaseline,
  formatEnglishEntry,
  parseEnglishBaseline,
  readEnglishBaseline,
  summarizeEnglish,
  updateEnglishBaseline,
  writeEnglishBaseline,
  type EnglishEntry,
} from "../../script/check-tui-text"

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-english-"))
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

function entry(text: string, count = 1, file = "a.tsx"): EnglishEntry {
  return { file, kind: "prop", text, count }
}

function found(literals: ReturnType<typeof collectTuiEnglish>) {
  return literals.map((literal) => `${literal.file} ${literal.kind} ${literal.text}`).sort()
}

test("the source tree adds no English literals beyond the baseline", () => {
  const { added } = compareEnglishBaseline(summarizeEnglish(collectTuiEnglish()), readEnglishBaseline())
  expect(
    added.map(formatEnglishEntry),
    "move the visible text to the message tables and use t(); the baseline only shrinks",
  ).toEqual([])
})

test("every baseline entry still matches the source tree", () => {
  const { stale } = compareEnglishBaseline(summarizeEnglish(collectTuiEnglish()), readEnglishBaseline())
  expect(
    stale.map(formatEnglishEntry),
    "delete these from the baseline: bun script/check-tui-text.ts --update-baseline",
  ).toEqual([])
})

test("the baseline file is canonical, sorted and free of duplicates", async () => {
  const raw = await readFile(ENGLISH_BASELINE_PATH, "utf8")
  const entries = parseEnglishBaseline(raw)
  expect(entries.length).toBeGreaterThan(0)
  expect(formatEnglishBaseline(entries)).toBe(raw)
  const keys = entries.map((row) => JSON.stringify([row.file, row.kind, row.text]))
  expect(new Set(keys).size).toBe(keys.length)
  // Rows carry no line numbers, so unrelated edits to a file never churn the baseline.
  for (const row of raw.split("\n").filter((line) => line !== "" && !line.startsWith("#"))) {
    expect(row.split("\t").length).toBeGreaterThanOrEqual(3)
    expect(row.split("\t").length).toBeLessThanOrEqual(4)
  }
})

test("finds JSX text and literals that reach the screen through JSX children and attributes", async () => {
  const root = await fixture({
    "ui/a.tsx": [
      "export const A = (props: { ok: boolean }) => (",
      '  <box title="Hello world" id="main-panel" placeholder={props.ok ? "Type here" : "Wait"} label={t("label.key")}>',
      "    <text>Copy report</text>",
      '    <text>{"Plain child"}</text>',
      '    <text>{props.ok ? "Done" : "Failed"}</text>',
      '    <text>{props.ok && "Visible when ok"}</text>',
      '    <text>{t("copy.report")}</text>',
      "    <text>│</text>",
      '    <text>{" "}</text>',
      "    <text>OK</text>",
      "  </box>",
      ")",
      "",
    ].join("\n"),
  })
  expect(found(collectTuiEnglish({ root }))).toEqual([
    "ui/a.tsx jsx-attr Hello world",
    "ui/a.tsx jsx-attr Type here",
    "ui/a.tsx jsx-attr Wait",
    "ui/a.tsx jsx-text Copy report",
    "ui/a.tsx jsx-text Done",
    "ui/a.tsx jsx-text Failed",
    "ui/a.tsx jsx-text Plain child",
    "ui/a.tsx jsx-text Visible when ok",
  ])
})

test("finds visible properties and toast text, and nothing else in object literals", async () => {
  const root = await fixture({
    "ui/b.ts": [
      "export const commands = [",
      '  { title: "Show command palette", value: "command.palette.show", name: "panel.submit" },',
      '  { title: t("command.title"), description: "Schema docs only" },',
      '  { label: `Read ${path}`, hint: "ok" },',
      "]",
      'toast.show({ text: "Copied to clipboard", level: "info" })',
      "input.toast.show({ text: `Failed to ${action}`, level: 'error' })",
      'toast.error("Not a literal slot")',
      'other.show({ text: "Not a toast" })',
      'const payload = { type: "text", text: "Plain user text" }',
      'const url = "https://example.com/docs/getting-started"',
      '// { title: "Hidden in a comment" }',
      "",
    ].join("\n"),
  })
  expect(found(collectTuiEnglish({ root }))).toEqual([
    "ui/b.ts prop Read ${}",
    "ui/b.ts prop Show command palette",
    "ui/b.ts toast Copied to clipboard",
    "ui/b.ts toast Failed to ${}",
  ])
})

test("skips the message tables by default", async () => {
  const root = await fixture({
    "i18n/en.ts": `export const en = { entry: { title: "Translated text" } }\n`,
    "ui/a.ts": `export const value = 1\n`,
  })
  expect(collectTuiEnglish({ root })).toEqual([])
  expect(found(collectTuiEnglish({ root, exclude: [] }))).toEqual(["i18n/en.ts prop Translated text"])
})

test("groups repeated literals with their lines but keeps lines out of the file", async () => {
  const root = await fixture({
    "ui/a.ts": ['export const a = { title: "Page up" }', 'export const b = { title: "Page up" }', ""].join("\n"),
  })
  const entries = summarizeEnglish(collectTuiEnglish({ root }))
  expect(entries).toEqual([{ file: "ui/a.ts", kind: "prop", text: "Page up", count: 2, lines: [1, 2] }])
  expect(formatEnglishEntry(entries[0])).toBe('ui/a.ts:1,2 [prop] "Page up" x2')
  expect(formatEnglishBaseline(entries)).toContain("\nui/a.ts\tprop\tPage up\t2\n")
})

test("new text and raised counts are added; vanished text and lowered counts are stale", () => {
  const baseline = [entry("Keep"), entry("Gone"), entry("Twice", 2), entry("Thrice", 3)]
  const current = [entry("Keep"), entry("New"), entry("Twice", 3), entry("Thrice", 1)]
  const { added, stale } = compareEnglishBaseline(current, baseline)
  expect(added.map(formatEnglishEntry)).toEqual(['a.tsx [prop] "New"', 'a.tsx [prop] "Twice"'])
  expect(stale.map(formatEnglishEntry)).toEqual(['a.tsx [prop] "Gone"', 'a.tsx [prop] "Thrice" x2'])
  expect(compareEnglishBaseline(baseline, baseline)).toEqual({ added: [], stale: [] })
})

test("--update-baseline only shrinks: growth is refused and leaves the file alone", async () => {
  const root = await fixture({})
  const file = path.join(root, "baseline.json")
  writeEnglishBaseline([entry("Keep"), entry("Gone"), entry("Twice", 2)], file)
  const before = await readFile(file, "utf8")

  const refused = updateEnglishBaseline([entry("Keep"), entry("New")], file)
  expect(refused.written).toBe(false)
  expect(refused.added.map((row) => row.text)).toEqual(["New"])
  expect(await readFile(file, "utf8")).toBe(before)

  const shrunk = updateEnglishBaseline([entry("Keep"), entry("Twice")], file)
  expect(shrunk.written).toBe(true)
  expect(shrunk.removed.map(formatEnglishEntry)).toEqual(['a.tsx [prop] "Gone"', 'a.tsx [prop] "Twice"'])
  expect(readEnglishBaseline(file)).toEqual([entry("Keep"), entry("Twice")])
  expect(await readFile(file, "utf8")).toBe(formatEnglishBaseline([entry("Keep"), entry("Twice")]))
})

test("a malformed baseline is rejected", () => {
  expect(() => parseEnglishBaseline("a.tsx\tnope\tx")).toThrow("line 1")
  expect(() => parseEnglishBaseline("# header\na.tsx\tprop")).toThrow("line 2")
  expect(() => parseEnglishBaseline("a.tsx\tprop\tx\t0")).toThrow("line 1")
  expect(() => parseEnglishBaseline("a.tsx\tprop\tx\t2\textra")).toThrow("line 1")
  expect(parseEnglishBaseline("# header\n\na.tsx\tprop\tx\nb.tsx\ttoast\ty z\t3\n")).toEqual([
    { file: "a.tsx", kind: "prop", text: "x", count: 1 },
    { file: "b.tsx", kind: "toast", text: "y z", count: 3 },
  ])
})
