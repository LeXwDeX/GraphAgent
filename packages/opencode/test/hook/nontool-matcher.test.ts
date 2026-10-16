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

const ctxHook = (marker: string) => ({
  type: "command",
  command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { additionalContext: marker } })}'`,
})

// Claude Code matches non-tool events against an event-specific field:
// SessionStart → source (startup|resume|clear|compact), PreCompact → trigger
// (manual|auto), SessionEnd → reason, Notification → notification_type.
// /import-claude-hooks imports such matchers "as-is".
const write = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify({
        SessionStart: [
          { matcher: "startup", hooks: [ctxHook("session-start-startup")] },
          { matcher: "resume|compact", hooks: [ctxHook("session-start-resume")] },
        ],
        PreCompact: [
          {
            matcher: "auto",
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ decision: "block", reason: "precompact-auto" })}'`,
              },
            ],
          },
        ],
        SubagentStop: [{ matcher: "explore", hooks: [ctxHook("subagent-explore")] }],
        // UserPromptSubmit has no matcher support: the matcher is ignored.
        UserPromptSubmit: [{ matcher: "anything", hooks: [ctxHook("prompt-always")] }],
      }),
    )
  })

describe("matchers on non-tool events", () => {
  it.instance(
    "SessionStart matcher 'startup' fires for source=startup",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses_matcher_1", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual(["session-start-startup"])
      }),
    { init: write },
  )

  it.instance(
    "PreCompact matcher 'auto' fires for trigger=auto",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "PreCompact", trigger: "auto" },
          { sessionID: "ses_matcher_2", transcriptPath: "" },
        )
        expect(r.blocked?.reason).toBe("precompact-auto")
        const manual = yield* hook.trigger(
          { event: "PreCompact", trigger: "manual" },
          { sessionID: "ses_matcher_2b", transcriptPath: "" },
        )
        expect(manual.blocked).toBeUndefined()
      }),
    { init: write },
  )

  it.instance(
    "SubagentStop matcher filters on agent type",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const hit = yield* hook.trigger(
          { event: "SubagentStop", stopHookActive: false, agentType: "explore" },
          { sessionID: "ses_matcher_3", transcriptPath: "" },
        )
        const miss = yield* hook.trigger(
          { event: "SubagentStop", stopHookActive: false, agentType: "general" },
          { sessionID: "ses_matcher_3", transcriptPath: "" },
        )
        expect(hit.additionalContexts).toEqual(["subagent-explore"])
        expect(miss.additionalContexts).toEqual([])
      }),
    { init: write },
  )

  it.instance(
    "events without matcher support ignore the matcher",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "hi" },
          { sessionID: "ses_matcher_4", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual(["prompt-always"])
      }),
    { init: write },
  )
})
