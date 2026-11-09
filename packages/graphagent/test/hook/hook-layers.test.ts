import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { __chainCandidates, summarizeChain } from "@/hook"
import { __watchedFiles } from "@/hook/extensions/hot-reload"

// The project hooks layer is a single directory: `<root>/.agents/hooks.json`
// (committed) followed by `<root>/.agents/hooks.local.json` (local). There is no
// worktree layer — a linked worktree is itself a project root. These tests pin
// the candidate lists so adding or reordering a layer is deliberate.

const project = path.join(process.cwd(), "graphagent-hook-layers-test", "project")
const globalConfig = path.join(process.cwd(), "graphagent-hook-layers-test", "global")

describe("hooks.json chain candidates", () => {
  test("reads global, project and local files in that order", () => {
    const layers = __chainCandidates(project, globalConfig)
    expect(layers).toEqual([
      { scope: "global", file: path.join(globalConfig, "hooks.json") },
      { scope: "project", file: path.join(project, ".agents", "hooks.json") },
      { scope: "local", file: path.join(project, ".agents", "hooks.local.json") },
    ])
  })
})

describe("hot reload watched files", () => {
  test("polls the global, project and local hooks files", () => {
    expect(__watchedFiles(project, globalConfig)).toEqual([
      path.join(globalConfig, "hooks.json"),
      path.join(project, ".agents", "hooks.json"),
      path.join(project, ".agents", "hooks.local.json"),
    ])
  })
})

describe("chain loading", () => {
  test("merges global, project and local hooks in order", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "hook-layers-"))
    try {
      const dir = path.join(base, "project")
      const global = path.join(base, "global")
      await fs.mkdir(path.join(dir, ".agents"), { recursive: true })
      await fs.mkdir(global, { recursive: true })
      const hook = (command: string) => ({
        Stop: [{ hooks: [{ type: "command" as const, command }] }],
      })
      await fs.writeFile(path.join(global, "hooks.json"), JSON.stringify(hook("printf global")))
      await fs.writeFile(path.join(dir, ".agents", "hooks.json"), JSON.stringify(hook("printf project")))
      await fs.writeFile(path.join(dir, ".agents", "hooks.local.json"), JSON.stringify(hook("printf local")))

      const summaries = summarizeChain(dir, global)
      expect(summaries.map((summary) => summary.scope)).toEqual(["global", "project", "local"])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("loads only the local file when it is the only hooks source", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "hook-layers-local-"))
    try {
      const dir = path.join(base, "project")
      const global = path.join(base, "global")
      await fs.mkdir(path.join(dir, ".agents"), { recursive: true })
      await fs.writeFile(
        path.join(dir, ".agents", "hooks.local.json"),
        JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "printf local" }] }] }),
      )

      const summaries = summarizeChain(dir, global)
      expect(summaries.map((summary) => summary.scope)).toEqual(["local"])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
