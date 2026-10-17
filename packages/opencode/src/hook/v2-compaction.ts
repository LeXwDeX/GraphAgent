export * as HookV2Compaction from "./v2-compaction"

import { SessionCompactionHooks } from "@opencode-ai/core/session/compaction-hooks"
import { Location } from "@opencode-ai/core/location"
import { Effect, Layer, Option } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { HookTranscript } from "./transcript"
import { SettingsHook, type HookPayload } from "./settings"

/** Host hook adapter for the V2 runner's actual auto-compaction boundary. */
export const layer = Layer.effect(
  SessionCompactionHooks.Service,
  Effect.gen(function* () {
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const trigger = (sessionID: SessionID, payload: HookPayload) =>
      Effect.gen(function* () {
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        if (!location) return undefined
        return yield* instances.provide(
          { directory: location.directory },
          Effect.gen(function* () {
            const session = yield* sessions.get(sessionID)
            if (!session.directory) return undefined
            const transcriptPath = yield* HookTranscript.materialize({
              sessionID,
              directory: session.directory,
              messages: yield* sessions.messages({ sessionID }),
            })
            const result = yield* settings.trigger(payload, {
              sessionID,
              transcriptPath,
              environment: yield* HookTranscript.environment(sessionID),
            })
            yield* SettingsHook.landSystemMessages(result, { sessionID })
            return result
          }),
        )
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return SessionCompactionHooks.Service.of({
      before: (sessionID) =>
        Effect.map(
          trigger(SessionID.make(sessionID), { event: "PreCompact", trigger: "auto", customInstructions: null }),
          (result) => ({ blocked: result?.blocked !== undefined }),
        ),
      after: ({ sessionID, summary }) =>
        Effect.gen(function* () {
          yield* trigger(SessionID.make(sessionID), {
            event: "PostCompact",
            trigger: "auto",
            compactSummary: summary,
          })
          return {}
        }),
    })
  }),
)
