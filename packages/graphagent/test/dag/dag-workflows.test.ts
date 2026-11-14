// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { DagWorkflows } from "@/dag/workflows"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { testEffect } from "../lib/effect"

const itEffect = testEffect(Layer.empty)

let dir: string
let projectDir: string
let globalDir: string
const originalConfigDir = process.env.GRAPHAGENT_CONFIG_DIR

const spec = (name: string, nodes: number) =>
  [
    `title: ${name} title`,
    "config:",
    `  name: ${name}`,
    "  nodes:",
    ...Array.from({ length: nodes }, (_, index) => `    - id: node-${index}`),
  ].join("\n")

const writeProject = (file: string, content: string) =>
  fs
    .mkdir(path.join(projectDir, ".agents", "workflows"), { recursive: true })
    .then(() => fs.writeFile(path.join(projectDir, ".agents", "workflows", file), content))

const writeGlobal = (file: string, content: string) =>
  fs
    .mkdir(path.join(globalDir, "workflows"), { recursive: true })
    .then(() => fs.writeFile(path.join(globalDir, "workflows", file), content))

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-workflows-")))
  projectDir = path.join(dir, "project")
  globalDir = path.join(dir, "global")
  await fs.mkdir(projectDir, { recursive: true })
  // The user-level config dir comes from Global.Path.config, which reads the
  // env — redirect it so the real one is never read or written.
  process.env.GRAPHAGENT_CONFIG_DIR = globalDir
})

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = originalConfigDir
  await fs.rm(dir, { recursive: true, force: true })
})

describe("DagWorkflows.isName", () => {
  it("treats bare identifiers as names", () => {
    expect(DagWorkflows.isName("code-review")).toBe(true)
    expect(DagWorkflows.isName("review_v2")).toBe(true)
  })

  it("treats anything path-shaped as a path, so existing spec_path calls keep working", () => {
    expect(DagWorkflows.isName("review.yaml")).toBe(false)
    expect(DagWorkflows.isName("review.YML")).toBe(false)
    expect(DagWorkflows.isName(".agents/workflows/review.yaml")).toBe(false)
    expect(DagWorkflows.isName("./review")).toBe(false)
    expect(DagWorkflows.isName("../review")).toBe(false)
    expect(DagWorkflows.isName("dir\\review")).toBe(false)
    expect(DagWorkflows.isName("/abs/review.yaml")).toBe(false)
    expect(DagWorkflows.isName("")).toBe(false)
  })

  it("rejects control characters, which would make the filesystem lookup throw", () => {
    expect(DagWorkflows.isName("a\u0000b")).toBe(false)
    expect(DagWorkflows.isName("a\nb")).toBe(false)
  })
})

describe("DagWorkflows.resolve", () => {
  it("resolves a project workflow", async () => {
    await writeProject("code-review.yaml", spec("code-review", 3))
    const entry = await Effect.runPromise(DagWorkflows.resolve("code-review", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.path).toBe(path.join(projectDir, ".agents", "workflows", "code-review.yaml"))
    expect(entry?.title).toBe("code-review title")
    expect(entry?.nodes).toBe(3)
  })

  itEffect.live("normalizes and bounds the objective used for route selection", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProject(
          "bounded-objective.yaml",
          [
            "title: bounded objective",
            "config:",
            "  name: bounded-objective",
            "  objective: >-",
            `    ${"evidence ".repeat(40)}`,
            "    final outcome",
            "  nodes: []",
          ].join("\n"),
        ),
      )

      const entry = yield* DagWorkflows.resolve("bounded-objective", projectDir)

      expect(entry?.objective).not.toContain("\n")
      expect(entry?.objective).not.toContain("  ")
      expect(entry?.objective?.length).toBe(240)
      expect(entry?.objective).toEndWith("…")
    }),
  )

  it("resolves a global workflow when the project has none", async () => {
    await writeGlobal("research.yaml", spec("research", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("research", projectDir))
    expect(entry?.scope).toBe("global")
    expect(entry?.path).toBe(path.join(globalDir, "workflows", "research.yaml"))
  })

  it("lets the project scope shadow a global workflow of the same name", async () => {
    await writeGlobal("code-review.yaml", spec("global-version", 1))
    await writeProject("code-review.yaml", spec("project-version", 2))
    const entry = await Effect.runPromise(DagWorkflows.resolve("code-review", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.title).toBe("project-version title")
  })

  it("accepts the .yml extension", async () => {
    await writeProject("short.yml", spec("short", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("short", projectDir))
    expect(entry?.path).toEndWith("short.yml")
  })

  it("prefers .yaml over .yml within the same scope", async () => {
    await writeProject("both.yml", spec("yml-version", 1))
    await writeProject("both.yaml", spec("yaml-version", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("both", projectDir))
    expect(entry?.title).toBe("yaml-version title")
  })

  it("returns undefined for an unknown name so the caller can report the searched paths", async () => {
    expect(await Effect.runPromise(DagWorkflows.resolve("missing", projectDir))).toBeUndefined()
    expect(DagWorkflows.searchPaths(projectDir)).toEqual([
      path.join(projectDir, ".agents", "workflows"),
      path.join(globalDir, "workflows"),
    ])
  })

  it("still resolves a spec it cannot parse — the start path reports the real error", async () => {
    await writeProject("broken.yaml", "config: [unclosed")
    const entry = await Effect.runPromise(DagWorkflows.resolve("broken", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.title).toBeUndefined()
    expect(entry?.nodes).toBeUndefined()
  })

  it("resolves the library from the project root of a nested directory", async () => {
    await writeProject("root-level.yaml", spec("root-level", 1))
    const nested = path.join(projectDir, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    const entry = await Effect.runPromise(DagWorkflows.resolve("root-level", nested))
    expect(entry?.scope).toBe("project")
    expect(entry?.path).toBe(path.join(projectDir, ".agents", "workflows", "root-level.yaml"))
  })

  it("does not treat $HOME/.agents as a project library", async () => {
    const home = path.join(dir, "home")
    await fs.mkdir(path.join(home, ".agents", "workflows"), { recursive: true })
    await fs.writeFile(path.join(home, ".agents", "workflows", "home-only.yaml"), spec("home-only", 1))
    const previous = process.env.GRAPHAGENT_TEST_HOME
    process.env.GRAPHAGENT_TEST_HOME = home
    try {
      expect(await Effect.runPromise(DagWorkflows.resolve("home-only", home))).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = previous
    }
  })

  it("keeps a linked worktree's library separate from the main checkout", async () => {
    const main = path.join(dir, "repo")
    const linked = path.join(dir, "linked")
    await fs.mkdir(main, { recursive: true })
    git(main, "init")
    git(main, "config", "user.email", "test@opencode.test")
    git(main, "config", "user.name", "Test")
    git(main, "commit", "--allow-empty", "-m", "init")
    git(main, "worktree", "add", "--detach", linked, "HEAD")
    await fs.mkdir(path.join(main, ".agents", "workflows"), { recursive: true })
    await fs.writeFile(path.join(main, ".agents", "workflows", "main-only.yaml"), spec("main-only", 1))

    // The linked worktree's toplevel bounds resolution: the main checkout's
    // library is not visible from it.
    expect(await Effect.runPromise(DagWorkflows.resolve("main-only", linked))).toBeUndefined()

    const linkedRoot = await fs.realpath(linked)
    await fs.mkdir(path.join(linkedRoot, ".agents", "workflows"), { recursive: true })
    await fs.writeFile(path.join(linkedRoot, ".agents", "workflows", "linked-only.yaml"), spec("linked-only", 1))
    const nested = path.join(linkedRoot, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    const entry = await Effect.runPromise(DagWorkflows.resolve("linked-only", nested))
    expect(entry?.scope).toBe("project")
    expect(entry?.path).toBe(path.join(linkedRoot, ".agents", "workflows", "linked-only.yaml"))
  })
})

describe("DagWorkflows.list", () => {
  it("returns nothing when neither scope exists", async () => {
    expect(await Effect.runPromise(DagWorkflows.list(projectDir))).toEqual([])
  })

  it("merges both scopes, sorted by name, project shadowing global", async () => {
    await writeGlobal("shared.yaml", spec("global-shared", 1))
    await writeGlobal("only-global.yaml", spec("only-global", 4))
    await writeProject("shared.yaml", spec("project-shared", 2))
    await writeProject("a-first.yaml", spec("a-first", 1))

    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries.map((entry) => [entry.name, entry.scope])).toEqual([
      ["a-first", "project"],
      ["only-global", "global"],
      ["shared", "project"],
    ])
    expect(entries.find((entry) => entry.name === "shared")?.title).toBe("project-shared title")
    expect(entries.find((entry) => entry.name === "only-global")?.nodes).toBe(4)
  })

  it("ignores non-spec files and directories", async () => {
    await writeProject("real.yaml", spec("real", 1))
    await writeProject("notes.md", "not a spec")
    await fs.mkdir(path.join(projectDir, ".agents", "workflows", "nested.yaml"), { recursive: true })

    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries.map((entry) => entry.name)).toEqual(["real"])
  })

  it("leaves title undefined when the spec declares none", async () => {
    await writeProject("untitled.yaml", "config:\n  name: from-config\n  nodes: []")
    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries[0]?.title).toBeUndefined()
    expect(entries[0]?.nodes).toBe(0)
  })
})
