import { consumerContext } from "./consumer-context"
import { Effect, Option } from "effect"
import type { Session } from "@/session/session"
import type { SettingsHook } from "./settings"
import type { TriggerResult } from "./trigger-result"
import type { HookStartContext } from "./start-context"
import { HookLifecycle } from "./lifecycle"
import { HookFileWatch } from "./file-watch"
import { HookConfigChange } from "./config-change"
import { HookTranscript } from "./transcript"
import { landSystemMessages } from "./trigger-result"

/** Shared by startup, resume, fork and compact. No Session/Settings runtime import. */
export const applyStart = Effect.fn("HookSessionContext.applyStart")(function* (input: {
  session: Pick<Session.Info, "id" | "directory">
  sessions: Session.Interface
  settings: SettingsHook.Interface
  result: TriggerResult
  startContext?: HookStartContext.Interface
  reloadSkills?: Effect.Effect<void>
}) {
  const { session, sessions, settings, result } = input
  const { Permission } = yield* Effect.promise(() => import("@/permission"))
  const permissions = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
  const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
  if (lifecycle) {
    yield* lifecycle.attach(session.id)
    if (result.initialUserMessage) yield* lifecycle.queueInitial(session.id, result.initialUserMessage)
  }
  if (result.sessionTitle) yield* sessions.setTitle({ sessionID: session.id, title: result.sessionTitle })
  if (result.reloadSkills && input.reloadSkills) yield* input.reloadSkills
  if (input.startContext) {
    yield* input.startContext.markStarted(session.id)
    for (const text of result.additionalContexts) if (text) yield* input.startContext.append(session.id, text)
  }
  const watcher = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
  if (watcher) {
    yield* watcher.refreshStatic(yield* settings.fileWatchPaths?.() ?? Effect.succeed([]))
    const onChange = (file: string, event: "change" | "add" | "unlink"): Effect.Effect<void> =>
      Effect.gen(function* () {
        const changed = yield* settings.trigger(
          { event: "FileChanged", path: file, changeType: event },
          {
            ...(yield* consumerContext(
              session.id,
              permissions ? (yield* permissions.hookPolicy(session.id)).mode : undefined,
              (yield* sessions.get(session.id).pipe(Effect.orDie)).agent,
            ).pipe(Effect.orDie)),
            environmentFile: yield* HookTranscript.environmentFile(session.id).pipe(Effect.orDie),
          },
        )
        yield* landSystemMessages(changed, { sessionID: session.id })
        if (changed.watchPaths) yield* watcher.replace(session.id, changed.watchPaths, onChange)
      })
    yield* watcher.replace(session.id, result.watchPaths, onChange)
  }
  const config = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
  if (config)
    yield* config.register(session.id, session.directory, (change) =>
      Effect.gen(function* () {
        const changed = yield* settings.trigger(
          { event: "ConfigChange", configPath: change.path, source: change.source },
          {
            ...(yield* consumerContext(
              session.id,
              permissions ? (yield* permissions.hookPolicy(session.id)).mode : undefined,
              (yield* sessions.get(session.id).pipe(Effect.orDie)).agent,
            ).pipe(Effect.orDie)),
            environmentFile: yield* HookTranscript.environmentFile(session.id).pipe(Effect.orDie),
          },
        )
        yield* landSystemMessages(changed, { sessionID: session.id })
        return { blocked: changed.blocked }
      }),
    )
})
export * as HookSessionContext from "./session-context"
