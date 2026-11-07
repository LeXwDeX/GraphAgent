import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// Real SettingsHook layer with its deps. SessionHooks is exposed via
// Layer.provideMerge (mirrors the goal test pattern) so the tests can also
// assert the SessionEnd dynamic-hook-store cleanup. The body of each
// it.instance test runs inside a fresh temp instance dir (via withTmpdirInstance),
// so SettingsHook's InstanceState-built state (loadChain + the seen Map) is
// fresh per test and loadChain reads the .agents/hooks.json we write.
const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const it = testEffect(testLayer)

// A SessionStart command hook whose stdout is JSON carrying a fixed
// additionalContext string. `printf '%s' '<json>'` single-quotes the JSON so
// its inner double-quotes reach the shell literally; parseStdout then
// JSON.parses the trimmed output into HookJSONOutput. printf is POSIX, so
// /bin/sh -c handles it on the test host.
const CONTEXT = "ctx-F2-dedup-marker"
const HOOK_JSON = JSON.stringify({ hookSpecificOutput: { additionalContext: CONTEXT } })
// hooks.json uses top-level event keys (D1 canonical format); loadChain reads
// .agents/hooks.json (no longer .agents/settings.json).
const hooksJson = {
  SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${HOOK_JSON}'` }] }],
}

// Writes <dir>/.agents/hooks.json (loadChain reads this path), so the
// SessionStart matcher participates in the trigger pipeline.
const writeSettings = (dir: string) =>
  Effect.promise(() =>
    fs.mkdir(path.join(dir, ".agents"), { recursive: true }).then(() =>
      fs.writeFile(path.join(dir, ".agents", "hooks.json"), JSON.stringify(hooksJson)),
    ),
  )

describe("SettingsHook additionalContext dedup — per-session (F2)", () => {
  // F2 core: dedup is bucketed per sessionID, so a context the first session
  // already saw is NOT starved for a second session.
  it.instance(
    "two different sessions each receive the same additionalContext (no cross-session dedup)",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service

        const r1 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-a", transcriptPath: "" },
        )
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-b", transcriptPath: "" },
        )

        expect(r1.additionalContexts).toEqual([CONTEXT])
        expect(r2.additionalContexts).toEqual([CONTEXT])
      }),
    { init: writeSettings },
  )

  // F2 core: within ONE session the same context surfaces exactly once.
  it.instance(
    "same session, same context twice — second trigger is deduped (per-session)",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service

        const r1 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-dedup", transcriptPath: "" },
        )
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-dedup", transcriptPath: "" },
        )

        expect(r1.additionalContexts).toEqual([CONTEXT])
        expect(r2.additionalContexts).toEqual([])
      }),
    { init: writeSettings },
  )

  // F2B: SessionEnd evicts the session's seen bucket, so re-using the same
  // sessionID after end re-surfaces the context. This is the eviction path
  // that also prevents the seen Map from growing unboundedly.
  it.instance(
    "SessionEnd evicts the seen bucket — same context re-surfaces for that session",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service

        const r1 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-evict", transcriptPath: "" },
        )
        expect(r1.additionalContexts).toEqual([CONTEXT])

        // End the session — trigger's SessionEnd branch deletes the bucket.
        // (Runs before the WP-6A short-circuit even though there is no
        // SessionEnd hook configured.)
        yield* hook.trigger(
          { event: "SessionEnd", reason: "other" },
          { sessionID: "sess-f2-evict", transcriptPath: "" },
        )

        // Same session ID again — bucket was cleared, so the context re-surfaces.
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f2-evict", transcriptPath: "" },
        )
        expect(r2.additionalContexts).toEqual([CONTEXT])
      }),
    { init: writeSettings },
  )
})

describe("SettingsHook SessionEnd — clears the dynamic SessionHooks store (F2)", () => {
  // F2B: SessionHooks.clear was defined but never invoked. trigger's SessionEnd
  // branch now calls it, so a session's dynamically-attached hooks are freed on
  // end. Verified by attaching a hook, firing SessionEnd (which has no on-disk
  // matcher, so it would short-circuit — cleanup runs first), then confirming
  // the store is empty.
  it.instance(
    "SessionEnd removes the session's dynamic hooks",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const sessionHooks = yield* SessionHooks.Service
        const sid = SessionID.make("sess-f2-hookclear")

        yield* sessionHooks.add(sid, {
          event: "Stop",
          hooks: [{ type: "command", command: "true" }],
        })
        const before = yield* sessionHooks.list(sid, "Stop")
        expect(before.length).toBe(1)

        yield* hook.trigger({ event: "SessionEnd", reason: "other" }, { sessionID: "sess-f2-hookclear", transcriptPath: "" })

        const after = yield* sessionHooks.list(sid, "Stop")
        expect(after.length).toBe(0)
      }),
    // No settings file: there is no on-disk hook, and the SessionEnd cleanup
    // must run even on the short-circuit path — that is what this test asserts.
  )
})
