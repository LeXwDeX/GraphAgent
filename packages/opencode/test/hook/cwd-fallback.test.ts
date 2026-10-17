import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SettingsHook, type HookCommand } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(layer)

const node = (script: string): HookCommand => ({ type: "command", command: process.execPath, args: ["-e", script] })

// Reference parity: deleting the session working directory must not disable
// hooks for the rest of the session. Claude Code falls back to the project
// root, home, then temp; a bare spawn simply fails with ENOENT and the hook
// body never runs.
describe("hook working directory fallback", () => {
  it.instance(
    "a deleted session directory keeps command hooks running",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const hook = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        const marker = path.join(os.tmpdir(), `graphagent-hook-cwd-${sessionID}.json`)
        const script = [
          'const fs = require("node:fs")',
          `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd() }))`,
          `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "HOOK_RAN" } }))`,
        ].join(";")
        yield* store.add(sessionID, { event: "UserPromptSubmit", hooks: [node(script)] })
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(marker, { force: true })))
        yield* Effect.promise(() => fs.rm(instance.directory, { recursive: true, force: true }))

        const result = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "hi" },
          { sessionID, transcriptPath: "" },
        )
        expect(result.additionalContexts).toEqual(["HOOK_RAN"])
        const recorded = JSON.parse(yield* Effect.promise(() => fs.readFile(marker, "utf8"))) as { cwd: string }
        expect(recorded.cwd).not.toBe(instance.directory)
        expect((yield* Effect.promise(() => fs.stat(recorded.cwd))).isDirectory()).toBe(true)
      }),
    { git: true },
  )
})
