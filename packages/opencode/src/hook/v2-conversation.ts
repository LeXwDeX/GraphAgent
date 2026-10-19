import { SessionAttention } from "@/notification/attention"
import { consumerContext } from "./consumer-context"
export * as HookV2Conversation from "./v2-conversation"

import { SourceProvenance } from "@opencode-ai/core/session/source-provenance"
import { SessionSourceHooks } from "@opencode-ai/core/session/source-hooks"
import { Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Location } from "@opencode-ai/core/location"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { SettingsHook, type HookPayload } from "./settings"
import { Permission } from "@/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config as CoreConfig } from "@opencode-ai/core/config"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionHookScope } from "@opencode-ai/core/permission/hook-scope"
import { isDeepStrictEqual } from "node:util"
import { postHookFeedback } from "./trigger-result"
import { withoutUnusableDefer } from "./pre-hook-decision"

/** Reuse the v1 hook executor at the durable V2 prompt-admission boundary. */
const conversationLayer = Layer.effect(
  SessionConversationHooks.Service,
  Effect.gen(function* () {
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const permissions = yield* Permission.Service
    const attention = yield* SessionAttention.Service
    const directoryFor = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        if (location) return location.directory
        const store = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
        const session = store ? yield* store.get(sessionID) : undefined
        if (session) return session.location.directory
        return yield* new SessionConversationHooks.Blocked({ reason: "Session hook location is unavailable" })
      })
    const runHook = (sessionID: SessionID, payload: HookPayload, land = true, promptID?: string) =>
      Effect.gen(function* () {
        const directory = yield* directoryFor(sessionID)
        return yield* instances.provide(
          { directory },
          Effect.gen(function* () {
            if (payload.event === "UserPromptSubmit") yield* attention.input(sessionID)
            const active = !settings.hasEvent || (yield* settings.hasEvent(payload.event, sessionID))
            const result = yield* settings.trigger(
              payload,
              active
                ? yield* consumerContext(
                    sessionID,
                    (yield* permissions.hookPolicy(sessionID)).mode,
                    (yield* sessions.get(sessionID).pipe(Effect.orDie)).agent,
                    promptID,
                  ).pipe(Effect.orDie)
                : { sessionID, transcriptPath: "" },
            )
            if (land) yield* SettingsHook.landSystemMessages(result, { sessionID })
            return result
          }),
        )
      })
    return SessionConversationHooks.Service.of({
      admit: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
          // session_title is present only for a title the user or a hook chose,
          // never for a generated one (same rule as V1 prompt admission).
          const titled = current.metadata?.hookTitleSource === "custom" && current.title ? current.title : undefined
          const result = yield* runHook(
            sessionID,
            {
              event: "UserPromptSubmit",
              prompt: input.prompt.text,
              ...(titled !== undefined ? { sessionTitle: titled } : {}),
            },
            true,
            input.messageID,
          )
          if (result.sessionTitle !== undefined)
            yield* instances.provide(
              { directory: yield* directoryFor(sessionID) },
              sessions.setTitle({ sessionID, title: result.sessionTitle }),
            )
          if (result.blocked || result.preventContinuation)
            return yield* new SessionConversationHooks.Blocked({
              reason: result.stopReason ?? result.blocked?.reason ?? "Prompt blocked by hook",
            })
          return { additionalContext: result.additionalContexts.filter(Boolean).join("\n\n") || undefined }
        }),
      beforeTool: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(input.sessionID)
          const directory = yield* directoryFor(sessionID)
          const withSession = <A, E>(effect: Effect.Effect<A, E>) => instances.provide({ directory }, effect)
          let result = yield* runHook(
            sessionID,
            {
              event: "PreToolUse",
              toolName: input.toolName,
              toolUseID: input.toolCallID,
              toolInput: input.toolInput,
            },
            false,
          )
          if (result.preventContinuation) {
            yield* withSession(SettingsHook.landSystemMessages(result, { sessionID }))
            return { toolInput: input.toolInput, stopped: result.stopReason ?? "Tool stopped by hook" }
          }
          if (result.permissionDecision === "defer") {
            const single = input.isSingle
              ? yield* Effect.tryPromise({
                  try: (signal) => input.isSingle!(input.toolCallID, signal),
                  catch: () => new SessionConversationHooks.Blocked({ reason: "Tool batch did not complete" }),
                })
              : false
            if (single) return { toolInput: input.toolInput, deferred: true }
            result = withoutUnusableDefer(result)
          }
          yield* withSession(SettingsHook.landSystemMessages(result, { sessionID }))

          const blocked =
            result.blocked?.reason ??
            (result.permissionDecision === "deny"
              ? (result.permissionDecisionReason ?? "Tool denied by hook")
              : undefined)
          if (blocked)
            return {
              toolInput: input.toolInput,
              blocked: [blocked, ...result.additionalContexts.filter(Boolean)].join("\n\n"),
            }
          const failure = (error: { message?: string; feedback?: string }) =>
            new PermissionHookScope.Failure({ message: error.feedback ?? error.message ?? "Permission hook failed" })
          const permissionHooks: PermissionHookScope.Hooks = {
            policy: () =>
              withSession(
                Effect.gen(function* () {
                  const policy = yield* permissions.hookPolicy(sessionID)
                  return {
                    mode: policy.mode,
                    rules: [
                      ...policy.rules.map((rule) => ({
                        action: rule.permission,
                        resource: rule.pattern,
                        effect: rule.action,
                      })),
                      ...policy.directories.map((directory) => ({
                        action: "external_directory",
                        resource: directory + "/**",
                        effect: "allow" as const,
                      })),
                    ],
                  }
                }),
              ),
            request: (request) =>
              Effect.gen(function* () {
                const response = yield* runHook(sessionID, {
                  event: "PermissionRequest",
                  toolName: input.toolName,
                  toolUseID: input.toolCallID,
                  toolInput: request.toolInput,
                }).pipe(Effect.mapError((error) => failure({ message: error.reason })))
                if (response.preventContinuation)
                  return {
                    behavior: "deny" as const,
                    interrupt: true,
                    message: response.stopReason ?? "Stopped by permission hook",
                  }
                const decision = response.permissionRequestDecision
                if (decision?.behavior === "allow" && decision.updatedPermissions?.length) {
                  yield* withSession(permissions.applyHookUpdates(sessionID, decision.updatedPermissions)).pipe(
                    Effect.mapError(failure),
                  )
                  if (decision.updatedPermissions.some((update) => update.destination !== "session")) {
                    const config = Option.getOrUndefined(yield* Effect.serviceOption(CoreConfig.Service))
                    const agents = Option.getOrUndefined(yield* Effect.serviceOption(AgentV2.Service))
                    if (!config?.refresh || !agents)
                      return yield* failure({
                        message: "Permission changes were saved but the active policy cannot refresh",
                      })
                    yield* config
                      .refresh()
                      .pipe(
                        Effect.mapError(() =>
                          failure({ message: "Permission changes were saved but the active policy refresh failed" }),
                        ),
                      )
                    yield* agents.reload()
                  }
                }
                if (!decision) return {}
                return {
                  behavior: decision.behavior,
                  message: decision.message,
                  interrupt: decision.interrupt,
                  ...(decision.behavior === "allow" &&
                  decision.updatedInput !== undefined &&
                  !isDeepStrictEqual(decision.updatedInput, request.toolInput)
                    ? { updatedInput: decision.updatedInput }
                    : {}),
                }
              }),
            confirm: (toolInput) =>
              Effect.gen(function* () {
                const permission = Option.getOrUndefined(yield* Effect.serviceOption(PermissionV2.Service))
                if (!permission?.confirm) return yield* failure({ message: "Tool confirmation is unavailable" })
                yield* permission
                  .confirm({
                    sessionID: input.sessionID,
                    action: input.toolName,
                    resources: [input.toolName],
                    save: [],
                    metadata: { input: toolInput },
                  })
                  .pipe(Effect.mapError(failure))
                return undefined
              }),
          }
          // `answers` is hook-only: it never reaches the tool schema, and only an explicit
          // allow lets it stand in for the user. Anything else keeps the dialog.
          const updated = result.updatedInput
          let toolInput = updated ?? input.toolInput
          let hookInput: Record<string, unknown> | undefined
          if (input.toolName === "question" && updated && Object.hasOwn(updated, "answers")) {
            const { answers, ...rest } = updated
            toolInput = rest
            if (result.permissionDecision === "allow") hookInput = { answers }
          }
          return {
            toolInput,
            ...(hookInput ? { hookInput } : {}),
            permissionDecision:
              result.permissionDecision === "allow" || result.permissionDecision === "ask"
                ? result.permissionDecision
                : undefined,
            permissionHooks,
            ...(result.additionalContexts.length ? { feedback: result.additionalContexts.join("\n") } : {}),
          }
        }),
      afterTool: (input) =>
        Effect.gen(function* () {
          const result = yield* runHook(
            SessionID.make(input.sessionID),
            input.error === undefined
              ? {
                  event: "PostToolUse",
                  toolName: input.toolName,
                  toolUseID: input.toolCallID,
                  toolInput: input.toolInput,
                  toolResponse: input.output,
                  toolOutput: input.output,
                }
              : {
                  event: "PostToolUseFailure",
                  toolName: input.toolName,
                  toolUseID: input.toolCallID,
                  toolInput: input.toolInput,
                  error: input.error,
                  ...(input.isInterrupt ? { isInterrupt: true } : {}),
                },
          )
          const mcp = input.toolName.startsWith("mcp__") && Object.hasOwn(result, "updatedMCPToolOutput")
          const hasReplacement = input.error === undefined && (mcp || Object.hasOwn(result, "updatedToolOutput"))
          return {
            ...(hasReplacement
              ? { hasReplacement: true, replacement: mcp ? result.updatedMCPToolOutput : result.updatedToolOutput }
              : {}),
            ...(postHookFeedback(result) ? { feedback: postHookFeedback(result) } : {}),
            ...(result.preventContinuation ? { stopped: result.stopReason ?? "Hook requested stop" } : {}),
          }
        }),
    })
  }),
)

const sourceLayer = Layer.effect(
  SessionSourceHooks.Service,
  Effect.gen(function* () {
    const settings = yield* SettingsHook.Service
    const instances = yield* InstanceStore.Service
    const activeAgentState = yield* InstanceState.make(() => Effect.succeed(new Map<string, string>()))
    const withSession = (sessionID: string, effect: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        const store = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
        const directory =
          location?.directory ?? (store ? (yield* store.get(SessionID.make(sessionID)))?.location.directory : undefined)
        if (directory) yield* instances.provide({ directory }, effect)
      })
    return SessionSourceHooks.Service.of({
      syncAgent: (input) =>
        Effect.gen(function* () {
          const agents = Option.getOrUndefined(yield* Effect.serviceOption(AgentV2.Service))
          if (!agents) return
          const agent = yield* agents.get(input.agentID)
          const provenance = SourceProvenance.agent(agents, input.agentID)
          const origin = (provenance?.origin ?? "v2-agent") + ":agent:" + input.agentID
          yield* withSession(
            input.sessionID,
            Effect.gen(function* () {
              const activeAgents = yield* InstanceState.get(activeAgentState)
              const previous = activeAgents.get(input.sessionID)
              if (previous && (previous !== origin || !agent?.hooks))
                yield* settings.unregisterScoped?.(input.sessionID, previous) ?? Effect.void
              if (agent?.hooks) {
                yield* settings.registerScoped?.(input.sessionID, {
                  kind: "agent",
                  origin,
                  source: provenance?.source ?? "project",
                  hooks: agent.hooks,
                }) ?? Effect.void
                activeAgents.set(input.sessionID, origin)
              } else activeAgents.delete(input.sessionID)
            }),
          )
        }),
      skillLoaded: (input) =>
        withSession(
          input.sessionID,
          Effect.gen(function* () {
            if (!input.skill.hooks) return
            const provenance = SourceProvenance.skill(input.skill)
            yield* settings.registerScoped?.(input.sessionID, {
              kind: "skill",
              origin: provenance?.origin ?? input.skill.location,
              source: provenance?.source ?? "project",
              hooks: input.skill.hooks,
            }) ?? Effect.void
          }),
        ),
      instructionsLoaded: (input) =>
        withSession(
          input.sessionID,
          Effect.gen(function* () {
            const instance = yield* InstanceRef
            if (!instance) return
            const result = yield* settings.trigger(
              {
                event: "InstructionsLoaded",
                path: input.filePath,
                loadReason: input.loadReason,
                memoryType: input.memoryType,
                parentFilePath: input.parentFilePath,
              },
              !settings.hasEvent || (yield* settings.hasEvent("InstructionsLoaded", input.sessionID))
                ? yield* consumerContext(input.sessionID).pipe(Effect.orDie)
                : { sessionID: input.sessionID, transcriptPath: "" },
            )
            yield* SettingsHook.landSystemMessages(result, { sessionID: SessionID.make(input.sessionID) })
          }),
        ),
    })
  }),
)

export const layer = Layer.merge(conversationLayer, sourceLayer)
