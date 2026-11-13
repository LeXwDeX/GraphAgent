// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { SettingsHook } from "@/hook"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// D1 PR2: the engine's per-trigger RunContext is lazy. A trigger that matches
// no handler must not materialize a transcript or source the hook environment,
// and a trigger that matches handlers evaluates each provider at most once.
// Materialize always routes through HookLifecycle.serializeTranscript, so the
// mock below counts evaluations without touching the engine internals.
const serializeCalls: string[] = []
const environmentCalls: string[] = []

const lifecycle = Layer.succeed(
  HookLifecycle.Service,
  HookLifecycle.Service.of({
    claimChildStart: () => Effect.succeed(true),
    claimChildStop: () => Effect.succeed(true),
    attach: () => Effect.void,
    detach: () => Effect.void,
    claimEnd: () => Effect.succeed(true),
    serializeTranscript: (sessionID, effect) => {
      serializeCalls.push(sessionID)
      return effect
    },
    environment: (sessionID, _signature, load) => {
      environmentCalls.push(sessionID)
      return load
    },
    queueInitial: () => Effect.void,
    consumeInitial: () => Effect.succeed(undefined),
    attached: () => Effect.succeed([]),
  }),
)

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(lifecycle),
)
const it = testEffect(testLayer)

const reset = () => {
  serializeCalls.length = 0
  environmentCalls.length = 0
}

const commandHooks = (dir: string, markers: readonly string[]) => (hookDir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(hookDir, ".agents"), { recursive: true })
    await fs.writeFile(
      path.join(hookDir, ".agents", "hooks.json"),
      JSON.stringify({
        PreToolUse: markers.map((marker) => ({
          matcher: "*",
          hooks: [{ type: "command", command: `echo "handler:${marker}" >> '${path.join(dir, marker)}'` }],
        })),
      }),
    )
  })

// The event is configured, but neither entry can run for this call: one matcher
// names another tool and one `if` condition names another tool. Planning reaches
// the entry loop and short-circuits on no_runnable_entries instead of no_matchers.
const noRunnableHooks = (dir: string) => (hookDir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(hookDir, ".agents"), { recursive: true })
    await fs.writeFile(
      path.join(hookDir, ".agents", "hooks.json"),
      JSON.stringify({
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: `echo "handler:matcher" >> '${path.join(dir, "matcher.log")}'` }],
          },
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                if: "Edit(*.ts)",
                command: `echo "handler:if" >> '${path.join(dir, "if.log")}'`,
              },
            ],
          },
        ],
      }),
    )
  })

describe("lazy per-trigger run context", () => {
  it.instance("no matching handler evaluates no lazy provider", () =>
    Effect.gen(function* () {
      reset()
      const hook = yield* SettingsHook.Service
      const result = yield* hook.trigger(
        { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
        { sessionID: "ses_lazy_none" },
      )
      expect(result.additionalContexts).toEqual([])
      expect(serializeCalls).toEqual([])
      expect(environmentCalls).toEqual([])
    }),
  )

  it.instance(
    "two matching handlers evaluate the transcript once",
    () =>
      Effect.gen(function* () {
        reset()
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        const result = yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_lazy_once" },
        )
        expect(result.hookErrors ?? []).toEqual([])
        // Both handlers ran (distinct commands) but shared one materialization
        // and one environment source.
        expect(serializeCalls).toEqual(["ses_lazy_once"])
        expect(environmentCalls).toEqual(["ses_lazy_once"])
        expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "a.log"), "utf8"))).toBe("handler:a.log\n")
        expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "b.log"), "utf8"))).toBe("handler:b.log\n")
      }),
    { init: (dir) => commandHooks(dir, ["a.log", "b.log"])(dir) },
  )

  it.instance(
    "a configured event with no runnable handler evaluates no lazy provider",
    () =>
      Effect.gen(function* () {
        reset()
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        const result = yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_lazy_no_runnable" },
        )
        expect(result.additionalContexts).toEqual([])
        // Matcher and `if` exclude this call, so planning ends with no entries:
        // nothing is materialized and no handler command runs.
        expect(serializeCalls).toEqual([])
        expect(environmentCalls).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "matcher.log")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "if.log")).exists())).toBe(false)
      }),
    { init: (dir) => noRunnableHooks(dir)(dir) },
  )

  it.instance(
    "an explicit transcript skips materialization",
    () =>
      Effect.gen(function* () {
        reset()
        const { directory: dir } = yield* TestInstance
        const hook = yield* SettingsHook.Service
        yield* hook.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          { sessionID: "ses_lazy_explicit", transcript: () => Effect.succeed("/tmp/explicit.jsonl") },
        )
        expect(serializeCalls).toEqual([])
        expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "a.log"), "utf8"))).toBe("handler:a.log\n")
      }),
    { init: (dir) => commandHooks(dir, ["a.log"])(dir) },
  )
})
