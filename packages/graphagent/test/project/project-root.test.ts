// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { mkdirSync, statSync, symlinkSync } from "fs"
import path from "path"
import { assertProjectRootWritable, hasProjectLayer, HOME_ROOT_ERROR, resolveProjectRoot } from "@/project/project-root"
import { tmpdir } from "../fixture/fixture"

type Case = {
  name: string
  directory: string
  home: string
  toplevel?: string
  agents: string[]
  expected: string
}

const cases = (await Bun.file(
  path.join(import.meta.dir, "../fixtures/project-root-cases.json"),
).json()) as Case[]

const HOME = "/home/tester"
const expand = (value: string) => value.replaceAll("$HOME", HOME)

function statIsDirectory(candidate: string) {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

describe("resolveProjectRoot", () => {
  for (const item of cases) {
    test(item.name, () => {
      const agents = new Set(item.agents.map(expand))
      expect(
        resolveProjectRoot(expand(item.directory), {
          home: expand(item.home),
          toplevel: item.toplevel ? expand(item.toplevel) : undefined,
          isDirectory: (candidate) => agents.has(candidate),
        }),
      ).toBe(expand(item.expected))
    })
  }

  // #1437: `$HOME` from the environment and a `process.cwd()`-derived directory
  // can disagree on whether a symlink has been followed (macOS in particular
  // hands back a resolved cwd while `$HOME` can still carry a symlinked
  // prefix). Real symlinks on disk exercise that mismatch directly, unlike
  // the fixture cases above, whose paths never exist on the test machine.
  test("does not cross a symlinked $HOME to reach a marker above it", async () => {
    await using tmp = await tmpdir()
    const outer = path.join(tmp.path, "outer")
    mkdirSync(path.join(outer, ".agents"), { recursive: true })
    const realHome = path.join(outer, "real-home")
    mkdirSync(realHome)
    const linkedHome = path.join(tmp.path, "linked-home")
    symlinkSync(realHome, linkedHome)

    const root = resolveProjectRoot(realHome, { home: linkedHome, isDirectory: statIsDirectory })

    expect(root).toBe(realHome)
  })

  test("does not climb past $HOME when starting from a symlinked spelling below it", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".agents"))
    const realHome = path.join(tmp.path, "real-home")
    mkdirSync(path.join(realHome, "proj"), { recursive: true })
    const linkedHome = path.join(tmp.path, "linked-home")
    symlinkSync(realHome, linkedHome)
    const start = path.join(linkedHome, "proj")

    const root = resolveProjectRoot(start, { home: realHome, isDirectory: statIsDirectory })

    expect(root).toBe(start)
  })
})

describe("assertProjectRootWritable", () => {
  test("rejects $HOME as the project root", () => {
    expect(() => assertProjectRootWritable(HOME, HOME)).toThrow(HOME_ROOT_ERROR)
  })

  test("allows a project root below $HOME", () => {
    expect(() => assertProjectRootWritable(path.join(HOME, "repo"), HOME)).not.toThrow()
  })

  test("rejects a project root that resolves to $HOME through a symlinked $HOME", async () => {
    await using tmp = await tmpdir()
    const realHome = path.join(tmp.path, "real-home")
    mkdirSync(realHome)
    const linkedHome = path.join(tmp.path, "linked-home")
    symlinkSync(realHome, linkedHome)

    expect(() => assertProjectRootWritable(realHome, linkedHome)).toThrow(HOME_ROOT_ERROR)
  })

  test("rejects a project root that is a symlink to the real $HOME", async () => {
    await using tmp = await tmpdir()
    const realHome = path.join(tmp.path, "real-home")
    mkdirSync(realHome)
    const linkedRoot = path.join(tmp.path, "linked-root")
    symlinkSync(realHome, linkedRoot)

    expect(() => assertProjectRootWritable(linkedRoot, realHome)).toThrow(HOME_ROOT_ERROR)
  })
})

describe("hasProjectLayer", () => {
  test("treats $HOME as carrying no project layer", () => {
    expect(hasProjectLayer(HOME, HOME)).toBe(false)
  })

  test("treats a directory below $HOME as a project layer", () => {
    expect(hasProjectLayer(path.join(HOME, "repo"), HOME)).toBe(true)
  })
})
