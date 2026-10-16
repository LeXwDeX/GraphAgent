export * as SessionConversationHooks from "./conversation-hooks"

import { Context, Effect, Schema } from "effect"
import type { PermissionHookScope } from "../permission/hook-scope"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"

/** Optional leaf port for host hook admission into the durable V2 conversation. */
export interface Interface {
  readonly admit: (input: {
    sessionID: SessionSchema.ID
    prompt: Prompt
  }) => Effect.Effect<void | { additionalContext?: string }, Blocked>
  readonly beforeTool: (input: {
    sessionID: SessionSchema.ID
    toolName: string
    toolCallID: string
    toolInput: Record<string, unknown>
    isSingle?: (toolCallID: string, signal?: AbortSignal) => Promise<boolean>
  }) => Effect.Effect<
    {
      toolInput: Record<string, unknown>
      blocked?: string
      stopped?: string
      feedback?: string
      deferred?: boolean
      permissionDecision?: "allow" | "ask"
      permissionHooks?: PermissionHookScope.Hooks
    },
    Blocked
  >
  readonly afterTool: (input: {
    sessionID: SessionSchema.ID
    toolName: string
    toolCallID: string
    toolInput: Record<string, unknown>
    output?: unknown
    error?: string
  }) => Effect.Effect<{ replacement?: unknown; hasReplacement?: boolean; feedback?: string; stopped?: string }, Blocked>
}

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("SessionConversationHookBlocked", {
  reason: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionConversationHooks") {}
