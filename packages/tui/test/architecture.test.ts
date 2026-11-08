import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkTuiImports } from "../script/check-tui-imports"

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tui-architecture-"))
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

test("current source tree respects the dependency direction", async () => {
  expect(await checkTuiImports()).toEqual([])
})

test("ui/ may not call the SDK", async () => {
  const root = await fixture({
    "ui/bad.ts": `export function bad() { return sdk.client.session.list() }\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({
      file: "ui/bad.ts",
      specifier: "sdk.client",
      reason: expect.stringContaining("may not call the SDK"),
    }),
  ])
})

test("dag/ may not import panel/", async () => {
  const root = await fixture({
    "dag/bad.ts": `import { PanelShell } from "../panel/shell"\nexport const value = PanelShell\n`,
    "panel/shell.ts": `export const PanelShell = 1\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({
      file: "dag/bad.ts",
      specifier: "../panel/shell",
      reason: expect.stringContaining("panel/"),
    }),
  ])
})

test("dag/ may not import solid-js", async () => {
  const root = await fixture({
    "dag/bad.ts": `import { createSignal } from "solid-js"\nexport const value = createSignal(0)\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({ file: "dag/bad.ts", specifier: "solid-js", reason: expect.stringContaining("solid-js") }),
  ])
})

test("context/ may not import routes/", async () => {
  const root = await fixture({
    "context/bad.ts": `import { Home } from "../routes/home"\nexport const value = Home\n`,
    "routes/home/index.tsx": `export const Home = 1\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({
      file: "context/bad.ts",
      specifier: "../routes/home",
      reason: expect.stringContaining("routes/"),
    }),
  ])
})

test("ui/ may read theme tokens", async () => {
  const root = await fixture({
    "ui/good.ts": `import { useTheme } from "../context/theme"\nexport const value = useTheme\n`,
    "context/theme.tsx": `export function useTheme() { return undefined }\n`,
  })
  expect(await checkTuiImports({ root, exemptions: [] })).toEqual([])
})
