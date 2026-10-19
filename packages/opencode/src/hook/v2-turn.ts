import { HookTranscript } from "./transcript"
import { SessionAttention } from "@/notification/attention"
import { Notification } from "@/notification"
import { consumerContext } from "./consumer-context"
export * as HookV2Turn from "./v2-turn"

import { SessionTurnHooks } from "@opencode-ai/core/session/turn-hooks"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Location } from "@opencode-ai/core/location"
import { Effect, Layer, Option } from "effect"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SettingsHook, type HookPayload } from "./settings"
import { HookTurnContext } from "./turn-context"

/** Host adapter for V2 provider-turn events; the core runner keeps no opencode dependency. */
export const layer = Layer.effect(
  SessionTurnHooks.Service,
  Effect.gen(function* () {
    const { Permission } = yield* Effect.promise(() => import("@/permission"))
    const attention = yield* SessionAttention.Service
    const notifications = yield* Notification.Service
    const permissions = yield* Permission.Service
    const { SessionStatus } = yield* Effect.promise(() => import("@/session/status"))
    const statuses = yield* SessionStatus.Service
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    const jobs = yield* BackgroundJob.Service
    const workflows = yield* DagStore.Service
    const withLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        if (!location) return yield* Effect.die(new Error("V2 hook location unavailable"))
        return yield* instances.provide({ directory: location.directory }, effect)
      })
    const trigger = (sessionID: SessionID, payload: HookPayload) =>
      withLocation(
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID)
          if (!session.directory) return undefined
          const result = yield* settings.trigger(
            payload,
            !settings.hasEvent || (yield* settings.hasEvent(payload.event, sessionID))
              ? yield* consumerContext(sessionID, (yield* permissions.hookPolicy(sessionID)).mode, session.agent)
              : { sessionID, transcriptPath: "" },
          )
          yield* SettingsHook.landSystemMessages(result, { sessionID })
          return result
        }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return SessionTurnHooks.Service.of({
      environment: (sessionID) => withLocation(HookTranscript.environment(sessionID)).pipe(Effect.orDie),
      permissionPending: (sessionID, action) =>
        withLocation(
          attention.quiet(SessionID.make(sessionID), 6000).pipe(
            Effect.andThen(
              notifications.notify({
                sessionID,
                notificationType: "permission_prompt",
                message: `Permission required: ${action}`,
              }),
            ),
          ),
        ).pipe(
          Effect.provideService(SettingsHook.Service, settings),
          Effect.provideService(Permission.Service, permissions),
        ),
      state: (sessionID, status) =>
        withLocation(
          status === "cancelled"
            ? (statuses.settle?.(SessionID.make(sessionID)) ?? Effect.void)
            : statuses.set(SessionID.make(sessionID), { type: status }),
        ).pipe(
          Effect.provideService(SettingsHook.Service, settings),
          Effect.provideService(Permission.Service, permissions),
        ),
      invalidateRewake: (sessionID) =>
        withLocation(settings.invalidateStopRewakeChain?.(SessionID.make(sessionID)) ?? Effect.void),
      beforeRequest: (input) =>
        withLocation(
          Effect.gen(function* () {
            const sessionID = SessionID.make(input.sessionID)
            const switched = yield* prompt.takeModelSwitchContext({ sessionID, apiModelID: input.model.apiModelID })
            const queued = settings.drainAsync ? yield* settings.drainAsync(sessionID) : undefined
            const additionalContext = [...switched, ...(queued?.additionalContexts ?? [])].filter(Boolean).join("\n\n")
            return additionalContext ? { additionalContext } : {}
          }),
        ),
      displayMode: (sessionID, requestedMode) =>
        Effect.gen(function* () {
          const enabled = settings.hasEvent
            ? yield* withLocation(settings.hasEvent("MessageDisplay", SessionID.make(sessionID)))
            : false
          return { enabled, mode: requestedMode }
        }),
      display: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          if (settings.hasEvent && !(yield* withLocation(settings.hasEvent("MessageDisplay", sessionID))))
            return input.delta
          const result = yield* trigger(sessionID, {
            event: "MessageDisplay",
            turnID: input.turnID,
            messageID: input.messageID,
            index: input.index,
            final: input.final,
            delta: input.delta,
          })
          return result?.displayContent ?? input.delta
        }),
      postToolBatch: (input) =>
        Effect.gen(function* () {
          if (input.toolCalls.length === 0) return {}
          const result = yield* trigger(SessionID.make(input.sessionID), {
            event: "PostToolBatch",
            toolCalls: input.toolCalls.map((call) => ({
              toolName: call.toolName,
              toolUseID: call.toolUseID,
              toolInput: call.toolInput,
              toolResponse: call.toolResponse,
            })),
          })
          const additionalContext = result?.additionalContexts.filter((value) => value.length > 0).join("\n\n")
          const stop =
            result && (result.blocked || result.preventContinuation)
              ? (result.stopReason ?? result.blocked?.reason ?? "Hook requested stop")
              : undefined
          if (stop !== undefined && !result?.systemMessages.includes(stop))
            yield* withLocation(
              SettingsHook.landSystemMessages(
                { additionalContexts: [], systemMessages: [stop] },
                { sessionID: input.sessionID },
              ),
            )
          return { ...(additionalContext ? { additionalContext } : {}), ...(stop !== undefined ? { stop } : {}) }
        }),
      stop: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          if (settings.hasEvent && !(yield* withLocation(settings.hasEvent("Stop", sessionID)))) return {}
          const backgroundTasks = yield* withLocation(HookTurnContext.backgroundTasks(sessionID, { jobs, workflows }))
          const result = yield* trigger(sessionID, {
            event: "Stop",
            stopHookActive: input.stopHookActive,
            lastAssistantMessage: input.lastAssistantMessage,
            backgroundTasks,
            sessionCrons: [],
          })
          if (!result || result.preventContinuation) {
            if (result?.stopReason)
              yield* SettingsHook.landSystemMessages(
                { additionalContexts: [], systemMessages: [result.stopReason] },
                { sessionID: input.sessionID },
              )
            return {}
          }
          if (!result.blocked) {
            if (result.additionalContexts.some((value) => value.length > 0))
              yield* Effect.logDebug("ignoring non-blocking Stop context")
            return {}
          }
          const feedback = [
            ...result.additionalContexts.filter((value) => value.length > 0),
            ...(result.blocked ? [result.blocked.reason || "Continue."] : []),
          ]
          return feedback.length > 0 ? { continueWith: feedback.join("\n\n") } : {}
        }),
      stopFailure: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          if (settings.hasEvent && !(yield* withLocation(settings.hasEvent("StopFailure", sessionID)))) return
          const classified = HookTurnContext.failure(input.error, input.displayedError)
          yield* trigger(SessionID.make(input.sessionID), {
            event: "StopFailure",
            stopHookActive: false,
            ...classified,
          })
        }),
    })
  }),
)
