// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Fiber, Option } from "effect"
import type { Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SettingsHook, type HookPayload, type TriggerResult } from "@/hook"
import { SessionCancellation } from "./cancellation"
import type { SessionRuntimes } from "./runtime"
import type { SessionID } from "./schema"

export interface ModelSwitchDeps {
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly runtimes: SessionRuntimes
  readonly scope: Scope.Scope
}

/**
 * Pre/PostModelSwitch hook plumbing of the prompt service (Issue #1019, PR-b).
 * Moved verbatim out of `prompt.ts`: `queueModelSwitch` starts the hook fiber
 * for a switch, and `modelSwitchContext` lands its context for the request
 * that targets the new model.
 */
export function makeModelSwitch(deps: ModelSwitchDeps) {
  const { settingsHook, runtimes, scope } = deps

  const modelSwitches = runtimes.modelSwitches
  const queueModelSwitch = Effect.fn("SessionPrompt.queueModelSwitch")(function* (
    sessionID: SessionID,
    payload: Extract<HookPayload, { event: "PreModelSwitch" | "PostModelSwitch" }>,
  ) {
    if (!settingsHook) return
    const request = SessionCancellation.request(sessionID)
    yield* Effect.gen(function* () {
      const pending = modelSwitches
      const context = yield* Effect.context()
      const generation = yield* InstanceState.currentGeneration
      const directory = yield* InstanceState.directory
      runtimes.own(sessionID, directory)
      const previous = pending.get(sessionID)
      if (previous) {
        pending.delete(sessionID)
        previous.unregister()
        yield* Fiber.interrupt(previous.fiber)
      }
      if (!request.current()) return
      const fiber = yield* Effect.suspend(() =>
        request.current()
          ? settingsHook.trigger({ ...payload, event: "PostModelSwitch" }, { sessionID })
          : Effect.interrupt,
      ).pipe(
        Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })),
        Effect.forkIn(scope),
      )
      const entry = { target: payload.toModel, epoch: request.epoch, fiber, unregister: () => {} }
      const unregister = request.register(
        () =>
          InstanceState.withGeneration(
            generation,
            Effect.suspend(() => {
              if (pending.get(sessionID) === entry) pending.delete(sessionID)
              entry.unregister()
              return Fiber.interrupt(fiber).pipe(Effect.asVoid)
            }),
          ).pipe(Effect.provide(context)),
        directory,
      )
      if (!unregister) {
        yield* Fiber.interrupt(fiber)
        return
      }
      entry.unregister = unregister
      const prior = pending.get(sessionID)
      pending.set(sessionID, entry)
      if (prior) {
        prior.unregister()
        yield* Fiber.interrupt(prior.fiber)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => request.release())))
  })
  const modelSwitchContext = Effect.fn("SessionPrompt.modelSwitchContext")(function* (
    sessionID: SessionID,
    apiModelID: string,
  ) {
    const pending = modelSwitches
    const entry = pending.get(sessionID)
    if (!entry || entry.target !== apiModelID) return [] as string[]
    const result = yield* Fiber.join(entry.fiber).pipe(Effect.timeoutOption("5 seconds"))
    if (Option.isNone(result) || pending.get(sessionID) !== entry) return [] as string[]
    const current = SessionCancellation.epoch(sessionID) === entry.epoch
    pending.delete(sessionID)
    entry.unregister()
    if (!current) return [] as string[]
    yield* SettingsHook.landSystemMessages(result.value, {
      sessionID,
      shouldLand: () => SessionCancellation.epoch(sessionID) === entry.epoch,
    })
    return SessionCancellation.epoch(sessionID) === entry.epoch ? result.value.additionalContexts : []
  })

  return { queueModelSwitch, modelSwitchContext }
}
