import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { loadChain, mergeSettings, readJSON, type Settings } from "@/hook/settings"
import { watchSettings } from "@/hook/extensions"
import { __watchedFiles } from "@/hook/extensions/hot-reload"

// §4 unit tests for loadChain + hot-reload.
//
// Each test builds isolated temp dirs for the global and project scopes and
// drives loadChain (or watchSettings) directly. The project scope is a single
// `<root>/.agents/` directory holding the committed `hooks.json` plus the local
// `hooks.local.json`; there is no worktree layer because a linked worktree is
// itself a project root. loadChain's optional second arg `globalConfig` points
// the global layer at an isolated temp dir instead of the real
// ~/.config/graphagent, so no real-machine state is touched.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function mktmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hook-${prefix}-`))
  return dir
}

// Top-level-events hooks.json content (D1 canonical format): event names are
// top-level keys. `marker` is the shell command so merge-order tests can tell
// layers apart by inspecting the concatenated matcher list.
const hooksJsonTopLevel = (marker: string) => ({
  SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: marker }] }],
})

// Legacy wrapper format {"hooks": {...}} — tolerated via graceful degradation.
const hooksJsonWrapped = (marker: string) => ({
  hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: marker }] }] },
})

async function writeHooksJson(dir: string, json: unknown): Promise<string> {
  const graphagentDir = path.join(dir, ".agents")
  await fs.mkdir(graphagentDir, { recursive: true })
  const file = path.join(graphagentDir, "hooks.json")
  await fs.writeFile(file, JSON.stringify(json))
  return file
}

async function writeLocalHooksJson(dir: string, json: unknown): Promise<string> {
  const graphagentDir = path.join(dir, ".agents")
  await fs.mkdir(graphagentDir, { recursive: true })
  const file = path.join(graphagentDir, "hooks.local.json")
  await fs.writeFile(file, JSON.stringify(json))
  return file
}

async function writeGlobalHooksJson(globalDir: string, json: unknown): Promise<string> {
  await fs.mkdir(globalDir, { recursive: true })
  const file = path.join(globalDir, "hooks.json")
  await fs.writeFile(file, JSON.stringify(json))
  return file
}

async function writeSettingsJson(dir: string, json: unknown): Promise<string> {
  const graphagentDir = path.join(dir, ".agents")
  await fs.mkdir(graphagentDir, { recursive: true })
  const file = path.join(graphagentDir, "settings.json")
  await fs.writeFile(file, JSON.stringify(json))
  return file
}

async function writeClaudeSettingsJson(dir: string, json: unknown): Promise<string> {
  const claudeDir = path.join(dir, ".claude")
  await fs.mkdir(claudeDir, { recursive: true })
  const file = path.join(claudeDir, "settings.json")
  await fs.writeFile(file, JSON.stringify(json))
  return file
}

describe("§4.1 loadChain reads hooks.json from correct paths (global + project + local)", () => {
  test("all three scopes contribute their SessionStart matcher", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("global"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("project"))
      await writeLocalHooksJson(projectDir, hooksJsonTopLevel("local"))

      const merged = loadChain(projectDir, globalDir)
      const matchers = merged.hooks?.SessionStart ?? []
      expect(matchers.length).toBe(3)
      expect(matchers.map((m) => m.hooks[0].command)).toEqual(["global", "project", "local"])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("without an explicit path the global layer follows GRAPHAGENT_CONFIG_DIR", async () => {
    const configDir = await mktmp("config-dir")
    const projectDir = await mktmp("project-config-dir")
    const previous = process.env.GRAPHAGENT_CONFIG_DIR
    process.env.GRAPHAGENT_CONFIG_DIR = configDir
    try {
      await writeGlobalHooksJson(configDir, hooksJsonTopLevel("config-dir"))
      const merged = loadChain(projectDir)
      expect(merged.hooks?.SessionStart?.map((m) => m.hooks[0].command)).toEqual(["config-dir"])
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
      else process.env.GRAPHAGENT_CONFIG_DIR = previous
      await Promise.all([
        fs.rm(configDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("§4.2 merge order is global → project → local concat-append (not override)", () => {
  test("mergeSettings concatenates layers in order", () => {
    const g: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "g" }] }] } }
    const p: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "p" }] }] } }
    const l: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "l" }] }] } }
    const out = mergeSettings([g, p, l])
    // Three distinct matchers appended — NOT collapsed to a single matcher.
    expect(out.hooks?.SessionStart?.length).toBe(3)
    expect(out.hooks?.SessionStart?.[0].hooks[0].command).toBe("g")
    expect(out.hooks?.SessionStart?.[1].hooks[0].command).toBe("p")
    expect(out.hooks?.SessionStart?.[2].hooks[0].command).toBe("l")
  })

  test("loadChain preserves global → project → local order on disk", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("g"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("p"))
      await writeLocalHooksJson(projectDir, hooksJsonTopLevel("l"))

      const merged = loadChain(projectDir, globalDir)
      const cmds = (merged.hooks?.SessionStart ?? []).map((m) => m.hooks[0].command)
      expect(cmds).toEqual(["g", "p", "l"])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("retired trust options are ignored in every layer", () => {
  test("legacy trust fields do not enter the runtime settings", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, { requireTrust: true, ...hooksJsonTopLevel("g") })
      await writeHooksJson(projectDir, { allowUntrusted: false, requireTrust: false, ...hooksJsonTopLevel("p") })
      await writeLocalHooksJson(projectDir, { requireTrust: true, allowUntrusted: true, ...hooksJsonTopLevel("l") })
      const merged = loadChain(projectDir, globalDir)
      expect(merged).not.toHaveProperty("requireTrust")
      expect(merged).not.toHaveProperty("allowUntrusted")
      expect(merged.hooks?.SessionStart?.map((group) => group.hooks[0].command)).toEqual(["g", "p", "l"])
    } finally {
      await Promise.all([globalDir, projectDir].map((dir) => fs.rm(dir, { recursive: true, force: true })))
    }
  })
})

describe("§4.3 top-level events format (no wrapper) parses correctly", () => {
  test("readJSON parses {PreToolUse: [...]} and stamps __sourceDir to the hooks.json dir", async () => {
    const dir = await mktmp("fmt")
    try {
      const file = await writeHooksJson(dir, {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }],
      })
      const settings = readJSON(file)
      expect(settings?.hooks?.PreToolUse?.length).toBe(1)
      expect(settings?.hooks?.PreToolUse?.[0].matcher).toBe("Bash")
      // __sourceDir must point at the directory containing hooks.json (the .agents dir).
      expect(settings?.hooks?.PreToolUse?.[0].hooks[0].__sourceDir).toBe(path.dirname(file))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("§4.4 wrapper-detection fallback tolerates legacy {hooks: {...}}", () => {
  test("readJSON extracts the inner object when a wrapper is present", async () => {
    const dir = await mktmp("wrap")
    try {
      const file = await writeHooksJson(dir, hooksJsonWrapped("legacy"))
      const settings = readJSON(file)
      expect(settings?.hooks?.SessionStart?.length).toBe(1)
      expect(settings?.hooks?.SessionStart?.[0].hooks[0].command).toBe("legacy")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("loadChain loads a wrapped hooks.json into the merge", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeHooksJson(projectDir, hooksJsonWrapped("wrapped-project"))
      const merged = loadChain(projectDir, globalDir)
      expect(merged.hooks?.SessionStart?.[0].hooks[0].command).toBe("wrapped-project")
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("P1: readJSON filters non-event keys (e.g. $schema) via VALID_HOOK_EVENTS + Array.isArray", () => {
  test("$schema and other non-event keys are silently dropped, only valid events with array values are kept", async () => {
    const dir = await mktmp("schema")
    try {
      await writeHooksJson(dir, {
        $schema: "https://example.com/hooks-schema.json",
        version: 1,
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo bye" }] }],
        badEvent: "not-an-array",
      })
      const merged = loadChain(dir, dir)
      // Valid events are kept
      expect(merged.hooks?.SessionStart?.length).toBe(1)
      expect(merged.hooks?.Stop?.length).toBe(1)
      // $schema, version, badEvent are all filtered out
      expect((merged.hooks as Record<string, unknown>)?.$schema).toBeUndefined()
      expect((merged.hooks as Record<string, unknown>)?.version).toBeUndefined()
      expect((merged.hooks as Record<string, unknown>)?.badEvent).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("readJSON returns empty hooks object when file contains only non-event keys", async () => {
    const dir = await mktmp("onlymeta")
    try {
      const file = await writeHooksJson(dir, { $schema: "x", version: 1, description: "empty" })
      const settings = readJSON(file)
      expect(settings?.hooks).toEqual({})
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("§4.5 legacy settings.json hook fields are not loaded", () => {
  test("a hooks field in .agents/settings.json is ignored", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeSettingsJson(projectDir, {
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "stale" }] }] },
      })
      const merged = loadChain(projectDir, globalDir)
      expect(merged.hooks?.SessionStart ?? []).toEqual([])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("§4.6 .claude/ paths are NOT read", () => {
  test("hooks in .claude/settings.json do not appear in the merge", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeClaudeSettingsJson(projectDir, {
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "claude-only" }] }] },
      })
      const merged = loadChain(projectDir, globalDir)
      expect(merged.hooks?.SessionStart ?? []).toEqual([])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("$HOME is not a project layer", () => {
  test("loadChain ignores ~/.agents hooks when the root is $HOME", async () => {
    const globalDir = await mktmp("g")
    const home = await mktmp("home")
    const previous = process.env.GRAPHAGENT_TEST_HOME
    process.env.GRAPHAGENT_TEST_HOME = home
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("global-home"))
      await writeHooksJson(home, hooksJsonTopLevel("home-project"))
      await writeLocalHooksJson(home, hooksJsonTopLevel("home-local"))

      const merged = loadChain(home, globalDir)
      expect(merged.hooks?.SessionStart?.map((m) => m.hooks[0].command)).toEqual(["global-home"])
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = previous
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(home, { recursive: true, force: true }),
      ])
    }
  })

  test("the hot-reload watch set omits ~/.agents when the root is $HOME", async () => {
    const globalDir = await mktmp("g")
    const home = await mktmp("home")
    const previous = process.env.GRAPHAGENT_TEST_HOME
    process.env.GRAPHAGENT_TEST_HOME = home
    try {
      expect(__watchedFiles(home, globalDir)).toEqual([path.join(globalDir, "hooks.json")])

      // A real project below $HOME keeps its project layer.
      const projectDir = path.join(home, "work", "repo")
      await fs.mkdir(path.join(projectDir, ".agents"), { recursive: true })
      expect(__watchedFiles(projectDir, globalDir)).toEqual([
        path.join(globalDir, "hooks.json"),
        path.join(projectDir, ".agents", "hooks.json"),
        path.join(projectDir, ".agents", "hooks.local.json"),
      ])
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = previous
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(home, { recursive: true, force: true }),
      ])
    }
  })
})

describe("§4.7 polling reload: modify hooks.json → reload fires with new settings", () => {
  test("project hooks.json change triggers onReload with the updated chain", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("g"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("v1"))

      let reloaded: Settings | undefined
      let changed: string | undefined
      const handle = watchSettings(
        projectDir,
        () => Effect.sync(() => loadChain(projectDir, globalDir)),
        (newSettings, changedFile) => {
          reloaded = newSettings
          changed = changedFile
        },
        globalDir,
      )

      // Ensure a distinct mtime, then rewrite the project hooks.json to v2.
      await sleep(50)
      await writeHooksJson(projectDir, hooksJsonTopLevel("v2"))

      // Polling runs every 2s + 500ms debounce; 4s is past one full cycle.
      await sleep(4000)

      const cmds = (reloaded?.hooks?.SessionStart ?? []).map((m) => m.hooks[0].command)
      expect(cmds).toContain("v2")
      expect(changed).toBe(path.join(projectDir, ".agents", "hooks.json"))

      handle.close()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("local hooks.local.json change triggers onReload", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeLocalHooksJson(projectDir, hooksJsonTopLevel("local-v1"))

      let reloaded: Settings | undefined
      let changed: string | undefined
      const handle = watchSettings(
        projectDir,
        () => Effect.sync(() => loadChain(projectDir, globalDir)),
        (newSettings, changedFile) => {
          reloaded = newSettings
          changed = changedFile
        },
        globalDir,
      )

      await sleep(50)
      await writeLocalHooksJson(projectDir, hooksJsonTopLevel("local-v2"))
      await sleep(4000)

      expect(reloaded?.hooks?.SessionStart?.map((m) => m.hooks[0].command)).toContain("local-v2")
      expect(changed).toBe(path.join(projectDir, ".agents", "hooks.local.json"))

      handle.close()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("§4.8 global hooks.json IS hot-reloaded on change", () => {
  test("modifying global hooks.json triggers reload and reflects new global hooks", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("global-v1"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("project-stable"))

      let reloadCount = 0
      let reloadedCommands: string[] = []
      const handle = watchSettings(
        projectDir,
        () => Effect.sync(() => loadChain(projectDir, globalDir)),
        (settings) => {
          reloadCount += 1
          reloadedCommands = settings.hooks?.SessionStart?.flatMap((m) => m.hooks.map((h) => h.command ?? "")) ?? []
        },
        globalDir,
      )

      // Modify ONLY the global hooks.json — project file stays untouched.
      await sleep(50)
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("global-v2"))

      // Past one full poll cycle (POLL_INTERVAL_MS=2000) + debounce window.
      await sleep(4000)
      expect(reloadCount).toBeGreaterThanOrEqual(1)
      expect(reloadedCommands).toContain("global-v2")

      handle.close()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("after close(), even project hooks.json changes do not reload", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      await writeHooksJson(projectDir, hooksJsonTopLevel("v1"))

      let reloadCount = 0
      const handle = watchSettings(
        projectDir,
        () => Effect.sync(() => loadChain(projectDir, globalDir)),
        () => {
          reloadCount += 1
        },
        globalDir,
      )

      handle.close()
      await sleep(50)
      await writeHooksJson(projectDir, hooksJsonTopLevel("after-close"))
      await sleep(4000)
      expect(reloadCount).toBe(0)
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("P2: deleting hooks.json triggers reload (mtime from >0 to 0)", () => {
  test("project hooks.json deletion triggers onReload with empty settings", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      // Start with a hooks.json that has real hooks
      await writeHooksJson(projectDir, hooksJsonTopLevel("before-delete"))
      const hooksFile = path.join(projectDir, ".agents", "hooks.json")

      let reloaded: Settings | undefined
      const handle = watchSettings(
        projectDir,
        () => Effect.sync(() => loadChain(projectDir, globalDir)),
        (s) => {
          reloaded = s
        },
      )

      // Verify initial load has the hook
      const initial = loadChain(projectDir, globalDir)
      expect(initial.hooks?.SessionStart?.[0].hooks[0].command).toBe("before-delete")

      // Delete the file
      await fs.unlink(hooksFile)
      // Wait for polling: 2s interval + 500ms debounce + margin
      await sleep(4000)

      // Reload should have fired, and now there are no hooks
      expect(reloaded).toBeDefined()
      expect(reloaded?.hooks?.SessionStart ?? []).toHaveLength(0)

      handle.close()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  }, 12000)
})
