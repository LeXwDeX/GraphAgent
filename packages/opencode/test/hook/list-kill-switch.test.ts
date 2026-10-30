import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"

const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

const watchHook = {
  PostToolUse: [{ hooks: [{ type: "command", command: "bun watch-ci.ts", asyncRewake: true }] }],
}

const writeHooks =
  (json: unknown) =>
  (dir: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await fs.writeFile(path.join(dir, ".opencode", "hooks.json"), JSON.stringify(json))
    })

describe("SettingsHook.list respects disableAllHooks", () => {
  it.instance(
    "reports a configured hook while the kill switch is off",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        expect(yield* hook.list()).toHaveLength(1)
      }),
    { init: writeHooks(watchHook) },
  )

  it.instance(
    "reports no active hook when disableAllHooks is on",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        expect(yield* hook.list()).toEqual([])
        expect(hook.hasEvent ? yield* hook.hasEvent("PostToolUse") : false).toBe(false)
      }),
    { init: writeHooks({ ...watchHook, disableAllHooks: true }) },
  )
})
