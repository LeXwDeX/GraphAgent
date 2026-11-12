// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { EXEMPTIONS, checkTuiImports, findStaleExemptions, type Exemption } from "../script/check-tui-imports"

const TUI_DIR = path.join(import.meta.dir, "..")
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

test("every exemption still covers an import in the source tree", async () => {
  expect(await findStaleExemptions()).toEqual([])
})

test("every exemption names the Issue that removes it", () => {
  for (const entry of EXEMPTIONS) expect(entry.issue).toMatch(/\(#\d+\)/)
})

function exportTarget(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  if ("import" in value && typeof value.import === "string") return value.import
  if ("default" in value && typeof value.default === "string") return value.default
  return undefined
}

test("every package export points at an existing file", async () => {
  const pkg: { exports?: Record<string, unknown> } = await Bun.file(path.join(TUI_DIR, "package.json")).json()
  const missing: string[] = []
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = exportTarget(value)
    if (!target || !(await Bun.file(path.join(TUI_DIR, target)).exists())) missing.push(`${key} -> ${target}`)
  }
  expect(missing).toEqual([])
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

test("shell/ may not call the SDK", async () => {
  const root = await fixture({
    "shell/bad.ts": `export function bad() { return sdk.client.session.list() }\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({
      file: "shell/bad.ts",
      specifier: "sdk.client",
      reason: expect.stringContaining("may not call the SDK"),
    }),
  ])
})

test("shell/ may not import routes/", async () => {
  const root = await fixture({
    "shell/bad.ts": `import { Home } from "../routes/home"\nexport const value = Home\n`,
    "routes/home/index.tsx": `export const Home = 1\n`,
  })
  const violations = await checkTuiImports({ root, exemptions: [] })
  expect(violations).toEqual([
    expect.objectContaining({
      file: "shell/bad.ts",
      specifier: "../routes/home",
      reason: expect.stringContaining("routes/"),
    }),
  ])
})

const covered: Exemption = { file: "context/local.tsx", target: "ui/toast", issue: "F3 (#1020): fixture" }

test("an exemption keeps covering the import it names", async () => {
  const root = await fixture({
    "context/local.tsx": `import { useToast } from "../ui/toast"\nexport const value = useToast\n`,
    "ui/toast.tsx": `export const useToast = 1\n`,
  })
  expect(await checkTuiImports({ root, exemptions: [covered] })).toEqual([])
  expect(await findStaleExemptions({ root, exemptions: [covered] })).toEqual([])
})

test("an exemption is stale once its file stops importing the target", async () => {
  const root = await fixture({
    "context/local.tsx": `export const value = 1\n`,
    "ui/toast.tsx": `export const useToast = 1\n`,
  })
  expect(await findStaleExemptions({ root, exemptions: [covered] })).toEqual([covered])
})

test("an exemption is stale once its file is gone", async () => {
  const root = await fixture({ "ui/toast.tsx": `export const useToast = 1\n` })
  expect(await findStaleExemptions({ root, exemptions: [covered] })).toEqual([covered])
})

test("an exemption is stale once the rules allow its import", async () => {
  const sibling: Exemption = { file: "context/local.tsx", target: "context/sibling", issue: "F3 (#1020): fixture" }
  const root = await fixture({
    "context/local.tsx": `import { value } from "./sibling"\nexport const other = value\n`,
    "context/sibling.ts": `export const value = 1\n`,
  })
  expect(await findStaleExemptions({ root, exemptions: [sibling] })).toEqual([sibling])
})
