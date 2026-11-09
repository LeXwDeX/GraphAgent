// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ensureLocalExcludes, LOCAL_GIT_EXCLUDES, repoLayout } from "@/project/git-exclude"
import { tmpdir } from "../fixture/fixture"

async function excludeLines(root: string) {
  const layout = await repoLayout(root)
  expect(layout).toBeDefined()
  const text = await fs.readFile(path.join(layout!.commonDir, "info", "exclude"), "utf8")
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

describe("ensureLocalExcludes", () => {
  test("anchors the project-local entries at the repository root", async () => {
    await using tmp = await tmpdir({ git: true })

    await ensureLocalExcludes({ root: tmp.path })
    await ensureLocalExcludes({ root: tmp.path })

    expect(await excludeLines(tmp.path)).toEqual(LOCAL_GIT_EXCLUDES.map((entry) => `/${entry}`))
  })

  test("prefixes entries when the project root sits below the git toplevel", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = path.join(tmp.path, "pkg", "a")
    await fs.mkdir(root, { recursive: true })

    await ensureLocalExcludes({ root })

    expect(await excludeLines(tmp.path)).toEqual(LOCAL_GIT_EXCLUDES.map((entry) => `/pkg/a/${entry}`))
  })

  test("skips directories that are not git repositories", async () => {
    await using tmp = await tmpdir()

    await ensureLocalExcludes({ root: tmp.path })

    expect(await fs.readdir(path.join(tmp.path, ".git")).catch(() => undefined)).toBeUndefined()
  })
})
