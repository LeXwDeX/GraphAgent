// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { DagSection } from "@/config/dag-section"
import { DagConfig } from "@/dag/config"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"

let dir: string
let projectDir: string
let globalDir: string
const originalConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
const originalHome = process.env.GRAPHAGENT_TEST_HOME
const originalDisableProjectConfig = process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG

beforeEach(async () => {
  // realpath keeps the resolved root comparable with git's real toplevel on
  // macOS, where /var is a symlink to /private/var.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-config-")))
  projectDir = path.join(dir, "project")
  globalDir = path.join(dir, "global")
  await fs.mkdir(projectDir, { recursive: true })
  // Redirect the user-level config dir (Global.Path.config reads the env) so
  // the tests never touch the real one.
  process.env.GRAPHAGENT_CONFIG_DIR = globalDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
  else process.env.GRAPHAGENT_TEST_HOME = originalHome
  if (originalDisableProjectConfig === undefined) delete process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG
  else process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG = originalDisableProjectConfig
  await fs.rm(dir, { recursive: true, force: true })
})

const writeFile = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const writeProjectSettings = (root: string, value: unknown, name = "settings.json") =>
  writeFile(path.join(root, ".agents", name), JSON.stringify(value, null, 2))

const section = (directory: string) => Effect.runPromise(DagSection.dagSection(directory))

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

describe("DagSection.dagSection", () => {
  it("reads the user-level dag section from graphagent.jsonc with comments and trailing commas", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.jsonc"),
      `{
        // model tiers
        "dag": {
          "model": { "advanced": "prov/big", "standard": "prov/small", },
          "thinking_depth": "high",
        },
      }`,
    )
    expect(await section(projectDir)).toEqual({
      model: { advanced: "prov/big", standard: "prov/small" },
      thinking_depth: "high",
    })
  })

  it("lets project settings override user values field by field", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({
        dag: { model: { advanced: "user/big", standard: "user/small" }, thinking_depth: "low" },
      }),
    )
    await writeProjectSettings(projectDir, { dag: { model: { standard: "project/small" } } })
    expect(await section(projectDir)).toEqual({
      model: { advanced: "user/big", standard: "project/small" },
      thinking_depth: "low",
    })
  })

  it("expands {env:} variables in dag values like the main config loader", async () => {
    process.env.DAG_SECTION_TEST_MODEL = "prov/env-model"
    try {
      await writeFile(
        path.join(globalDir, "graphagent.json"),
        JSON.stringify({ dag: { model: { standard: "{env:DAG_SECTION_TEST_MODEL}" } } }),
      )
      expect(await section(projectDir)).toEqual({ model: { standard: "prov/env-model" } })
    } finally {
      delete process.env.DAG_SECTION_TEST_MODEL
    }
  })

  it("ignores project settings when GRAPHAGENT_DISABLE_PROJECT_CONFIG is set", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({ dag: { model: { advanced: "user/big", standard: "user/small" } } }),
    )
    await writeProjectSettings(projectDir, {
      dag: { model: { standard: "project/small" }, thinking_depth: "high" },
    })
    process.env.GRAPHAGENT_DISABLE_PROJECT_CONFIG = "1"
    // The user layer survives; no project value leaks through.
    expect(await section(projectDir)).toEqual({ model: { advanced: "user/big", standard: "user/small" } })
  })

  it("applies settings.local.json over settings.json", async () => {
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "low" } })
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "max" } }, "settings.local.json")
    expect(await section(projectDir)).toEqual({ thinking_depth: "max" })
  })

  it("resolves the project root from a nested directory", async () => {
    await writeProjectSettings(projectDir, { dag: { model: { standard: "root/model" } } })
    const nested = path.join(projectDir, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    expect(await section(nested)).toEqual({ model: { standard: "root/model" } })
  })

  it("stops at a linked worktree's own toplevel instead of reading the main checkout", async () => {
    const main = path.join(dir, "repo")
    const linked = path.join(dir, "linked")
    await fs.mkdir(main, { recursive: true })
    git(main, "init")
    git(main, "config", "user.email", "test@opencode.test")
    git(main, "config", "user.name", "Test")
    git(main, "commit", "--allow-empty", "-m", "init")
    git(main, "worktree", "add", "--detach", linked, "HEAD")
    await writeProjectSettings(main, { dag: { model: { standard: "main/model" } } })

    expect(await section(main)).toEqual({ model: { standard: "main/model" } })

    const nested = path.join(linked, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    expect(await section(nested)).toEqual({})

    await writeProjectSettings(linked, { dag: { model: { advanced: "worktree/model" } } })
    expect(await section(nested)).toEqual({ model: { advanced: "worktree/model" } })
  })

  it("never treats $HOME as a project root", async () => {
    const home = path.join(dir, "home")
    process.env.GRAPHAGENT_TEST_HOME = home
    await writeProjectSettings(home, { dag: { model: { standard: "home/model" } } })
    const nested = path.join(home, "work")
    await fs.mkdir(nested, { recursive: true })
    try {
      expect(await section(home)).toEqual({})
      expect(await section(nested)).toEqual({})
    } finally {
      if (originalHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = originalHome
    }
  })

  it("ignores an invalid section without failing the round", async () => {
    await writeFile(
      path.join(globalDir, "graphagent.json"),
      JSON.stringify({ dag: { model: { standard: "user/model" } } }),
    )
    await writeProjectSettings(projectDir, { dag: { thinking_depth: "ultra" } })
    // The invalid project layer is skipped; the valid user layer survives.
    expect(await section(projectDir)).toEqual({ model: { standard: "user/model" } })

    await fs.rm(path.join(projectDir, ".agents"), { recursive: true })
    await writeFile(path.join(globalDir, "graphagent.json"), JSON.stringify({ dag: { thinking_depth: "ultra" } }))
    expect(await section(projectDir)).toEqual({})
  })

  it("is a pure read: no file is created in the config or project directories", async () => {
    await fs.mkdir(globalDir, { recursive: true })
    await writeProjectSettings(projectDir, { dag: { model: { standard: "project/model" } } })

    expect(await section(projectDir)).toEqual({ model: { standard: "project/model" } })
    expect(await fs.readdir(globalDir)).toEqual([])
    expect(await fs.readdir(path.join(projectDir, ".agents"))).toEqual(["settings.json"])
    // No legacy dag.jsonc is seeded anywhere.
    expect((await fs.readdir(projectDir)).sort()).toEqual([".agents"])
  })
})

describe("DagConfig.tierModel", () => {
  const info: DagConfig.Dag = { model: { advanced: "prov/big", standard: "prov/small" } }

  it("routes required nodes to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes review workers to the advanced tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "review-arch" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  it("routes ordinary workers to the standard tier", () => {
    expect(DagConfig.tierModel(info, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
  })

  it("uses a single configured tier as the unified default", () => {
    const only = { model: { standard: "prov/small" } }
    expect(DagConfig.tierModel(only, { required: true, workerType: "build" })).toEqual({
      providerID: "prov",
      modelID: "small",
    })
    const advancedOnly = { model: { advanced: "prov/big" } }
    expect(DagConfig.tierModel(advancedOnly, { required: false, workerType: "explore" })).toEqual({
      providerID: "prov",
      modelID: "big",
    })
  })

  // An empty tier (what uncommenting a placeholder `"advanced": ""` line
  // produces) is unconfigured: the other tier remains the unified default
  // instead of critical/required nodes silently falling through to the
  // worker-agent or parent-session model.
  it("falls back past an empty tier to the configured one", () => {
    const emptyAdvanced = { model: { advanced: "", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(emptyAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(DagConfig.tierModel(emptyAdvanced, { required: false, workerType: "review" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const emptyStandard = { model: { advanced: "anthropic/claude", standard: "" } }
    expect(DagConfig.tierModel(emptyStandard, { required: false, workerType: "build" })).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    })
  })

  it("treats a whitespace-only tier as unconfigured and trims tier components", () => {
    const blankAdvanced = { model: { advanced: " / ", standard: "openai/gpt-5" } }
    expect(DagConfig.tierModel(blankAdvanced, { required: true, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    const padded = { model: { standard: " openai / gpt-5 " } }
    expect(DagConfig.tierModel(padded, { required: false, workerType: "build" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  it("keeps only the first slash as the provider separator", () => {
    const nested = { model: { standard: "local-proxy-compatible/qwen3.8-max-preview" } }
    expect(DagConfig.tierModel(nested, { required: false, workerType: "explore" })).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "qwen3.8-max-preview",
    })
  })

  it("returns undefined for missing or malformed refs", () => {
    expect(DagConfig.tierModel({}, { required: true, workerType: "build" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "no-slash" } }, { required: false, workerType: "x" })).toBeUndefined()
    expect(DagConfig.tierModel({ model: { standard: "prov/" } }, { required: false, workerType: "x" })).toBeUndefined()
  })
})