import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { watchSettings } from "@/hook/extensions"
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
  JSON.stringify({ hookSpecificOutput: { additionalContext: ctx } })

const settingsFor = (ctx: string) => ({
  // hooks.json uses top-level event keys (D1 canonical format).
  SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${hookJson(ctx)}'` }] }],
})

const opencodeDir = (dir: string) => path.join(dir, ".agents")
const settingsPath = (dir: string) => path.join(opencodeDir(dir), "hooks.json")

const writeSettings = (dir: string, ctx: string) =>
  Effect.promise(async () => {
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(settingsPath(dir), JSON.stringify(settingsFor(ctx)))
  })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Poll a predicate until it returns true (state reached) or the timeout elapses.
// Replaces fragile fixed sleeps that race the watcher's 2s mtime poll + 500ms
// debounce on slow CI hosts — wait for the observable effect instead.
const pollFor = async (fn: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(intervalMs)
  }
  return fn()
}

describe("SettingsHook hot-reload — watchSettings wiring (F3)", () => {
  // F3.1 integration: changing hooks.json at runtime is picked up by the
  // next trigger after the polling debounce. The first trigger runs
  // InstanceState.get → loadChain (reads v1) AND wires watchSettings; the
  // on-disk edit is detected by the hooks.json mtime poll, reload() re-runs
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
          { sessionID: "sess-f3-base", transcriptPath: "" },
        )
        expect(r1.additionalContexts).toEqual([CONTEXT_V1])

        // Edit the on-disk settings to v2.
        const inst = yield* TestInstance
        yield* writeSettings(inst.directory, CONTEXT_V2)

        // Poll until the hot-reload has mutated the cached settings to v2.
        // Each poll uses a fresh session so per-session dedup never masks the
        // new marker. The reload is driven by the 2s mtime poll + 500ms debounce,
        // so we wait on the observable effect rather than a fixed sleep.
        let n = 0
        yield* pollWithTimeout(
          Effect.gen(function* () {
            n += 1
            const r = yield* hook.trigger(
              { event: "SessionStart", source: "startup" },
              { sessionID: `sess-f3-poll-${n}`, transcriptPath: "" },
            )
            return r.additionalContexts.includes(CONTEXT_V2) ? true : undefined
          }),
          "settings hot-reload did not surface v2 within timeout",
          "8 seconds",
        )

        // Final confirmation with a clean session.
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f3-final", transcriptPath: "" },
        )
        expect(r2.additionalContexts).toEqual([CONTEXT_V2])
      }),
    { init: (dir) => writeSettings(dir, CONTEXT_V1) },
  )

  // F3.2 + cleanup: watchSettings polls .agents/hooks.json and
  // .agents/hooks.local.json (project scope only) and handle.close() stops all
  // reloads. Direct unit test of the watcher
  // mechanism, independent of the SettingsHook layer. Fixed sleeps are justified
  // here — this test exercises the polling/debounce/throttle timing and proves
  // absence of reload after close().
  test("watchSettings reloads on hooks.json change and stops after close", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-"))
    const file = settingsPath(dir)
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(file, JSON.stringify({}))

    let marker: string | undefined
    const handle = watchSettings(
      dir,
      () =>
        Effect.sync(() => ({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] },
        })),
      () => {
        marker = "reloaded"
      },
    )

    // Trigger a change. The poll checks mtime every 2s; ensure a distinct mtime
    // from the construction snapshot, then poll for the reload to fire (the
    // debounce adds 500ms after the 2s mtime poll, so a fixed sleep races the
    // scheduler on slow hosts — wait for the observable marker instead).
    await sleep(50)
    await fs.writeFile(file, JSON.stringify({ Stop: [] }))
    expect(await pollFor(() => marker === "reloaded")).toBe(true)

    // After close(), further changes must NOT reload. A positive reload would
    // land within the 2s+500ms window; sleep past it then assert absence.
    handle.close()
    marker = undefined
    await fs.writeFile(file, JSON.stringify({ Notification: [] }))
    expect(await pollFor(() => marker !== undefined, 3500)).toBe(false)

    await fs.rm(dir, { recursive: true, force: true })
  }, 15000)

  test("watchSettings reloads when mtime decreases (cp -p / touch -t)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-mtime-dec-"))
    const file = settingsPath(dir)
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(file, JSON.stringify({}))

    let marker: string | undefined
    const handle = watchSettings(
      dir,
      () => Effect.sync(() => ({ hooks: {} })),
      () => {
        marker = "reloaded"
      },
    )

    // Wait for the construction-time mtime snapshot to be captured.
    await sleep(50)

    // Overwrite the file, then rewind its mtime to 60s ago — simulates
    // `cp -p` from a backup or `touch -t`. The mtime is now LOWER than the
    // snapshot the watcher took at construction.
    await fs.writeFile(file, JSON.stringify({ Stop: [] }))
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(file, oldTime, oldTime)

    expect(await pollFor(() => marker === "reloaded")).toBe(true)

    handle.close()
    await fs.rm(dir, { recursive: true, force: true })
  }, 15000)
})
