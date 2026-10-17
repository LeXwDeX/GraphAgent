import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookConfigChange } from "@/hook/config-change"
import { HookFileWatch } from "@/hook/file-watch"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { watchSettings } from "@/hook/extensions"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Hot reload of hooks.json: a changed file is only a candidate. Invalid JSON never replaces a
// valid chain, ConfigChange hooks judge the candidate against the CURRENT chain, and only an
// accepted candidate is committed.

const base = SettingsHook.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))
const plainIt = testEffect(base.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))
const gateIt = testEffect(
  base.pipe(Layer.provideMerge(HookConfigChange.defaultLayer), Layer.provideMerge(SessionHooks.defaultLayer)),
)

const staticCalls: (readonly string[])[] = []
const staticIt = testEffect(
  base.pipe(
    Layer.provide(
      Layer.mock(HookFileWatch.Service, {
        refreshStatic: (paths) => Effect.sync(() => void staticCalls.push(paths)),
        replace: () => Effect.void,
        clear: () => Effect.void,
        paths: () => Effect.succeed(undefined),
      }),
    ),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const pollFor = async (fn: () => boolean, timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(100)
  }
  return fn()
}

const V1 = "ctx-gate-v1"
const V2 = "ctx-gate-v2"
const V3 = "ctx-gate-v3"

const startHook = (context: string) => ({
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { additionalContext: context } }))})`,
          ],
        },
      ],
    },
  ],
})

const hooksFile = (dir: string) => path.join(dir, ".opencode", "hooks.json")
const writeHooks = (dir: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(hooksFile(dir), typeof value === "string" ? value : JSON.stringify(value))
  })

let counter = 0
const startContexts = (hook: SettingsHook.Interface) =>
  hook
    .trigger(
      { event: "SessionStart", source: "startup" },
      { sessionID: `sess-cross-gate-${++counter}`, transcriptPath: "" },
    )
    .pipe(Effect.map((result) => result.additionalContexts))
const waitFor = (hook: SettingsHook.Interface, context: string) =>
  pollWithTimeout(
    startContexts(hook).pipe(Effect.map((all) => (all.includes(context) ? true : undefined))),
    `hooks.json candidate ${context} was not applied`,
    "12 seconds",
  )

const configLogger = (file: string) => ({
  ConfigChange: [
    {
      hooks: [
        {
          type: "command",
          command: process.execPath,
          args: [
            "-e",
            "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('node:fs').appendFileSync(process.argv[1],d+'\\n'))",
            file,
          ],
        },
      ],
    },
  ],
})

describe("hooks.json hot reload candidate gate", () => {
  plainIt.instance(
    "invalid intermediate JSON never removes a valid guard",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const instance = yield* TestInstance
        const denied = hook
          .trigger(
            { event: "PreToolUse", toolName: "Bash", toolInput: {} },
            { sessionID: "sess-guard", transcriptPath: "" },
          )
          .pipe(Effect.map((result) => result.blocked !== undefined))
        expect(yield* denied).toBe(true)

        yield* writeHooks(instance.directory, '{ "PreToolUse": [ {')
        // Past the 2s poll and 500ms debounce, so the broken candidate has been seen.
        yield* Effect.promise(() => sleep(3800))
        expect(yield* denied).toBe(true)

        // The watcher is still alive: the next valid file replaces the guard.
        yield* writeHooks(instance.directory, startHook(V2))
        yield* pollWithTimeout(
          denied.pipe(Effect.map((blocked) => (blocked ? undefined : true))),
          "a valid candidate after an invalid one was not applied",
          "12 seconds",
        )
        expect(yield* startContexts(hook)).toEqual([V2])
      }),
    {
      init: (dir) =>
        writeHooks(dir, {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo guard >&2; exit 2" }] }],
          ...startHook(V1),
        }),
    },
    { timeout: 40_000 },
  )

  plainIt.instance(
    "a blocking ConfigChange hook is judged with the old config, receives file_path, and keeps it",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const instance = yield* TestInstance
        const seen = path.join(instance.directory, "seen.jsonl")
        const blocker = {
          ConfigChange: [
            {
              hooks: [
                {
                  type: "command",
                  command: process.execPath,
                  args: [
                    "-e",
                    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('node:fs').appendFileSync(process.argv[1],d+'\\n');process.stderr.write('no');process.exit(2)})",
                    seen,
                  ],
                },
              ],
            },
          ],
        }
        // The first candidate adds the blocker; the old chain had no ConfigChange hook.
        yield* writeHooks(instance.directory, { ...startHook(V2), ...blocker })
        yield* waitFor(hook, V2)
        // Now the blocker belongs to the current chain and vetoes the next edit.
        yield* writeHooks(instance.directory, { ...startHook(V3), ...blocker })
        yield* pollWithTimeout(
          Effect.promise(() => fs.readFile(seen, "utf8").catch(() => undefined)),
          "ConfigChange hook never ran",
          "12 seconds",
        )
        yield* Effect.promise(() => sleep(400))
        const [first] = (yield* Effect.promise(() => fs.readFile(seen, "utf8"))).trim().split("\n")
        const stdin = JSON.parse(first)
        expect(stdin.hook_event_name).toBe("ConfigChange")
        expect(stdin.source).toBe("project_settings")
        expect(stdin.file_path).toBe(hooksFile(instance.directory))
        expect(stdin.config_path).toBe(hooksFile(instance.directory))
        expect(yield* startContexts(hook)).toEqual([V2])
      }),
    { init: (dir) => writeHooks(dir, startHook(V1)) },
    { timeout: 40_000 },
  )

  gateIt.instance(
    "sessions registered in this instance decide, and each hook runs once with the real session",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const config = yield* HookConfigChange.Service
        const instance = yield* TestInstance
        const log = path.join(instance.directory, "gate.jsonl")
        yield* config.register("ses_real_gate", instance.directory, (change) =>
          hook
            .trigger(
              { event: "ConfigChange", source: change.source, configPath: change.path },
              { sessionID: "ses_real_gate", transcriptPath: "" },
            )
            .pipe(Effect.map((result) => ({ blocked: result.blocked }))),
        )
        yield* writeHooks(instance.directory, { ...startHook(V2), ...configLogger(log) })
        yield* waitFor(hook, V2)
        yield* writeHooks(instance.directory, { ...startHook(V3), ...configLogger(log) })
        yield* waitFor(hook, V3)
        const lines = (yield* Effect.promise(() => fs.readFile(log, "utf8"))).trim().split("\n").filter(Boolean)
        // The V3 candidate is judged once by the V2 chain through the registered session; the
        // sessionless fallback must not fire a second time.
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0]).session_id).toBe("ses_real_gate")
      }),
    { init: (dir) => writeHooks(dir, startHook(V1)) },
    { timeout: 60_000 },
  )

  staticIt.instance(
    "an accepted reload refreshes the static FileChanged watchers",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const instance = yield* TestInstance
        staticCalls.length = 0
        expect(yield* hook.fileWatchPaths!()).toEqual([".envrc"])
        yield* writeHooks(instance.directory, {
          FileChanged: [{ matcher: ".envrc|.env.local", hooks: [{ type: "command", command: "true" }] }],
        })
        yield* pollWithTimeout(
          Effect.sync(() => (staticCalls.length > 0 ? true : undefined)),
          "static watchers were not refreshed",
          "12 seconds",
        )
        expect(staticCalls.at(-1)).toEqual([".envrc", ".env.local"])
        expect(yield* hook.fileWatchPaths!()).toEqual([".envrc", ".env.local"])
      }),
    {
      init: (dir) =>
        writeHooks(dir, { FileChanged: [{ matcher: ".envrc", hooks: [{ type: "command", command: "true" }] }] }),
    },
    { timeout: 30_000 },
  )

  test("reloads are serialized and close() interrupts the one in flight", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-serial-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(hooksFile(dir), "{}")
    let running = 0
    let peak = 0
    let started = 0
    const committed: string[] = []
    const handle = watchSettings(
      dir,
      undefined,
      () =>
        Effect.gen(function* () {
          started++
          running++
          peak = Math.max(peak, running)
          yield* Effect.sleep("2500 millis").pipe(Effect.ensuring(Effect.sync(() => void running--)))
          return { hooks: {} }
        }),
      (_settings, changed) => {
        committed.push(changed)
      },
    )
    await sleep(50)
    await fs.writeFile(hooksFile(dir), JSON.stringify({ a: 1 }))
    expect(await pollFor(() => started === 1)).toBe(true)
    // A second edit while the first reload runs queues behind it and never overlaps.
    await fs.writeFile(hooksFile(dir), JSON.stringify({ b: 2 }))
    expect(await pollFor(() => started === 2, 12_000)).toBe(true)
    expect(peak).toBe(1)
    // Closing during the second reload interrupts it: nothing more is committed.
    const before = committed.length
    handle.close()
    await sleep(3000)
    expect(committed.length).toBe(before)
    expect(running).toBe(0)
    await fs.rm(dir, { recursive: true, force: true })
  }, 40_000)
})
