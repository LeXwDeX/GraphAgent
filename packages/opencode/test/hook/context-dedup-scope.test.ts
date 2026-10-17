import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

// A PostToolUse validator (lint / typecheck) that reports the same failure
// each time the model makes the same mistake. Only tool events skip per-session
// dedup; SessionStart keeps session dedup (see settings-dedup.test.ts).
const FEEDBACK = "lint: missing semicolon at src/a.ts:3"
const write = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: FEEDBACK } })}'`,
              },
            ],
          },
        ],
      }),
    )
  })

const post = (callID: string) =>
  ({
    event: "PostToolUse",
    toolName: "edit",
    toolInput: { filePath: "src/a.ts" },
    toolResponse: "ok",
    toolUseID: callID,
  }) as const

describe("additionalContext dedup scope", () => {
  it.instance(
    "repeated PostToolUse validation feedback reaches the model every time",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r1 = yield* hook.trigger(post("call-1"), { sessionID: "ses_context_dedup", transcriptPath: "" })
        const r2 = yield* hook.trigger(post("call-2"), { sessionID: "ses_context_dedup", transcriptPath: "" })
        expect(r1.additionalContexts).toEqual([FEEDBACK])
        // Second edit reintroduces the same lint error; the hook reports it again.
        expect(r2.additionalContexts).toEqual([FEEDBACK])
      }),
    { init: write },
  )

  it.instance(
    "identical contexts from several hooks in one trigger surface once",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(post("call-3"), { sessionID: "ses_context_dedup_2", transcriptPath: "" })
        expect(r.additionalContexts).toEqual([FEEDBACK])
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          const output = (marker: string) =>
            `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: FEEDBACK } })}' # ${marker}`
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({
              PostToolUse: [
                {
                  matcher: "Edit",
                  hooks: [
                    { type: "command", command: output("a") },
                    { type: "command", command: output("b") },
                  ],
                },
              ],
            }),
          )
        }),
    },
  )
  it.instance(
    "a Stop hook repeating the same context can continue each turn",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const stop = { event: "Stop", stopHookActive: false } as const
        const ctx = { sessionID: "ses_context_dedup_stop", transcriptPath: "" }
        expect((yield* hook.trigger(stop, ctx)).additionalContexts).toEqual(["stop-feedback"])
        expect((yield* hook.trigger(stop, ctx)).additionalContexts).toEqual(["stop-feedback"])
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".opencode", "hooks.json"),
            JSON.stringify({
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { additionalContext: "stop-feedback" } })}'`,
                    },
                  ],
                },
              ],
            }),
          )
        }),
    },
  )
})
