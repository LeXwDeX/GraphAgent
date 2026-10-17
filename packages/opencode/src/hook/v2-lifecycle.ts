export * as HookV2Lifecycle from "./v2-lifecycle"

import { Effect, Layer, Option } from "effect"
import { SessionLifecycleHooks } from "@opencode-ai/core/session/lifecycle-hooks"
import { Location } from "@opencode-ai/core/location"
import { SkillV2 } from "@opencode-ai/core/skill"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceRef } from "@/effect/instance-ref"
import { HookLifecycle } from "./lifecycle"
import { HookStartContext } from "./start-context"
import { HookFileWatch } from "./file-watch"
import { HookConfigChange } from "./config-change"
import { HookTranscript } from "./transcript"
import { HookSessionContext } from "./session-context"
import { HookModelMetrics } from "./model-metrics"
import { SettingsHook } from "./settings"
import { Skill } from "@/skill"

export const layer = Layer.effect(
  SessionLifecycleHooks.Service,
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const lifecycle = yield* HookLifecycle.Service
    const starts = yield* HookStartContext.Service
    const watcher = yield* HookFileWatch.Service
    const config = yield* HookConfigChange.Service
    const skills = yield* Skill.Service
    const withSession = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const current = yield* sessions.get(SessionID.make(id)).pipe(Effect.orDie)
        return yield* instances.provide(
          { directory: current.directory },
          effect.pipe(
            Effect.provideService(WorkspaceRef, current.workspaceID),
            Effect.provideService(HookLifecycle.Service, lifecycle),
            Effect.provideService(HookStartContext.Service, starts),
            Effect.provideService(HookFileWatch.Service, watcher),
            Effect.provideService(HookConfigChange.Service, config),
          ),
        )
      })
    return SessionLifecycleHooks.Service.of({
      setMetadata: (input) =>
        withSession(
          input.sessionID,
          sessions.setMetadata({ sessionID: SessionID.make(input.sessionID), metadata: input.metadata }),
        ),
      start: (input) =>
        withSession(
          input.sessionID,
          Effect.gen(function* () {
            const sessionID = SessionID.make(input.sessionID)
            const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
            if (current.parentID) return {}
            if (input.source === "resume" && !(yield* starts.claimResume(sessionID))) return {}
            if (input.source === "resume") yield* prompt.restoreModelContext(sessionID)
            if (input.source === "startup") yield* starts.markStarted(sessionID)
            const history = yield* HookTranscript.history(
              sessionID,
              yield* sessions.messages({ sessionID }).pipe(Effect.orDie),
            )
            const transcriptPath = yield* HookTranscript.materialize({
              sessionID,
              directory: current.directory,
              messages: history,
            }).pipe(Effect.orDie)
            const result = yield* settings.trigger(
              {
                event: "SessionStart",
                source: input.source,
                ...(yield* HookModelMetrics.forSession({
                  source: input.source,
                  sessionID,
                  title: current.title,
                  titleSource: current.metadata?.hookTitleSource,
                  model: current.model,
                  agent: current.agent,
                  history,
                })),
              },
              {
                sessionID,
                transcriptPath,
                environmentFile: yield* HookTranscript.environmentFile(sessionID).pipe(Effect.orDie),
                environment: yield* HookTranscript.environment(sessionID).pipe(Effect.orDie),
              },
            )
            yield* SettingsHook.landSystemMessages(result, { sessionID })
            const reloadSkills = Effect.gen(function* () {
              yield* skills.reload()
              const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
              const coreSkills = Option.getOrUndefined(yield* Effect.serviceOption(SkillV2.Service))
              if (!location || !coreSkills)
                return yield* Effect.die(
                  new Error("SessionStart reloadSkills requires the actual V2 location services"),
                )
              yield* coreSkills.reload()
              return undefined
            })
            yield* HookSessionContext.applyStart({
              session: current,
              sessions,
              settings,
              result: { ...result, initialUserMessage: undefined },
              reloadSkills,
            })
            return {
              additionalContext: result.additionalContexts.filter(Boolean).join("\n\n") || undefined,
              initialUserMessage: result.initialUserMessage,
            }
          }),
        ),
      blocked: (input) =>
        withSession(
          input.sessionID,
          SettingsHook.landSystemMessages(
            { additionalContexts: [], systemMessages: [input.reason] },
            { sessionID: input.sessionID },
          ),
        ),
    })
  }),
)
