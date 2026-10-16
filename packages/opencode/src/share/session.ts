import { LocalPermissionStartup } from "@/permission/local-startup"
import { HookModelMetrics } from "@/hook/model-metrics"
import { HookFileWatch } from "@/hook/file-watch"
import { HookConfigChange } from "@/hook/config-change"
import { HookSessionContext } from "@/hook/session-context"
import { Skill } from "@/skill"
import { HookTranscript } from "@/hook/transcript"
import { HookLifecycle } from "@/hook/lifecycle"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Scope, Context } from "effect"
import * as Option from "effect/Option"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ShareNext } from "./share-next"
import { SettingsHook } from "@/hook/settings"
import { HookStartContext } from "@/hook/start-context"
import * as Log from "@/util/log"

const log = Log.create({ service: "share.session" })

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const startCtx = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const fileWatch = Option.getOrUndefined(yield* Effect.serviceOption(HookFileWatch.Service))
    const configChange = Option.getOrUndefined(yield* Effect.serviceOption(HookConfigChange.Service))
    const skills = yield* Skill.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const result = yield* session.create(input)
      if (result.parentID) return result
      const startupGrant = yield* LocalPermissionStartup.Grant
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
        const transcriptPath = yield* HookTranscript.materialize({
          sessionID: result.id,
          directory: result.directory,
          messages: [],
        }).pipe(Effect.orDie)
        const exit = yield* settingsHook
          .trigger(
            {
              event: "SessionStart",
              source: "startup",
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
            {
              sessionID: result.id,
              transcriptPath,
              environmentFile: yield* HookTranscript.environmentFile(result.id).pipe(Effect.orDie),
            },
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
      const conf = yield* cfg.get()
      if (!(flags.autoShare || conf.share === "auto")) return result
      yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
  Layer.provide(HookLifecycle.defaultLayer),
  Layer.provide(HookFileWatch.defaultLayer),
  Layer.provide(HookConfigChange.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Session.node,
  ShareNext.node,
  Skill.node,
  RuntimeFlags.node,
  HookStartContext.node,
  HookLifecycle.node,
  HookFileWatch.node,
  HookConfigChange.node,
  SettingsHook.node,
])

export * as SessionShare from "./session"
