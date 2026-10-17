import { Effect, Option } from "effect"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { HookLifecycle } from "./lifecycle"
import { HookTranscript } from "./transcript"
import { promptIdentity } from "./prompt-identity"
import { HookConfigChange } from "./config-change"
import { HookFileWatch } from "./file-watch"

/** A local client detaches a specific session; directory disposal alone is not a session end. */
export const endLocalSession = Effect.fn("HookClientLifecycle.endLocalSession")(function* (input: {
  sessionID: string
  directory: string
  reason: "other" | "prompt_input_exit" | "resume" | "clear" | "logout"
}) {
  const instance = yield* (yield* InstanceStore.Service).load({ directory: input.directory })
  return yield* Effect.gen(function* () {
    const [{ SessionAttention }, { SessionStatus }] = yield* Effect.promise(() =>
      Promise.all([import("@/notification/attention"), import("@/session/status")]),
    )
    const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
    const status = Option.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
    if (status?.clear) yield* status.clear(SessionID.make(input.sessionID))
    if (attention) yield* attention.clear(input.sessionID)
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const { SettingsHook } = yield* Effect.promise(() => import("./settings"))
    const { Session } = yield* Effect.promise(() => import("@/session/session"))
    const settings = yield* SettingsHook.Service
    const session = yield* Session.Service
    const id = SessionID.make(input.sessionID)
    const finish = Effect.gen(function* () {
      // Materialize before claiming: a failed transcript read must not consume the one SessionEnd attempt.
      const messages = yield* session.messages({ sessionID: id }).pipe(Effect.orDie)
      const transcriptPath = yield* HookTranscript.materialize({
        sessionID: id,
        directory: input.directory,
        messages,
      }).pipe(Effect.orDie)
      if (lifecycle && !(yield* lifecycle.claimEnd(input.sessionID))) return
      const result = yield* settings.trigger(
        { event: "SessionEnd", reason: input.reason },
        {
          sessionID: id,
          ...promptIdentity(messages),
          transcriptPath,
          environment: yield* HookTranscript.environment(id).pipe(Effect.orDie),
        },
      )
      yield* SettingsHook.landSystemMessages(result, { sessionID: id })
      if (settings.settleSessionEnd) yield* settings.settleSessionEnd()
    })
    yield* finish.pipe(
      Effect.timeout(yield* settings.sessionEndTimeout?.() ?? Effect.succeed(1500)),
      Effect.ensuring(
        Effect.gen(function* () {
          if (settings.clearSession) yield* settings.clearSession(id)
          const watch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
          if (watch) yield* watch.clear(id)
          const config = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
          if (config) yield* config.clear(id)
          const { Permission } = yield* Effect.promise(() => import("@/permission"))
          const permission = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
          if (permission) yield* permission.clearHookPolicy(id)
          yield* HookTranscript.clearEnvironment(id).pipe(Effect.ignore)
          yield* HookTranscript.clearScratchpad(id).pipe(Effect.ignore)
        }),
      ),
    )
  }).pipe(Effect.provideService(InstanceRef, instance))
})

export * as HookClientLifecycle from "./client-lifecycle"
