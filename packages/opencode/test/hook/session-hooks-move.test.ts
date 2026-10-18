import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@/session/session"
import { SettingsHook, type HookCommand } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookCwd } from "@/hook/cwd"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Session-scoped hooks live in per-directory InstanceState. The move handler
// has to carry them (plus once-reservations and scoped origins) to the new
// directory, or every skill/runtime hook attached before a move silently stops
// firing for the rest of the session.
const adapter = HookCwd.layer.pipe(
  Layer.provideMerge(Session.defaultLayer),
  Layer.provideMerge(SettingsHook.layer.pipe(Layer.provideMerge(SessionHooks.defaultLayer))),
  Layer.provide(testInstanceStoreLayer),
  Layer.provide(HookLifecycle.defaultLayer),
  Layer.provide(HookFileWatch.defaultLayer),
  Layer.provide(HookConfigChange.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(adapter, MoveSession.defaultLayer, SessionProjector.defaultLayer, HookFileWatch.defaultLayer),
)

const node = (script: string): HookCommand => ({ type: "command", command: process.execPath, args: ["-e", script] })

it.instance(
  "moving a session carries its runtime and skill hooks to the new directory",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const destination = path.join(directory, "nested")
      yield* Effect.promise(() => fs.mkdir(destination))
      const sessions = yield* Session.Service
      const store = yield* SessionHooks.Service
      const settings = yield* SettingsHook.Service
      const instances = yield* InstanceStore.Service
      const session = yield* sessions.create({})

      const script = [
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "MOVED_HOOK_RAN" } }))',
      ].join(";")
      const runtimeID = yield* store.add(session.id, { event: "UserPromptSubmit", hooks: [node(script)] })
      yield* store.registerScoped(session.id, {
        kind: "skill",
        origin: "skill:/skills/demo/SKILL.md",
        source: "user",
        hooks: { UserPromptSubmit: [{ hooks: [node(script)] }] },
      })
      const before = yield* store.listAll(session.id)
      expect(before).toHaveLength(2)
      // Reserve the runtime entry the way a once-hook claim does mid-turn.
      expect(yield* store.claim(session.id, runtimeID)).toBeDefined()

      yield* (yield* MoveSession.Service).moveSession({
        sessionID: session.id,
        destination: { directory: AbsolutePath.make(destination) },
      })

      // The old directory bucket is empty because the entries moved rather than copied.
      expect(yield* store.listAll(session.id)).toEqual([])

      const moved = yield* instances.load({ directory: destination })
      const inNew = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(InstanceRef, moved))
      const after = yield* inNew(store.listAll(session.id))
      expect(after.map((entry) => entry.id).sort()).toEqual(before.map((entry) => entry.id).sort())

      // A live reservation must survive the move; otherwise a `once` hook could run twice.
      expect(yield* inNew(store.claim(session.id, runtimeID))).toBeUndefined()

      // Scoped registration stays idempotent: the skill origin moved with the entries.
      yield* inNew(
        store.registerScoped(session.id, {
          kind: "skill",
          origin: "skill:/skills/demo/SKILL.md",
          source: "user",
          hooks: { UserPromptSubmit: [{ hooks: [node(script)] }] },
        }),
      )
      expect(yield* inNew(store.listAll(session.id))).toHaveLength(2)

      const result = yield* inNew(
        settings.trigger({ event: "UserPromptSubmit", prompt: "hi" }, { sessionID: session.id, transcriptPath: "" }),
      )
      expect(result.additionalContexts).toEqual(["MOVED_HOOK_RAN"])
    }),
  { git: true },
)
