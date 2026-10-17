import type { TriggerContext } from "./settings"
import { Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { HookTranscript, type Message } from "./transcript"
import { promptIdentity } from "./prompt-identity"

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
  const nativeSession = store ? yield* store.get(SessionID.make(sessionID)) : undefined
  const agent = currentAgent ?? nativeSession?.agent ?? messages.findLast((message) => message.info.agent)?.info.agent
  if (agent === "plan" && permissionMode === undefined) permissionMode = "plan"
  return {
    sessionID,
    agentType: agent,
    ...promptIdentity(messages),
    transcriptPath: yield* HookTranscript.materialize({ sessionID, directory, messages }),
    environment: yield* HookTranscript.environment(sessionID),
    permissionMode: permissionMode === "manual" ? "default" : (permissionMode ?? "default"),
  }
})
