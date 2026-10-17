import type { TriggerContext } from "./settings"
import { Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { HookTranscript, type Message } from "./transcript"
import { promptIdentity, variantToEffort } from "./prompt-identity"

/** Actual persisted history and SessionStart environment for consumers without the prompt wrapper. */
export const consumerContext = Effect.fn("Hook.consumerContext")(function* (
  sessionID: string,
  permissionMode?: string,
  currentAgent?: string,
): Effect.fn.Return<TriggerContext, unknown> {
  const directory = (yield* InstanceRef)?.directory ?? process.cwd()
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  let messages: Message[] = []
  if (database) {
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    let before: string | undefined
    while (true) {
      const page = yield* MessageV2.page({ sessionID: SessionID.make(sessionID), limit: 100, before }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catchTag("NotFoundError", () => Effect.succeed({ items: [], more: false, cursor: undefined })),
        Effect.orDie,
      )
      messages.unshift(...page.items)
      if (!page.more || !page.cursor) break
      before = page.cursor
    }
  }
  messages = [...(yield* HookTranscript.history(sessionID, messages))]
  if (permissionMode === undefined) {
    const { Permission } = yield* Effect.promise(() => import("@/permission"))
    const permissions = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    permissionMode = permissions ? (yield* permissions.hookPolicy(sessionID)).mode : undefined
  }
  const { SessionStore } = yield* Effect.promise(() => import("@opencode-ai/core/session/store"))
  const store = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
  let nativeSession: { parentID?: string; agent?: string; model?: { variant?: string } } | undefined = store
    ? yield* store.get(SessionID.make(sessionID))
    : undefined
  if (!nativeSession) {
    // AppLayer hides the core store behind SessionV2; the V1 session service
    // reads the same row, including model.variant.
    const { Session } = yield* Effect.promise(() => import("@/session/session"))
    const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
    nativeSession = sessions
      ? yield* sessions
          .get(SessionID.make(sessionID))
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      : undefined
  }
  const agent = currentAgent ?? nativeSession?.agent ?? messages.findLast((message) => message.info.agent)?.info.agent
  if (agent === "plan" && permissionMode === undefined) permissionMode = "plan"
  const identity = promptIdentity(messages)
  // V2 durable user rows carry no model metadata, so the transcript identity
  // cannot name the effort even though the session row holds the variant.
  const effort = identity.effort ?? variantToEffort(nativeSession?.model?.variant)
  return {
    sessionID,
    // A child session is the subagent owning these events; CC names it in agent_id.
    ...(nativeSession?.parentID ? { agentID: sessionID } : {}),
    agentType: agent,
    ...identity,
    ...(effort ? { effort } : {}),
    transcriptPath: yield* HookTranscript.materialize({ sessionID, directory, messages }),
    environment: yield* HookTranscript.environment(sessionID),
    permissionMode: permissionMode === "manual" ? "default" : (permissionMode ?? "default"),
  }
})
