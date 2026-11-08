import { expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { AbsolutePath } from "@graphagent/core/schema"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Location } from "@graphagent/core/location"
import { SessionEvent } from "@graphagent/core/session/event"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { AppLayer } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HookRewake } from "@/hook/rewake"
import { SessionHooks } from "@/hook/session-hooks"
import { SettingsHook } from "@/hook"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionCancellation } from "@/session/cancellation"
import * as Log from "@/util/log"
import { tmpdir } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

test("abort after a move invalidates the old Stop callback without masking the next chain", async () => {
  await using a = await tmpdir({ git: true })
  await using b = await tmpdir()
  await rm(b.path, { recursive: true, force: true })
  await $`git worktree add --detach ${b.path} HEAD`.cwd(a.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const hooks = yield* SessionHooks.Service
          const settings = yield* SettingsHook.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: a.path })
          yield* instances.load({ directory: b.path })
          yield* Effect.addFinalizer(() => instances.disposeAll())
          const inA = <A, E, R>(effect: Effect.Effect<A, E, R>) => instances.provide({ directory: a.path }, effect)
          const inB = <A, E, R>(effect: Effect.Effect<A, E, R>) => instances.provide({ directory: b.path }, effect)
          const session = yield* inA(sessions.create({ title: "moved Stop callback" }))
          const ready = path.join(a.path, "hook-ready")
          const release = path.join(a.path, "hook-release")
          const woke = yield* Deferred.make<void>()
          let discarded = false
          const previousLevel = process.env.GRAPHAGENT_LOG_LEVEL
          process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              Log.setSink((entry) => {
                if (
                  entry.message === "async Stop callback discarded: chain invalidated" &&
                  entry.meta?.includes(`sessionID=${session.id}`)
                )
                  discarded = true
              }),
            ),
            (restore) =>
              Effect.sync(() => {
                restore()
                if (previousLevel === undefined) delete process.env.GRAPHAGENT_LOG_LEVEL
                else process.env.GRAPHAGENT_LOG_LEVEL = previousLevel
              }),
          )
          const rewake = HookRewake.Service.of({ rewake: () => Deferred.succeed(woke, undefined).pipe(Effect.asVoid) })
          const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
          yield* inA(
            hooks.add(session.id, {
              event: "Stop",
              hooks: [
                {
                  type: "command",
                  async: true,
                  asyncRewake: true,
                  command: `touch ${quote(ready)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf stale >&2; exit 2`,
                },
              ],
            }),
          )
          yield* inA(
            settings
              .trigger({ event: "Stop", stopHookActive: false }, { sessionID: session.id, transcriptPath: "" })
              .pipe(Effect.provideService(HookRewake.Service, rewake)),
          )
          yield* pollWithTimeout(
            Effect.promise(() =>
              Bun.file(ready)
                .exists()
                .then((exists) => (exists ? true : undefined)),
            ),
            "old Stop callback did not start",
            "10 seconds",
          )
          yield* inA(
            events
              .publish(SessionEvent.Moved, {
                sessionID: session.id,
                location: Location.Ref.make({ directory: AbsolutePath.make(b.path) }),
                timestamp: yield* DateTime.now,
              })
              .pipe(Effect.orDie),
          )
          yield* inB(prompt.cancel(session.id))
          yield* Effect.promise(() => writeFile(release, "go"))
          yield* pollWithTimeout(
            Effect.gen(function* () {
              return discarded || (yield* Deferred.isDone(woke)) ? true : undefined
            }),
            "old Stop callback did not settle",
            "10 seconds",
          )
          expect(discarded).toBe(true)
          expect(yield* Deferred.isDone(woke)).toBe(false)
          yield* inA(hooks.clear(session.id))
          yield* inA(
            hooks.add(session.id, {
              event: "Stop",
              hooks: [{ type: "command", async: true, asyncRewake: true, command: "printf fresh >&2; exit 2" }],
            }),
          )
          yield* inA(
            settings
              .trigger({ event: "Stop", stopHookActive: false }, { sessionID: session.id, transcriptPath: "" })
              .pipe(Effect.provideService(HookRewake.Service, rewake)),
          )
          yield* awaitWithTimeout(Deferred.await(woke), "new Stop callback was masked", "10 seconds")
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${b.path}`.cwd(a.path).quiet()
  }
}, 60_000)

test("abort after a move cancels an old pending model switch without a runner", async () => {
  await using a = await tmpdir({ git: true, config: testProviderConfig("http://127.0.0.1:1") })
  await using b = await tmpdir()
  await rm(b.path, { recursive: true, force: true })
  await $`git worktree add --detach ${b.path} HEAD`.cwd(a.path).quiet()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const settings = yield* SettingsHook.Service
          const events = yield* EventV2Bridge.Service
          yield* instances.load({ directory: a.path })
          yield* instances.load({ directory: b.path })
          yield* Effect.addFinalizer(() => instances.disposeAll())
          const inA = <A, E, R>(effect: Effect.Effect<A, E, R>) => instances.provide({ directory: a.path }, effect)
          const inB = <A, E, R>(effect: Effect.Effect<A, E, R>) => instances.provide({ directory: b.path }, effect)
          const session = yield* inA(
            sessions.create({
              title: "moved model switch",
              model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
            }),
          )
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          const replacementStarted = yield* Deferred.make<void>()
          const replacementStopped = yield* Deferred.make<void>()
          let calls = 0
          const trigger = settings.trigger
          const spy = spyOn(settings, "trigger").mockImplementation((payload, context) =>
            payload.event === "PostModelSwitch" && context.sessionID === session.id
              ? Effect.suspend(() => {
                  const first = calls++ === 0
                  return Deferred.succeed(first ? started : replacementStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(first ? stopped : replacementStopped, undefined)),
                  )
                })
              : trigger(payload, context),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
          yield* inA(prompt.restoreModelContext(session.id))
          yield* awaitWithTimeout(Deferred.await(started), "model switch did not start", "10 seconds")
          const old = SessionCancellation.begin(session.id)
          yield* Effect.addFinalizer(() => Effect.sync(old.finish))
          expect(old.owners).toHaveLength(1)
          old.finish()
          yield* inA(prompt.restoreModelContext(session.id))
          yield* awaitWithTimeout(Deferred.await(stopped), "old model switch was not replaced")
          yield* awaitWithTimeout(Deferred.await(replacementStarted), "replacement model switch did not start")
          yield* Effect.all(old.owners)
          expect(yield* Deferred.isDone(replacementStopped)).toBe(false)
          yield* inA(
            events
              .publish(SessionEvent.Moved, {
                sessionID: session.id,
                location: Location.Ref.make({ directory: AbsolutePath.make(b.path) }),
                timestamp: yield* DateTime.now,
              })
              .pipe(Effect.orDie),
          )
          yield* inB(prompt.cancel(session.id))
          yield* awaitWithTimeout(Deferred.await(replacementStopped), "old model switch was not cancelled", "3 seconds")
        }),
      ).pipe(Effect.provide(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer))),
    )
  } finally {
    await $`git worktree remove --force ${b.path}`.cwd(a.path).quiet()
  }
}, 60_000)
