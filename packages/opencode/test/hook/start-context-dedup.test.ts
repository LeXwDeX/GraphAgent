import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"

// Real SettingsHook layer; a command hook that prints identical JSON context every time, as
// typical context-augment hooks do. Dedup must not starve child sessions or post-compaction
// re-injection.
const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

const FIXED = "FIXED"
const command = (event: string) =>
  `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: FIXED } })}'`

const write = (events: readonly string[]) => (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "hooks.json"),
      JSON.stringify(
        Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command: command(event) }] }]])),
      ),
    )
  })

describe("SessionStart / SubagentStart additionalContext dedup", () => {
  it.instance(
    "SubagentStart on the same parent session gives every child the context",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const ctx = { sessionID: "ses_parent_subagents", transcriptPath: "" }
        const a = yield* hook.trigger({ event: "SubagentStart", agentID: "child_a", agentType: "explore" }, ctx)
        const b = yield* hook.trigger({ event: "SubagentStart", agentID: "child_b", agentType: "explore" }, ctx)
        expect(a.additionalContexts).toEqual([FIXED])
        expect(b.additionalContexts).toEqual([FIXED])
      }),
    { init: write(["SubagentStart"]) },
  )

  it.instance(
    "SubagentStart is not suppressed by the parent's SessionStart text",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const ctx = { sessionID: "ses_parent_start", transcriptPath: "" }
        const start = yield* hook.trigger({ event: "SessionStart", source: "startup" }, ctx)
        const child = yield* hook.trigger({ event: "SubagentStart", agentID: "child_c", agentType: "explore" }, ctx)
        expect(start.additionalContexts).toEqual([FIXED])
        expect(child.additionalContexts).toEqual([FIXED])
      }),
    { init: write(["SessionStart", "SubagentStart"]) },
  )

  it.instance(
    "SessionStart(compact) re-injects identical context; later events dedupe per session again",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const ctx = { sessionID: "ses_compact", transcriptPath: "" }
        const startup = yield* hook.trigger({ event: "SessionStart", source: "startup" }, ctx)
        const compact = yield* hook.trigger({ event: "SessionStart", source: "compact" }, ctx)
        expect(startup.additionalContexts).toEqual([FIXED])
        expect(compact.additionalContexts).toEqual([FIXED])
        // The compact trigger re-seeded the bucket with FIXED: the same text from a per-session
        // event is deduped, as before.
        const prompt = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "a" }, ctx)
        expect(prompt.additionalContexts).toEqual([])
        // Another compaction clears the bucket again.
        const compact2 = yield* hook.trigger({ event: "SessionStart", source: "compact" }, ctx)
        expect(compact2.additionalContexts).toEqual([FIXED])
      }),
    { init: write(["SessionStart", "UserPromptSubmit"]) },
  )

  it.instance(
    "SessionStart(compact) of one session does not reset another session's dedup",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const a = { sessionID: "ses_compact_a", transcriptPath: "" }
        const b = { sessionID: "ses_compact_b", transcriptPath: "" }
        const first = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "x" }, b)
        yield* hook.trigger({ event: "SessionStart", source: "compact" }, a)
        const again = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "y" }, b)
        expect(first.additionalContexts).toEqual([FIXED])
        expect(again.additionalContexts).toEqual([])
      }),
    { init: write(["SessionStart", "UserPromptSubmit"]) },
  )

  it.instance(
    "SessionStart(compact) forgets seen context even when no SessionStart hook is configured",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const ctx = { sessionID: "ses_compact_no_start_hook", transcriptPath: "" }
        const before = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "a" }, ctx)
        const deduped = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "b" }, ctx)
        yield* hook.trigger({ event: "SessionStart", source: "compact" }, ctx)
        const after = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "c" }, ctx)
        expect(before.additionalContexts).toEqual([FIXED])
        expect(deduped.additionalContexts).toEqual([])
        expect(after.additionalContexts).toEqual([FIXED])
      }),
    { init: write(["UserPromptSubmit"]) },
  )

  it.instance(
    "SessionStart(resume) keeps per-session dedup",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const ctx = { sessionID: "ses_resume", transcriptPath: "" }
        const first = yield* hook.trigger({ event: "SessionStart", source: "resume" }, ctx)
        const second = yield* hook.trigger({ event: "SessionStart", source: "resume" }, ctx)
        expect(first.additionalContexts).toEqual([FIXED])
        expect(second.additionalContexts).toEqual([])
      }),
    { init: write(["SessionStart"]) },
  )
})
