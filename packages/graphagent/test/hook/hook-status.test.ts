// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { SettingsHook, type HookCommand, type HookEvent, type HookPayload } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { LegacyEvent } from "@graphagent/schema/legacy-event"
import { hookIDFor } from "@/hook/engine/plan"
import { testEffect } from "../lib/effect"

const base = SettingsHook.layer.pipe(
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(Layer.mergeAll(base, CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))

type StatusData = {
  sessionID: string
  hookID: string
  event: string
  descriptor: string
  statusMessage?: string
  phase: string
  timeoutMs: number
  cancellable: boolean
  startedAt: number
}

const payload: HookPayload = { event: "PreToolUse", toolName: "bash", toolInput: {} }

function session() {
  return Effect.gen(function* () {
    const store = yield* SessionHooks.Service
    const settings = yield* SettingsHook.Service
    const sessionID = SessionID.descending()
    const register = (entry: HookCommand, event: HookEvent = "PreToolUse") =>
      store.add(sessionID, { event, hooks: [entry] })
    const trigger = () => settings.trigger(payload, { sessionID, transcript: () => Effect.succeed("") })
    return { store, settings, sessionID, register, trigger }
  })
}

const listen = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const seen: StatusData[] = []
  const fiber = yield* events.subscribe(LegacyEvent.HookStatus).pipe(
    Stream.runForEach((event) => Effect.sync(() => void seen.push(event.data as StatusData))),
    Effect.forkScoped,
  )
  return { seen, fiber }
})

describe("session.hook.status", () => {
  it.instance("a handler shorter than the debounce publishes nothing", () =>
    Effect.gen(function* () {
      const { register, trigger } = yield* session()
      const { seen } = yield* listen
      yield* register({ type: "command", command: "true", statusMessage: "fast check" })
      const result = yield* trigger()
      expect(result.blocked).toBeUndefined()
      expect(seen).toEqual([])
    }),
  )

  it.instance("a handler longer than the debounce publishes started and finished with its limits", () =>
    Effect.gen(function* () {
      const { register, trigger, sessionID } = yield* session()
      const { seen } = yield* listen
      const entry: HookCommand = { type: "command", command: "sleep 1.5", statusMessage: "slow check" }
      yield* register(entry)
      yield* trigger()
      expect(seen).toHaveLength(2)
      const [started, finished] = seen
      expect(started).toMatchObject({
        sessionID,
        hookID: hookIDFor(entry),
        event: "PreToolUse",
        descriptor: "sleep 1.5",
        statusMessage: "slow check",
        phase: "started",
        timeoutMs: 30_000,
        cancellable: true,
      })
      expect(typeof started.startedAt).toBe("number")
      expect(finished).toMatchObject({
        hookID: started.hookID,
        phase: "finished",
        timeoutMs: 30_000,
        cancellable: false,
      })
    }),
  )
})

describe("Hooks.cancel", () => {
  const cancelled = (settings: SettingsHook.Interface, sessionID: SessionID, hookID: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (yield* settings.cancel!(sessionID, hookID)) return true
        yield* Effect.sleep("10 millis")
      }
      return false
    })

  it.instance("cancelling a foreground handler keeps the turn running as a non-blocking failure", () =>
    Effect.gen(function* () {
      const { settings, sessionID, register, trigger } = yield* session()
      const entry: HookCommand = { type: "command", command: "sleep 5" }
      yield* register(entry)
      const running = yield* trigger().pipe(Effect.forkChild)
      expect(yield* cancelled(settings, sessionID, hookIDFor(entry))).toBe(true)
      const result = yield* Fiber.join(running)
      expect(result.blocked).toBeUndefined()
      expect(result.permissionDecision).toBeUndefined()
      expect(result.hookErrors?.some((message) => message.includes("hook cancelled"))).toBe(true)
    }),
  )

  it.instance("cancelling an onFailure block handler blocks the tool, matching timeout policy", () =>
    Effect.gen(function* () {
      const { settings, sessionID, register, trigger } = yield* session()
      const entry: HookCommand = { type: "command", command: "sleep 5", onFailure: "block" }
      yield* register(entry)
      const running = yield* trigger().pipe(Effect.forkChild)
      expect(yield* cancelled(settings, sessionID, hookIDFor(entry))).toBe(true)
      const result = yield* Fiber.join(running)
      expect(result.permissionDecision).toBe("deny")
      expect(result.permissionDecisionReason).toContain("hook cancelled")
    }),
  )

  it.instance("an unknown hookID returns false", () =>
    Effect.gen(function* () {
      const { settings, sessionID } = yield* session()
      expect(yield* settings.cancel!(sessionID, "does-not-exist")).toBe(false)
    }),
  )
})
