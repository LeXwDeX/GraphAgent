// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import * as Log from "@/util/log"
import { testEffect } from "../lib/effect"

// P1a: exit-0 plain-text stdout injection. Real SettingsHook layer (execShell
// actually runs the command), mirroring settings-dedup.test.ts. Each test writes
// its own .agents/hooks.json via init so the InstanceState-built loadChain
// picks it up at construction.

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(testLayer)

const TEXT = "remember-this-repo-uses-bun"

// Write <dir>/.agents/hooks.json with the given hooks object. loadChain reads
// this path at instance-state construction (init runs before the test body).
const writeHooks = (hooks: unknown) => (dir: string) =>
  Effect.promise(() =>
    fs
      .mkdir(path.join(dir, ".agents"), { recursive: true })
      .then(() => fs.writeFile(path.join(dir, ".agents", "hooks.json"), JSON.stringify(hooks))),
  )

describe("SettingsHook exit-0 plain-text stdout → additionalContext (P1a)", () => {
  // Scenario 1: UserPromptSubmit command hook exits 0 with plain-text stdout →
  // that text is injected as additionalContext.
  it.instance(
    "UserPromptSubmit plain-text stdout is injected as additionalContext",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "test" },
          { sessionID: "sess-p1a-1", transcript: () => Effect.succeed("") },
        )
        expect(r.additionalContexts).toEqual([TEXT])
      }),
    {
      init: writeHooks({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s' '${TEXT}'` }] }],
      }),
    },
  )

  // Scenario 2: when stdout is a valid JSON envelope, only the envelope's
  // additionalContext is injected — the raw JSON string is NOT also injected.
  it.instance(
    "JSON stdout is parsed, not double-injected as raw text",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-p1a-2", transcript: () => Effect.succeed("") },
        )
        expect(r.additionalContexts).toEqual(["from-json"])
        // The raw JSON string must not leak through as a second context entry.
        expect(r.additionalContexts.some((c) => c.includes("hookSpecificOutput"))).toBe(false)
      }),
    {
      init: writeHooks({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "from-json" } })}'`,
              },
            ],
          },
        ],
      }),
    },
  )

  // Scenario 2b: hookSpecificOutput is only honoured when its hookEventName
  // discriminator matches the triggering event. A missing or mismatched name
  // drops the whole object (D1 §6.5) and leaves a debug trace; the parsed JSON
  // must not fall back to plain-text injection.
  it.instance(
    "hookSpecificOutput with a missing or mismatched hookEventName is ignored",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const seen: string[] = []
        const previous = process.env.GRAPHAGENT_LOG_LEVEL
        process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
        const restore = Log.setSink((entry) => {
          if (entry.message === "ignored hookSpecificOutput for a different event") seen.push(entry.message)
        })
        try {
          // One trigger runs both configured handlers: one reports a
          // mismatched event name, the other omits it entirely.
          const result = yield* hook.trigger(
            { event: "SessionStart", source: "startup" },
            { sessionID: "sess-hso-discriminator", transcript: () => Effect.succeed("") },
          )
          expect(result.additionalContexts).toEqual([])
          yield* Effect.promise(() => Log.flush())
          expect(seen).toHaveLength(2)
        } finally {
          restore()
          if (previous === undefined) delete process.env.GRAPHAGENT_LOG_LEVEL
          else process.env.GRAPHAGENT_LOG_LEVEL = previous
        }
      }),
    {
      init: writeHooks({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "wrong-event" } })}'`,
              },
              {
                type: "command",
                command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { additionalContext: "missing-event" } })}'`,
              },
            ],
          },
        ],
      }),
    },
  )

  // Scenario 3: other events (PostToolUse) keep the prior behavior — plain-text
  // exit-0 stdout is NOT injected (only logged).
  it.instance(
    "PostToolUse plain-text stdout is NOT injected (other events unchanged)",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "PostToolUse", toolName: "bash", toolInput: {}, toolResponse: {} },
          { sessionID: "sess-p1a-3", transcript: () => Effect.succeed("") },
        )
        expect(r.additionalContexts).toEqual([])
      }),
    {
      init: writeHooks({
        PostToolUse: [{ hooks: [{ type: "command", command: `printf '%s' '${TEXT}'` }] }],
      }),
    },
  )

  // Scenario 4: each prompt is a new turn, so identical plain-text stdout is
  // delivered again. Only duplicate text from one trigger is deduplicated.
  it.instance(
    "same plain-text stdout is delivered for every prompt",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r1 = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "test" },
          { sessionID: "sess-p1a-4", transcript: () => Effect.succeed("") },
        )
        const r2 = yield* hook.trigger(
          { event: "UserPromptSubmit", prompt: "test" },
          { sessionID: "sess-p1a-4", transcript: () => Effect.succeed("") },
        )
        expect(r1.additionalContexts).toEqual([TEXT])
        expect(r2.additionalContexts).toEqual([TEXT])
      }),
    {
      init: writeHooks({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s' '${TEXT}'` }] }],
      }),
    },
  )
})

// SessionStart initialUserMessage becomes a user turn, so it needs the same
// reminder escaping and 10,000-character bound as every other hook string.
describe("SettingsHook initialUserMessage safety", () => {
  const initial = (text: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", initialUserMessage: text } })

  it.instance(
    "escapes system-reminder tags",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-initial-escape", transcript: () => Effect.succeed("") },
        )
        expect(r.initialUserMessage).toBe("&lt;system-reminder>x&lt;/system-reminder>")
      }),
    {
      init: writeHooks({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${initial("<system-reminder>x</system-reminder>")}'`,
              },
            ],
          },
        ],
      }),
    },
  )

  it.instance(
    "does not admit content beyond the 10,000-character cap",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-initial-cap", transcript: () => Effect.succeed("") },
        )
        expect(r.initialUserMessage).toBeDefined()
        expect(r.initialUserMessage?.startsWith("Full context saved to ")).toBe(true)
        expect(r.initialUserMessage).not.toContain("TAIL_MARKER")
        const [header, , preview] = r.initialUserMessage!.split("\n")
        expect(preview.length).toBe(2_000)
        const file = header.slice("Full context saved to ".length)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(`${"A".repeat(10_000)}TAIL_MARKER`)
      }),
    {
      init: writeHooks({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s' '${initial(`${"A".repeat(10_000)}TAIL_MARKER`)}'`,
              },
            ],
          },
        ],
      }),
    },
  )
})
