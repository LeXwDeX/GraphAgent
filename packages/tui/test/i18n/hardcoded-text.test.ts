import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkTuiText } from "../../script/check-tui-text"

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-text-"))
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

test("current source tree has no hardcoded CJK text", () => {
  expect(checkTuiText()).toEqual([])
})

test("detects CJK in string literals, template literals and JSX text", async () => {
  const root = await fixture({
    "ui/a.ts": `const plain = "中文"\nconst template = \`前缀\${plain}后缀\`\n`,
    "ui/b.tsx": `export const A = () => <text>中文</text>\n`,
  })
  const violations = checkTuiText({ root, exclude: [] })
  const sorted = [...violations].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  expect(sorted.map((violation) => [violation.file, violation.line, violation.text])).toEqual([
    ["ui/a.ts", 1, "中文"],
    ["ui/a.ts", 2, "前缀"],
    ["ui/a.ts", 2, "后缀"],
    ["ui/b.tsx", 1, "中文"],
  ])
})

test("ignores comments", async () => {
  const root = await fixture({
    "ui/a.ts": `// 这是注释\nexport const value = 1 /* 中文注释 */\n`,
  })
  expect(checkTuiText({ root, exclude: [] })).toEqual([])
})

test("skips the message tables", async () => {
  const root = await fixture({
    "i18n/zh-CN.ts": `export const zhCN = { "goal.title": "目标" }\n`,
    "ui/a.ts": `export const value = 1\n`,
  })
  expect(checkTuiText({ root })).toEqual([])
})
