import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { spawnSync } from "child_process"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { testEffect } from "../lib/effect"

// #500: a hook command that spawns a grandchild holding the stdio pipes and
// then hits its timeout must not hang the trigger forever. execShell kills
// the child's process group once the EOF grace elapses, so the trigger
// returns within the timeout window plus grace, and the grandchild is gone.
// Mirrors stdout-context.test.ts (real SettingsHook layer, execShell actually
// runs the command, hooks.json written via init).

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

const writeHooks = (hooks: unknown) => (dir: string) =>
  Effect.promise(() =>
    fs.mkdir(path.join(dir, ".agents"), { recursive: true }).then(() =>
      fs.writeFile(path.join(dir, ".agents", "hooks.json"), JSON.stringify(hooks)),
    ),
  )

// Unique marker so pgrep only matches this test's grandchild.
const GRANDCHILD = "sleep 597.3"

const grandchildGone = () =>
  Effect.promise(async () => {
    for (let i = 0; i < 20; i++) {
      // pgrep exits 1 when no process matches; a null status means pgrep is
      // unavailable — nothing to assert.
      if (spawnSync("pgrep", ["-f", GRANDCHILD]).status !== 0) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })

describe("SettingsHook execShell pipe-holding grandchild (#500)", () => {
  it.instance(
    "timed-out hook with pipe-holding grandchild resolves and kills the group",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const hook = yield* SettingsHook.Service
        const startedAt = Date.now()
        const r = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "test" },
          { sessionID: "sess-500-1", transcriptPath: "" },
        )
        const elapsed = Date.now() - startedAt
        // Must resolve far below the 597s the grandchild would hold the pipe.
        expect(elapsed).toBeLessThan(15_000)
        expect(r.additionalContexts).toEqual([])
        expect(yield* grandchildGone()).toBe(true)
      }),
    {
      init: writeHooks({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `${GRANDCHILD} & wait`, timeout: 1 }] }],
      }),
    },
    { timeout: 30_000 },
  )

  it.instance(
    "fast command with a configured timeout still completes normally",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "test" },
          { sessionID: "sess-500-2", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual(["fast-ok-500"])
      }),
    {
      init: writeHooks({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "printf '%s' 'fast-ok-500'", timeout: 30 }] }],
      }),
    },
    { timeout: 10_000 },
  )
})
