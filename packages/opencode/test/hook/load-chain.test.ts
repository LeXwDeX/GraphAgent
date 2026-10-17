import { describe, expect, test, beforeEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import {
  loadChain,
  mergeSettings,
  readJSON,
  __hasWarnedDeprecated,
  __resetDeprecatedWarnings,
  type Settings,
} from "@/hook/settings"
import { watchSettings } from "@/hook/extensions"

// §4 unit tests for loadChain + hot-reload — previously zero coverage.
//
// Each test builds isolated temp dirs for the global / project / worktree scopes
// and drives loadChain (or watchSettings) directly. loadChain's optional third
// arg `globalConfig` points the global layer at an isolated temp dir instead of
// the real ~/.config/opencode, so no real-machine state is touched.

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
  const opencodeDir = path.join(dir, ".opencode")
  await fs.mkdir(opencodeDir, { recursive: true })
  const file = path.join(opencodeDir, "hooks.json")
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
  const opencodeDir = path.join(dir, ".opencode")
  await fs.mkdir(opencodeDir, { recursive: true })
  const file = path.join(opencodeDir, "settings.json")
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

beforeEach(() => {
  __resetDeprecatedWarnings()
})

describe("§4.1 loadChain reads hooks.json from correct paths (global + project + worktree)", () => {
  test("all three scopes contribute their SessionStart matcher", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    const worktreeDir = await mktmp("worktree")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("global"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("project"))
      await writeHooksJson(worktreeDir, hooksJsonTopLevel("worktree"))

      const merged = loadChain(projectDir, worktreeDir, globalDir)
      const matchers = merged.hooks?.SessionStart ?? []
      expect(matchers.length).toBe(3)
      expect(matchers.map((m) => m.hooks[0].command)).toEqual(["global", "project", "worktree"])
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true }), fs.rm(worktreeDir, { recursive: true, force: true })])
    }
  })
})

describe("§4.2 merge order is global → project → worktree concat-append (not override)", () => {
  test("mergeSettings concatenates layers in order", () => {
    const g: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "g" }] }] } }
    const p: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "p" }] }] } }
    const w: Settings = { hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "w" }] }] } }
    const out = mergeSettings([g, p, w])
    // Three distinct matchers appended — NOT collapsed to a single matcher.
    expect(out.hooks?.SessionStart?.length).toBe(3)
    expect(out.hooks?.SessionStart?.[0].hooks[0].command).toBe("g")
    expect(out.hooks?.SessionStart?.[1].hooks[0].command).toBe("p")
    expect(out.hooks?.SessionStart?.[2].hooks[0].command).toBe("w")
  })

  test("loadChain preserves global → project → worktree order on disk", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    const worktreeDir = await mktmp("worktree")
    try {
      await writeGlobalHooksJson(globalDir, hooksJsonTopLevel("g"))
      await writeHooksJson(projectDir, hooksJsonTopLevel("p"))
      await writeHooksJson(worktreeDir, hooksJsonTopLevel("w"))

      const merged = loadChain(projectDir, worktreeDir, globalDir)
      const cmds = (merged.hooks?.SessionStart ?? []).map((m) => m.hooks[0].command)
      expect(cmds).toEqual(["g", "p", "w"])
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true }), fs.rm(worktreeDir, { recursive: true, force: true })])
    }
  })
})

describe("§4.2b allowUntrusted is only honored from the global layer (trust-gate self-escape)", () => {
  test("project-layer allowUntrusted is stripped; global requireTrust survives", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, { requireTrust: true, ...hooksJsonTopLevel("g") })
      await writeHooksJson(projectDir, { allowUntrusted: true, ...hooksJsonTopLevel("p") })

      const merged = loadChain(projectDir, "", globalDir)
      // The untrusted repo's own hooks.json must not be able to opt out of a
      // globally-enforced trust gate.
      expect(merged.requireTrust).toBe(true)
      expect(merged.allowUntrusted).toBeUndefined()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("worktree-layer allowUntrusted is stripped too", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    const worktreeDir = await mktmp("worktree")
    try {
      await writeGlobalHooksJson(globalDir, { requireTrust: true })
      await writeHooksJson(worktreeDir, { allowUntrusted: true, ...hooksJsonTopLevel("w") })

      const merged = loadChain(projectDir, worktreeDir, globalDir)
      expect(merged.requireTrust).toBe(true)
      expect(merged.allowUntrusted).toBeUndefined()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
        fs.rm(worktreeDir, { recursive: true, force: true }),
      ])
    }
  })

  test("global-layer allowUntrusted is honored", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, { requireTrust: true, allowUntrusted: true })
      await writeHooksJson(projectDir, hooksJsonTopLevel("p"))

      const merged = loadChain(projectDir, "", globalDir)
      expect(merged.requireTrust).toBe(true)
      expect(merged.allowUntrusted).toBe(true)
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("project-layer requireTrust:false is stripped (a repo cannot disable the default gate)", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeHooksJson(projectDir, { requireTrust: false, ...hooksJsonTopLevel("p") })

      const merged = loadChain(projectDir, "", globalDir)
      expect(merged.requireTrust).toBeUndefined()
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("global-layer requireTrust:false disables the default gate and wins over project true", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, { requireTrust: false })
      await writeHooksJson(projectDir, { requireTrust: true, ...hooksJsonTopLevel("p") })

      const merged = loadChain(projectDir, "", globalDir)
      expect(merged.requireTrust).toBe(false)
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
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
      // __sourceDir must point at the directory containing hooks.json (the .opencode dir).
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
      const merged = loadChain(projectDir, "", globalDir)
      expect(merged.hooks?.SessionStart?.[0].hooks[0].command).toBe("wrapped-project")
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
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
      const merged = loadChain(dir, "", dir)
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

describe("§4.5 deprecation warning fires when settings.json has a hooks field", () => {
  test("settings.json hooks field is flagged and NOT loaded into the merge", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      const settingsFile = await writeSettingsJson(projectDir, {
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "stale" }] }] },
      })
      const merged = loadChain(projectDir, "", globalDir)
      // Hooks from settings.json are silently ignored (not in the merge)...
      expect(merged.hooks?.SessionStart ?? []).toEqual([])
      // ...but the deprecation scan flagged the file.
      expect(__hasWarnedDeprecated(settingsFile)).toBe(true)
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
    }
  })

  test("deprecation is warned once per file across repeated loadChain calls", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      const settingsFile = await writeSettingsJson(projectDir, {
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "stale" }] }] },
      })
      __resetDeprecatedWarnings()
      loadChain(projectDir, "", globalDir)
      expect(__hasWarnedDeprecated(settingsFile)).toBe(true)
      // Second call must not re-flag (Set dedup simulates hot-reload behavior).
      loadChain(projectDir, "", globalDir)
      expect(__hasWarnedDeprecated(settingsFile)).toBe(true)
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
    }
  })
})

describe("§4.6 .claude/ paths are NOT read", () => {
  test("hooks in .claude/settings.json do not appear in the merge and are not scanned", async () => {
    const globalDir = await mktmp("g")
    const projectDir = await mktmp("p")
    try {
      const claudeFile = await writeClaudeSettingsJson(projectDir, {
        hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "claude-only" }] }] },
      })
      const merged = loadChain(projectDir, "", globalDir)
      // .claude/ hooks never reach the merge...
      expect(merged.hooks?.SessionStart ?? []).toEqual([])
      // ...and .claude/ is never scanned for the deprecation warning (silent ignore).
      expect(__hasWarnedDeprecated(claudeFile)).toBe(false)
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
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
        undefined,
        () => Effect.sync(() => loadChain(projectDir, "", globalDir)),
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
      expect(changed).toBe(path.join(projectDir, ".opencode", "hooks.json"))

      handle.close()
    } finally {
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
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
        undefined,
        () => Effect.sync(() => loadChain(projectDir, "", globalDir)),
        (settings) => {
          reloadCount += 1
          reloadedCommands =
            settings.hooks?.SessionStart?.flatMap((m) => m.hooks.map((h) => h.command ?? "")) ?? []
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
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
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
        undefined,
        () => Effect.sync(() => loadChain(projectDir, "", globalDir)),
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
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
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
      const hooksFile = path.join(projectDir, ".opencode", "hooks.json")

      let reloaded: Settings | undefined
      const handle = watchSettings(
        projectDir,
        undefined,
        () => Effect.sync(() => loadChain(projectDir, "", globalDir)),
        (s) => { reloaded = s },
      )

      // Verify initial load has the hook
      const initial = loadChain(projectDir, "", globalDir)
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
      await Promise.all([fs.rm(globalDir, { recursive: true, force: true }), fs.rm(projectDir, { recursive: true, force: true })])
    }
  }, 12000)
})
