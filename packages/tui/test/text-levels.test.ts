// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  TEXT_LEVELS_BASELINE_PATH,
  collectTextLevelLiterals,
  compareTextLevelsBaseline,
  formatTextLevelsBaseline,
  formatTextLevelsFailure,
  formatTextLevelLiteral,
  parseTextLevelsBaseline,
  readTextLevelsBaseline,
  updateTextLevelsBaseline,
} from "../script/check-text-levels"

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-text-levels-"))
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

function found(literals: ReturnType<typeof collectTextLevelLiterals>) {
  return literals.map(formatTextLevelLiteral)
}

test("the source tree has no more text level literals than the baseline allows", () => {
  const literals = collectTextLevelLiterals()
  const comparison = compareTextLevelsBaseline(literals.length, readTextLevelsBaseline())
  expect(
    comparison.over,
    `name the role in src/ui/text.ts; the baseline only goes down\n${literals.map(formatTextLevelLiteral).join("\n")}`,
  ).toBe(0)
})

test("the baseline file is canonical", async () => {
  const raw = await readFile(TEXT_LEVELS_BASELINE_PATH, "utf8")
  expect(formatTextLevelsBaseline(parseTextLevelsBaseline(raw))).toBe(raw)
})

test("counts a level color written straight after fg or color, and a bare bold", async () => {
  const root = await fixture({
    "panel/a.tsx": [
      "export const A = () => (",
      "  <box>",
      "    <text fg={theme.primary}>a</text>",
      "    <text color={theme.textMuted}>b</text>",
      "    <text fg={theme.text} attributes={TextAttributes.BOLD}>c</text>",
      "    <Spinner color={theme.textDim} />",
      "  </box>",
      ")",
      "",
    ].join("\n"),
  })
  expect(found(collectTextLevelLiterals({ root }))).toEqual([
    "panel/a.tsx:3 fg={theme.primary}",
    "panel/a.tsx:4 color={theme.textMuted}",
    "panel/a.tsx:5 fg={theme.text}",
    "panel/a.tsx:5 TextAttributes.BOLD",
    "panel/a.tsx:6 color={theme.textDim}",
  ])
})

test("leaves state colors, the selection background, roles and text alone", async () => {
  const root = await fixture({
    "panel/b.tsx": [
      'import { textFg, textAttributes } from "../../ui/text"',
      "export const B = (props: { selected: boolean }) => (",
      "  <box>",
      "    <text fg={theme.success}>ok</text>",
      "    <text fg={theme.warning}>warn</text>",
      "    <text fg={theme.error}>bad</text>",
      "    <text fg={theme.statusRunning}>run</text>",
      "    <text fg={theme.accent}>brand</text>",
      "    <box backgroundColor={props.selected ? theme.backgroundSelected : undefined} />",
      "    <text fg={textFg(theme, \"secondary\")} attributes={textAttributes(\"title\")}>body</text>",
      "    <text fg={theme.markdownText}>md</text>",
      "    {/* fg={theme.primary} */}",
      '    <text>{"fg={theme.textDim}"}</text>',
      "  </box>",
      ")",
      "",
    ].join("\n"),
  })
  expect(found(collectTextLevelLiterals({ root }))).toEqual([])
})

test("counts the brand primary of a link, which the coarse ratchet leaves to the baseline", async () => {
  const root = await fixture({
    "panel/c.tsx": 'export const C = () => <Link href={url} fg={theme.primary} />\n',
  })
  expect(found(collectTextLevelLiterals({ root }))).toEqual(["panel/c.tsx:1 fg={theme.primary}"])
})

test("scans panel only, in both .ts and .tsx, and nothing else", async () => {
  const root = await fixture({
    "panel/a.ts": "export const a = { fg: theme.primary }\n",
    "panel/b.tsx": "export const b = <text fg={theme.text} />\n",
    "shell/c.tsx": "export const c = <text fg={theme.textDim} />\n",
    "ui/d.tsx": "export const d = <text fg={theme.primary} />\n",
  })
  expect(found(collectTextLevelLiterals({ root }))).toEqual(["panel/b.tsx:1 fg={theme.text}"])
  expect(found(collectTextLevelLiterals({ root, dirs: ["shell"] }))).toEqual(["shell/c.tsx:1 fg={theme.textDim}"])
})

test("a tree with one literal over the baseline fails and lists where every literal is", async () => {
  const root = await fixture({
    "panel/ok.tsx": "export const a = <text fg={theme.primary} />\n",
    "panel/new.tsx": "export const b = <text fg={theme.textMuted} />\n",
  })
  const literals = collectTextLevelLiterals({ root })
  const comparison = compareTextLevelsBaseline(literals.length, 1)
  expect(comparison).toEqual({ count: 2, baseline: 1, over: 1, slack: 0 })
  const message = formatTextLevelsFailure(comparison, literals)
  expect(message).toContain("2 found, the baseline allows 1")
  expect(message).toContain("panel/new.tsx:1 fg={theme.textMuted}")
  expect(message).toContain("panel/ok.tsx:1 fg={theme.primary}")
})

test("a tree below the baseline passes and says how far the baseline can drop", () => {
  expect(compareTextLevelsBaseline(3, 5)).toEqual({ count: 3, baseline: 5, over: 0, slack: 2 })
  expect(compareTextLevelsBaseline(5, 5)).toEqual({ count: 5, baseline: 5, over: 0, slack: 0 })
})

test("the baseline can be lowered but never raised", async () => {
  const root = await fixture({ "baseline.txt": formatTextLevelsBaseline(4) })
  const file = path.join(root, "baseline.txt")

  expect(updateTextLevelsBaseline(5, file)).toEqual({ written: false, over: 1 })
  expect(readTextLevelsBaseline(file)).toBe(4)

  expect(updateTextLevelsBaseline(2, file)).toEqual({ written: true, over: 0 })
  expect(readTextLevelsBaseline(file)).toBe(2)
  expect(await readFile(file, "utf8")).toBe(formatTextLevelsBaseline(2))
})

test("rejects a malformed baseline", () => {
  expect(() => parseTextLevelsBaseline("")).toThrow()
  expect(() => parseTextLevelsBaseline("# only a comment\n")).toThrow()
  expect(() => parseTextLevelsBaseline("12\n13\n")).toThrow()
  expect(() => parseTextLevelsBaseline("-1\n")).toThrow()
  expect(() => parseTextLevelsBaseline("1.5\n")).toThrow()
  expect(() => parseTextLevelsBaseline("many\n")).toThrow()
  expect(parseTextLevelsBaseline("# comment\n\n7\n")).toBe(7)
})