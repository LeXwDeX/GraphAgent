export * as HookModelSwitch from "./model-switch"

import { Effect, Layer } from "effect"
import { SessionModelSwitchHook } from "@opencode-ai/core/session/model-switch"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"

/** A V2 model switch enters the same admission path as the v1 UI and SDK. */
export const layer = Layer.effect(
  SessionModelSwitchHook.Service,
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    return SessionModelSwitchHook.Service.of({
      switchModel: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          const session = yield* sessions
            .get(sessionID)
            .pipe(
              Effect.mapError(
                () => new SessionModelSwitchHook.Blocked({ reason: "Session model switch context is unavailable" }),
              ),
            )
          if (!session.directory)
            return yield* new SessionModelSwitchHook.Blocked({
              reason: "Session model switch directory is unavailable",
            })
          yield* instances
            .provide(
              { directory: session.directory },
              prompt.setModel({
                sessionID,
                model: {
                  providerID: ProviderV2.ID.make(input.model.providerID),
                  modelID: ModelV2.ID.make(input.model.id),
                },
                variant: input.model.variant === "default" ? undefined : input.model.variant,
                source: "sdk",
                hookMode: "noninteractive",
              }),
            )
            .pipe(Effect.mapError((error) => new SessionModelSwitchHook.Blocked({ reason: error.message })))
          return undefined
        }),
    })
  }),
)
