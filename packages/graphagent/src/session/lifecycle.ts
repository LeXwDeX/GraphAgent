// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { HookModelMetrics } from "@/hook/model-metrics"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookSessionContext } from "@/hook/session-context"
import { Skill } from "@/skill"
import { HookLifecycle } from "@/hook/lifecycle"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Session } from "@/session/session"
import { Effect, Layer, Context } from "effect"
import * as Option from "effect/Option"
import { SettingsHook } from "@/hook"
import { HookStartContext } from "@/hook/start-context"
import * as Log from "@/util/log"

const log = Log.create({ service: "session.lifecycle" })

export interface CreateOptions {
  /**
   * One-shot local startup grant. Only in-process callers that marked the
   * original HTTP request may pass it; it never crosses the request schema.
   */
  readonly localGrant?: (sessionID: string) => Effect.Effect<void>
}

export interface Interface {
  readonly create: (input?: Session.CreateInput, options?: CreateOptions) => Effect.Effect<Session.Info>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionLifecycle") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const startCtx = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const fileWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    const configChange = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const skills = yield* Skill.Service

    const create = Effect.fn("SessionLifecycle.create")(function* (
      input?: Session.CreateInput,
      options?: CreateOptions,
    ) {
      const result = yield* session.create(input)
      if (result.parentID) return result
      const startupGrant = options?.localGrant
      if (startupGrant) yield* startupGrant(result.id)
      if (lifecycle) yield* lifecycle.attach(result.id)
      // Startup is handled here, so the first prompt admission must not fire `resume`.
      if (startCtx) yield* startCtx.markStarted(result.id)
      // Fire SessionStart hook for top-level sessions only.
      // SettingsHook.Service is guaranteed available because SettingsHook.node
      // is now listed in this layer's dependencies; the previous diagnostic
      // else-branch (log.warn about missing service) is removed as dead code.
      if (settingsHook) {
        log.info("SessionStart hook: firing trigger", { sessionID: result.id })
        const exit = yield* settingsHook
          .trigger(
            {
              event: "SessionStart",
              source: "startup",
              // Top-level only (parentID returned above): report the DAG mode read-only.
              ...(result.dagMode !== undefined ? { dagMode: result.dagMode } : {}),
              ...(yield* HookModelMetrics.forSession({
                source: "startup",
                sessionID: result.id,
                title: result.title,
                titleSource: result.metadata?.hookTitleSource,
                model: result.model,
                agent: result.agent,
                history: [],
              })),
            },
            { sessionID: result.id },
          )
          .pipe(Effect.exit)
        if (exit._tag === "Success") {
          yield* SettingsHook.landSystemMessages(exit.value, { sessionID: result.id })
          let apply = HookSessionContext.applyStart({
            session: result,
            sessions: session,
            settings: settingsHook,
            result: exit.value,
            startContext: startCtx,
            reloadSkills: skills.reload(),
          })
          if (lifecycle) apply = apply.pipe(Effect.provideService(HookLifecycle.Service, lifecycle))
          if (fileWatch) apply = apply.pipe(Effect.provideService(HookFileWatch.Service, fileWatch))
          if (configChange) apply = apply.pipe(Effect.provideService(HookConfigChange.Service, configChange))
          yield* apply
        }
      }
      return result
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
  Layer.provide(HookLifecycle.defaultLayer),
  Layer.provide(HookFileWatch.defaultLayer),
  Layer.provide(HookConfigChange.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Session.node,
  Skill.node,
  HookStartContext.node,
  HookLifecycle.node,
  HookFileWatch.node,
  HookConfigChange.node,
  SettingsHook.node,
])

export * as SessionLifecycle from "./lifecycle"
