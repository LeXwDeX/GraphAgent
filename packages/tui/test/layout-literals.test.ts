// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  LAYOUT_BASELINE_PATH,
  collectLayoutLiterals,
  compareLayoutBaseline,
  formatLayoutBaseline,
  formatLayoutFailure,
  formatLayoutLiteral,
  parseLayoutBaseline,
  readLayoutBaseline,
  updateLayoutBaseline,
} from "../script/check-layout-literals"

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-layout-"))
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

function found(literals: ReturnType<typeof collectLayoutLiterals>) {
  return literals.map(formatLayoutLiteral)
}

test("the source tree has no more layout literals than the baseline allows", () => {
  const literals = collectLayoutLiterals()
  const comparison = compareLayoutBaseline(literals.length, readLayoutBaseline())
  expect(
    comparison.over,
    `use the tokens in src/ui/layout.ts; the baseline only goes down\n${literals.map(formatLayoutLiteral).join("\n")}`,
  ).toBe(0)
})

test("the baseline file is canonical", async () => {
  const raw = await readFile(LAYOUT_BASELINE_PATH, "utf8")
  expect(formatLayoutBaseline(parseLayoutBaseline(raw))).toBe(raw)
})

test("counts a number written straight after an edge name, in JSX attributes and in objects", async () => {
  const root = await fixture({
    "shell/a.tsx": [
      "export const A = () => (",
      "  <box paddingLeft={2} paddingRight={1 + shift} marginLeft={0} marginRight={-1}>",
      "    <scrollbox",
      "      verticalScrollbarOptions={{ paddingLeft: 1, marginRight: 3 }}",
      '      viewportOptions={{ "paddingRight": 1 }}',
      "    />",
      "  </box>",
      ")",
      "",
    ].join("\n"),
  })
  expect(found(collectLayoutLiterals({ root }))).toEqual([
    "shell/a.tsx:2 paddingLeft={2}",
    "shell/a.tsx:2 paddingRight={1 + shift}",
    "shell/a.tsx:2 marginLeft={0}",
    "shell/a.tsx:2 marginRight={-1}",
    "shell/a.tsx:4 paddingLeft: 1",
    "shell/a.tsx:4 marginRight: 3",
    'shell/a.tsx:5 "paddingRight": 1',
  ])
})

test("leaves tokens, expressions, other edges and text alone", async () => {
  const root = await fixture({
    "routes/b.tsx": [
      'import { GUTTER, ROW_INDENT } from "../ui/layout"',
      "export const B = (props: { indent: number; scrollbar: boolean }) => (",
      "  <box paddingLeft={GUTTER} paddingRight={GUTTER * 2} marginLeft={ROW_INDENT + 1} marginRight={props.indent}>",
      "    <box paddingTop={2} paddingBottom={1} marginTop={1} padding={2} paddingX={2} gap={2} width={40} />",
      "    <box viewportOptions={{ paddingRight: props.scrollbar ? 1 : 0, paddingLeft: GUTTER }} />",
      '    <text paddingLeft="2">{"paddingLeft={2}"}</text>',
      "    <text>paddingLeft: 2</text>",
      "    {/* paddingLeft={2} */}",
      "  </box>",
      ")",
      "// paddingRight: 2",
      "",
    ].join("\n"),
  })
  expect(found(collectLayoutLiterals({ root }))).toEqual([])
})

test("scans shell, routes, panel and component, in both .ts and .tsx, and nothing else", async () => {
  const root = await fixture({
    "shell/a.ts": "export const a = { paddingLeft: 1 }\n",
    "routes/session/b.tsx": "export const b = <box paddingLeft={2} />\n",
    "panel/c.tsx": "export const c = <box marginRight={3} />\n",
    "component/prompt/d.tsx": "export const d = <box paddingRight={4} />\n",
    "ui/e.tsx": "export const e = <box paddingLeft={5} />\n",
    "context/f.ts": "export const f = { paddingLeft: 6 }\n",
    "app.tsx": "export const g = <box paddingLeft={7} />\n",
  })
  expect(found(collectLayoutLiterals({ root }))).toEqual([
    "component/prompt/d.tsx:1 paddingRight={4}",
    "panel/c.tsx:1 marginRight={3}",
    "routes/session/b.tsx:1 paddingLeft={2}",
    "shell/a.ts:1 paddingLeft: 1",
  ])
  expect(found(collectLayoutLiterals({ root, dirs: ["ui"] }))).toEqual(["ui/e.tsx:1 paddingLeft={5}"])
})

test("a tree with one literal over the baseline fails and lists where every literal is", async () => {
  const root = await fixture({
    "shell/ok.tsx": "export const a = <box paddingLeft={2} />\n",
    "routes/new.tsx": "export const b = <box paddingLeft={3} />\n",
  })
  const literals = collectLayoutLiterals({ root })
  const comparison = compareLayoutBaseline(literals.length, 1)
  expect(comparison).toEqual({ count: 2, baseline: 1, over: 1, slack: 0 })
  const message = formatLayoutFailure(comparison, literals)
  expect(message).toContain("2 found, the baseline allows 1")
  expect(message).toContain("routes/new.tsx:1 paddingLeft={3}")
  expect(message).toContain("shell/ok.tsx:1 paddingLeft={2}")
})

test("a tree below the baseline passes and says how far the baseline can drop", () => {
  expect(compareLayoutBaseline(3, 5)).toEqual({ count: 3, baseline: 5, over: 0, slack: 2 })
  expect(compareLayoutBaseline(5, 5)).toEqual({ count: 5, baseline: 5, over: 0, slack: 0 })
})

test("the baseline can be lowered but never raised", async () => {
  const root = await fixture({ "baseline.txt": formatLayoutBaseline(4) })
  const file = path.join(root, "baseline.txt")

  expect(updateLayoutBaseline(5, file)).toEqual({ written: false, over: 1 })
  expect(readLayoutBaseline(file)).toBe(4)

  expect(updateLayoutBaseline(2, file)).toEqual({ written: true, over: 0 })
  expect(readLayoutBaseline(file)).toBe(2)
  expect(await readFile(file, "utf8")).toBe(formatLayoutBaseline(2))
})

test("rejects a malformed baseline", () => {
  expect(() => parseLayoutBaseline("")).toThrow()
  expect(() => parseLayoutBaseline("# only a comment\n")).toThrow()
  expect(() => parseLayoutBaseline("12\n13\n")).toThrow()
  expect(() => parseLayoutBaseline("-1\n")).toThrow()
  expect(() => parseLayoutBaseline("1.5\n")).toThrow()
  expect(() => parseLayoutBaseline("many\n")).toThrow()
  expect(parseLayoutBaseline("# comment\n\n7\n")).toBe(7)
})
