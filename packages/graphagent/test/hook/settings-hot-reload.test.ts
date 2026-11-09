import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { __setFallbackIntervalForTest, __setWatchImplForTest, watchSettings } from "@/hook/extensions/hot-reload"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Real SettingsHook layer with its deps, mirroring the dedup test. SessionHooks
// is exposed via Layer.provideMerge. Each it.instance test runs in a fresh temp
// instance dir, so InstanceState-built state (loadChain + the seen Map) and the
// watchSettings watcher are fresh per test.
const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const it = testEffect(testLayer)

const CONTEXT_V1 = "ctx-hot-reload-v1"
const CONTEXT_V2 = "ctx-hot-reload-v2"

// A SessionStart command hook whose stdout JSON carries a fixed additionalContext
// marker. `printf '%s' '<json>'` single-quotes the JSON so its inner double
// quotes reach the shell literally; parseStdout then JSON.parses the output.
const hookJson = (ctx: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } })

const settingsFor = (ctx: string) => ({
  // hooks.json uses top-level event keys (D1 canonical format).
  SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${hookJson(ctx)}'` }] }],
})

const graphagentDir = (dir: string) => path.join(dir, ".agents")
const settingsPath = (dir: string) => path.join(graphagentDir(dir), "hooks.json")

const writeSettings = (dir: string, ctx: string) =>
  Effect.promise(async () => {
    await fs.mkdir(graphagentDir(dir), { recursive: true })
    await fs.writeFile(settingsPath(dir), JSON.stringify(settingsFor(ctx)))
  })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Poll a predicate until it returns true (state reached) or the timeout elapses.
// Wait for the observable effect instead of racing a fixed sleep against event
// delivery + the 150ms debounce.
const pollFor = async (fn: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(intervalMs)
  }
  return fn()
}

// ── Direct watcher unit tests (Issue §9) ────────────────────────

const tmpDir = (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix))
const globalHooks = (globalDir: string) => path.join(globalDir, "hooks.json")
const projectHooks = (projectDir: string) => path.join(graphagentDir(projectDir), "hooks.json")
const projectLocalHooks = (projectDir: string) => path.join(graphagentDir(projectDir), "hooks.local.json")

const writeFile = async (file: string, content = "{}") => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

/** Wire a real watchSettings handle and collect the files it committed. */
function makeWatcher(projectDir: string, globalDir?: string) {
  const reloads: string[] = []
  const handle = watchSettings(
    projectDir,
    () => Effect.sync(() => ({ hooks: {} })),
    (_settings, changedFile) => {
      reloads.push(changedFile)
    },
    globalDir,
  )
  return { handle, reloads }
}

const waitForReload = (reloads: string[], file: string, count = 1) =>
  pollFor(() => reloads.filter((changed) => changed === file).length >= count, 5000)

describe("watchSettings — fs.watch hot reload (Issue §9)", () => {
  test("global hooks.json creation and modification reload", async () => {
    const globalDir = await tmpDir("hot-reload-global-")
    const projectDir = await tmpDir("hot-reload-global-project-")
    const file = globalHooks(globalDir)
    await writeFile(projectHooks(projectDir))
    const { handle, reloads } = makeWatcher(projectDir, globalDir)
    try {
      // Create the global file after the watcher is attached.
      await writeFile(file, JSON.stringify({ Stop: [] }))
      expect(await waitForReload(reloads, file)).toBe(true)

      // Modify it again — a second commit must follow.
      await writeFile(file, JSON.stringify({ Notification: [] }))
      expect(await waitForReload(reloads, file, 2)).toBe(true)
    } finally {
      handle.close()
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  }, 15000)

  test("project hooks.json atomic replace (temp file + rename) and deletion reload", async () => {
    const projectDir = await tmpDir("hot-reload-project-")
    const file = projectHooks(projectDir)
    await writeFile(file, JSON.stringify({}))
    const { handle, reloads } = makeWatcher(projectDir)
    try {
      // Temp-file churn alone must not reload: only hooks.json/hooks.local.json
      // names are accepted.
      const temp = path.join(path.dirname(file), ".hooks.json.tmp")
      await fs.writeFile(temp, JSON.stringify({ Stop: [] }))
      expect(await pollFor(() => reloads.length > 0, 500)).toBe(false)

      // Editor-style atomic save: rename the temp file over the target.
      await fs.rename(temp, file)
      expect(await waitForReload(reloads, file)).toBe(true)

      // Deleting the file is also a chain change.
      const beforeDelete = reloads.filter((changed) => changed === file).length
      await fs.rm(file)
      expect(await pollFor(() => reloads.filter((changed) => changed === file).length > beforeDelete, 5000)).toBe(true)
    } finally {
      handle.close()
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }, 15000)

  test("hooks.local.json modification and deletion reload", async () => {
    const projectDir = await tmpDir("hot-reload-local-")
    const file = projectLocalHooks(projectDir)
    await writeFile(projectHooks(projectDir))
    await writeFile(file, JSON.stringify({}))
    const { handle, reloads } = makeWatcher(projectDir)
    try {
      await writeFile(file, JSON.stringify({ Stop: [] }))
      expect(await waitForReload(reloads, file)).toBe(true)

      await fs.rm(file)
      expect(await waitForReload(reloads, file, 2)).toBe(true)
    } finally {
      handle.close()
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }, 15000)

  test("a missing .agents directory is watched through its existing ancestor until created", async () => {
    const projectDir = await tmpDir("hot-reload-ancestor-")
    const file = projectHooks(projectDir)
    const { handle, reloads } = makeWatcher(projectDir)
    try {
      // .agents does not exist yet: the watcher attaches to projectDir and
      // upgrades once the directory appears.
      await writeFile(file, JSON.stringify({ Stop: [] }))
      expect(await waitForReload(reloads, file)).toBe(true)
    } finally {
      handle.close()
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }, 15000)

  test("close() stops reloads", async () => {
    const projectDir = await tmpDir("hot-reload-close-")
    const file = projectHooks(projectDir)
    await writeFile(file, JSON.stringify({}))
    const { handle, reloads } = makeWatcher(projectDir)
    try {
      await writeFile(file, JSON.stringify({ Stop: [] }))
      expect(await waitForReload(reloads, file)).toBe(true)

      handle.close()
      const before = reloads.length
      await writeFile(file, JSON.stringify({ Notification: [] }))
      // An event would be debounced and committed well inside this window.
      expect(await pollFor(() => reloads.length > before, 800)).toBe(false)
    } finally {
      handle.close()
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }, 15000)

  test("fs.watch failure degrades to the stat fallback", async () => {
    const projectDir = await tmpDir("hot-reload-fallback-")
    const file = projectHooks(projectDir)
    await writeFile(file, JSON.stringify({}))
    __setWatchImplForTest(() => {
      throw new Error("injected fs.watch failure")
    })
    __setFallbackIntervalForTest(100)
    const { handle, reloads } = makeWatcher(projectDir)
    try {
      await writeFile(file, JSON.stringify({ Stop: [] }))
      expect(await waitForReload(reloads, file)).toBe(true)
    } finally {
      handle.close()
      __setWatchImplForTest(undefined)
      __setFallbackIntervalForTest(undefined)
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }, 15000)
})

describe("SettingsHook hot-reload — watchSettings wiring (F3)", () => {
  // F3.1 integration: changing hooks.json at runtime is picked up by the
  // next trigger after the watcher debounce. The first trigger runs
  // InstanceState.get → loadChain (reads v1) AND wires watchSettings; the
  // on-disk edit is detected by the .agents directory watcher, reload() re-runs
  // loadChain (reads v2), and onReload mutates the cached state object's
  // .settings in place — visible to trigger without invalidating the cache.
  it.instance(
    "runtime settings.json change is surfaced by the next trigger after debounce",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service

        // Baseline: trigger runs loadChain (v1) and starts the watcher.
        const r1 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f3-base", transcript: () => Effect.succeed("") },
        )
        expect(r1.additionalContexts).toEqual([CONTEXT_V1])

        // Edit the on-disk settings to v2.
        const inst = yield* TestInstance
        yield* writeSettings(inst.directory, CONTEXT_V2)

        // Poll until the hot-reload has mutated the cached settings to v2.
        // Each poll uses a fresh session so per-session dedup never masks the
        // new marker. The reload is driven by the directory event + 150ms
        // debounce, so we wait on the observable effect rather than a fixed sleep.
        let n = 0
        yield* pollWithTimeout(
          Effect.gen(function* () {
            n += 1
            const r = yield* hook.trigger(
              { event: "SessionStart", source: "startup" },
              { sessionID: `sess-f3-poll-${n}`, transcript: () => Effect.succeed("") },
            )
            return r.additionalContexts.includes(CONTEXT_V2) ? true : undefined
          }),
          "settings hot-reload did not surface v2 within timeout",
          "8 seconds",
        )

        // Final confirmation with a clean session.
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f3-final", transcript: () => Effect.succeed("") },
        )
        expect(r2.additionalContexts).toEqual([CONTEXT_V2])
      }),
    { init: (dir) => writeSettings(dir, CONTEXT_V1) },
  )
})
