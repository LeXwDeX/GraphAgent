import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { __chainCandidates, __deprecatedSettingsPaths, summarizeChain } from "@/hook/settings"
import { __watchedFiles } from "@/hook/extensions/hot-reload"
import { hasWorktreeLayer } from "@/hook/workspace-trust"

// A non-VCS project reports the filesystem root as its worktree
// (packages/opencode/src/project/project.ts). Treating that as a layer would
// make every session read and poll `<root>/.opencode/hooks.json`, a file the
// workspace does not own. These tests pin the candidate lists so a regression
// is caught even when no file exists at the root.

const root = path.parse(process.cwd()).root
const project = path.join(root, "graphagent-worktree-layer-test", "project")
const worktree = path.join(root, "graphagent-worktree-layer-test", "worktree")
const globalConfig = path.join(root, "graphagent-worktree-layer-test", "global")

describe("hasWorktreeLayer", () => {
  test("rejects a missing or identical worktree", () => {
    expect(hasWorktreeLayer(project, undefined)).toBe(false)
    expect(hasWorktreeLayer(project, "")).toBe(false)
    expect(hasWorktreeLayer(project, project)).toBe(false)
  })

  test("rejects the filesystem root", () => {
    expect(hasWorktreeLayer(project, root)).toBe(false)
  })

  test("accepts a distinct worktree", () => {
    expect(hasWorktreeLayer(project, worktree)).toBe(true)
  })
})

describe("hooks.json chain candidates", () => {
  test("does not read a worktree layer from the filesystem root", () => {
    const layers = __chainCandidates(project, root, globalConfig)
    expect(layers.map((layer) => layer.scope)).toEqual(["global", "project"])
    expect(layers.some((layer) => layer.file === path.join(root, ".opencode", "hooks.json"))).toBe(false)
  })

  test("reads a distinct worktree layer", () => {
    const layers = __chainCandidates(project, worktree, globalConfig)
    expect(layers.map((layer) => layer.scope)).toEqual(["global", "project", "worktree"])
    expect(layers.at(-1)?.file).toBe(path.join(worktree, ".opencode", "hooks.json"))
  })

  test("skips a worktree equal to the project directory", () => {
    expect(__chainCandidates(project, project, globalConfig).map((layer) => layer.scope)).toEqual(["global", "project"])
  })
})

describe("deprecated settings scan", () => {
  test("does not scan the filesystem root", () => {
    const paths = __deprecatedSettingsPaths(globalConfig, project, root)
    expect(paths).not.toContain(path.join(root, ".opencode", "settings.json"))
    expect(paths).not.toContain(path.join(root, ".opencode", "settings.local.json"))
  })

  test("scans a distinct worktree", () => {
    const paths = __deprecatedSettingsPaths(globalConfig, project, worktree)
    expect(paths).toContain(path.join(worktree, ".opencode", "settings.json"))
    expect(paths).toContain(path.join(worktree, ".opencode", "settings.local.json"))
  })
})

describe("hot reload watched files", () => {
  test("does not poll a hooks file at the filesystem root", () => {
    expect(__watchedFiles(project, root, globalConfig)).toEqual([
      path.join(globalConfig, "hooks.json"),
      path.join(project, ".opencode", "hooks.json"),
    ])
  })

  test("polls a distinct worktree hooks file", () => {
    expect(__watchedFiles(project, worktree, globalConfig)).toContain(path.join(worktree, ".opencode", "hooks.json"))
  })
})

describe("chain loading", () => {
  test("loads only the project layer when the worktree is the filesystem root", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "hook-worktree-layer-"))
    try {
      const dir = path.join(base, "project")
      const global = path.join(base, "global")
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await fs.writeFile(
        path.join(dir, ".opencode", "hooks.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "printf project" }] }] } }),
      )

      const summaries = summarizeChain(dir, root, global)
      expect(summaries.map((summary) => summary.scope)).toEqual(["project"])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
