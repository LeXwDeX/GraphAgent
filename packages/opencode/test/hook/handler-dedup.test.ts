import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

// Claude Code runs an identical handler once even when several matching groups
// or settings layers declare it (e.g. a formatter declared globally and per project).
describe("identical hook handlers are deduplicated per trigger", () => {
  it.instance(
    "same command in two matching groups runs once",
    () =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_handler_dedup", transcriptPath: "" },
        )
        const log = yield* Effect.promise(() => fs.readFile(path.join(dir, "count.log"), "utf8"))
        expect(log.trim().split("\n").length).toBe(1)
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          const cmd = `echo x >> '${path.join(dir, "count.log")}'`
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({
              PreToolUse: [
                { matcher: "Bash", hooks: [{ type: "command", command: cmd }] },
                { matcher: "*", hooks: [{ type: "command", command: cmd }] },
              ],
            }),
          )
        }),
    },
  )
  it.instance(
    "distinct commands in matching groups each run",
    () =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_handler_dedup_2", transcriptPath: "" },
        )
        const log = yield* Effect.promise(() => fs.readFile(path.join(dir, "count.log"), "utf8"))
        expect(log.trim().split("\n").sort()).toEqual(["a", "b"])
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          const cmd = (marker: string) => `echo ${marker} >> '${path.join(dir, "count.log")}'`
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({
              PreToolUse: [
                { matcher: "Bash", hooks: [{ type: "command", command: cmd("a") }] },
                { matcher: "*", hooks: [{ type: "command", command: cmd("b") }] },
              ],
            }),
          )
        }),
    },
  )
  it.instance(
    "same command with different execution options each run",
    () =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_handler_dedup_options", transcriptPath: "" },
        )
        const log = yield* Effect.promise(() => fs.readFile(path.join(dir, "count.log"), "utf8"))
        expect(log.trim().split("\n").length).toBe(2)
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          const cmd = `echo x >> '${path.join(dir, "count.log")}'`
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({
              PreToolUse: [
                { matcher: "Bash", hooks: [{ type: "command", command: cmd, timeout: 5 }] },
                { matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 6 }] },
              ],
            }),
          )
        }),
    },
  )
})
