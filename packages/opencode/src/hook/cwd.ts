export * as HookCwd from "./cwd"

import { Effect, Layer } from "effect"
import { SessionCwdHooks } from "@opencode-ai/core/session/cwd-hooks"
import { SettingsHook } from "./settings"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { HookTranscript } from "./transcript"
import { HookLifecycle } from "./lifecycle"
import { HookFileWatch } from "./file-watch"
import { HookConfigChange } from "./config-change"
import { HookSessionContext } from "./session-context"

export const layer = Layer.effect(
  SessionCwdHooks.Service,
  Effect.gen(function* () {
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const lifecycle = yield* HookLifecycle.Service
    const watcher = yield* HookFileWatch.Service
    const config = yield* HookConfigChange.Service
    return SessionCwdHooks.Service.of({
      changed: (change) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(change.sessionID)
          const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
          yield* HookTranscript.clearEnvironment(sessionID, "directory").pipe(Effect.orDie)
          const old = yield* instances.load({ directory: change.previousDirectory })
          const initial = yield* lifecycle.consumeInitial(sessionID).pipe(Effect.provideService(InstanceRef, old))
          yield* lifecycle.detach(sessionID).pipe(Effect.provideService(InstanceRef, old))
          // A CwdChanged result without watchPaths keeps the dynamic list; only [] clears it.
          const watched = yield* watcher.paths(sessionID).pipe(Effect.provideService(InstanceRef, old))
          yield* watcher.clear(sessionID).pipe(Effect.provideService(InstanceRef, old))
          yield* config.clear(sessionID)
          const instance = yield* instances.load({ directory: change.directory })
          yield* Effect.gen(function* () {
            if (initial) yield* lifecycle.queueInitial(sessionID, initial)
            const transcriptPath = yield* HookTranscript.materialize({
              sessionID,
              directory: change.directory,
              messages: yield* sessions.messages({ sessionID }).pipe(Effect.orDie),
            }).pipe(Effect.orDie)
            const result = yield* settings.trigger(
              { event: "CwdChanged", oldCwd: change.previousDirectory, newCwd: change.directory },
              {
                sessionID,
                transcriptPath,
                environmentFile: yield* HookTranscript.environmentFile(sessionID, undefined, "directory").pipe(
                  Effect.orDie,
                ),
                environment: yield* HookTranscript.environment(sessionID).pipe(Effect.orDie),
              },
            )
            yield* SettingsHook.landSystemMessages(result, { sessionID })
            yield* HookSessionContext.applyStart({
              session: { id: sessionID, directory: instance.directory },
              sessions,
              settings,
              result: {
                additionalContexts: [],
                systemMessages: [],
                watchPaths: result.watchPaths ?? (watched ? [...watched] : undefined),
              },
            })
          }).pipe(
            Effect.provideService(HookLifecycle.Service, lifecycle),
            Effect.provideService(HookFileWatch.Service, watcher),
            Effect.provideService(HookConfigChange.Service, config),
            Effect.provideService(InstanceRef, instance),
            Effect.provideService(WorkspaceRef, current.workspaceID),
          )
        }),
    })
  }),
)
