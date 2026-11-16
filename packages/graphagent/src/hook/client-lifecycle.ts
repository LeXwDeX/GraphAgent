// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { HookLifecycle } from "./lifecycle"
import { HookTranscript } from "./transcript"
import { HookConfigChange } from "./config-change"
import { HookFileWatch } from "./file-watch"

export type Reason = "other" | "prompt_input_exit" | "resume" | "clear" | "logout"

export interface EndInput {
  readonly sessionID: string
  readonly directory: string
  readonly reason: Reason
}

/**
 * A local client detaches a specific session; directory disposal alone is not a session end.
 *
 * This ends the session's hooks and drops the state the hooks hold. The session's own state
 * (live status, client attention) is not touched here: `ClientDetach.local` clears it first.
 */
export const endLocalSession = Effect.fn("HookClientLifecycle.endLocalSession")(function* (input: EndInput) {
  const instance = yield* (yield* InstanceStore.Service).load({ directory: input.directory })
  return yield* Effect.gen(function* () {
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const { SettingsHook } = yield* Effect.promise(() => import("./index"))
    const settings = yield* SettingsHook.Service
    const id = SessionID.make(input.sessionID)
    const finish = Effect.gen(function* () {
      // The engine materializes the transcript only when a SessionEnd handler
      // actually matches, so a no-op event consumes no session state.
      if (lifecycle && !(yield* lifecycle.claimEnd(input.sessionID))) return
      const result = yield* settings.trigger({ event: "SessionEnd", reason: input.reason }, { sessionID: id })
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
          HookTranscript.clearCursor(id)
        }),
      ),
    )
  }).pipe(Effect.provideService(InstanceRef, instance))
})

export * as HookClientLifecycle from "./client-lifecycle"
