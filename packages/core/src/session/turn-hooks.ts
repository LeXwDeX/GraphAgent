export * as SessionTurnHooks from "./turn-hooks"

import { Context, Effect } from "effect"
import { SessionSchema } from "./schema"

/** Optional host hooks at durable V2 provider-turn boundaries. */
export interface Interface {
  readonly environment?: (sessionID: SessionSchema.ID) => Effect.Effect<Record<string, string | undefined>>
  /** Host waits for the attention delay; core cancels when the permission settles. */
  readonly permissionPending?: (sessionID: SessionSchema.ID, action: string) => Effect.Effect<void>
  /** Actual run ownership, separate from Stop continuation decisions. */
  readonly state?: (sessionID: SessionSchema.ID, status: "busy" | "idle" | "cancelled") => Effect.Effect<void>
  /** Invalidate pending asynchronous Stop feedback when the user cancels. */
  readonly invalidateRewake?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Drain asynchronous hook feedback and model-switch context for the next provider request. */
  readonly beforeRequest?: (input: {
    sessionID: SessionSchema.ID
    model: { providerID: string; apiModelID: string }
  }) => Effect.Effect<{ additionalContext?: string }>
  readonly displayMode: (
    sessionID: SessionSchema.ID,
    requestedMode: "interactive" | "noninteractive",
  ) => Effect.Effect<{
    enabled: boolean
    mode: "interactive" | "noninteractive"
  }>
  readonly display: (input: {
    sessionID: SessionSchema.ID
    turnID: string
    messageID: string
    index: number
    final: boolean
    delta: string
  }) => Effect.Effect<string>
  readonly postToolBatch: (input: {
    sessionID: SessionSchema.ID
    toolCalls: ReadonlyArray<{
      toolName: string
      toolUseID: string
      toolInput: Record<string, unknown>
      toolResponse: unknown
    }>
  }) => Effect.Effect<{ additionalContext?: string; stop?: string }>
  readonly stop: (input: {
    sessionID: SessionSchema.ID
    stopHookActive: boolean
    lastAssistantMessage?: string
  }) => Effect.Effect<{ continueWith?: string }>
  readonly stopFailure: (input: {
    sessionID: SessionSchema.ID
    /** The host classifies this value; it is never serialized to a hook. */
    error: unknown
    /** Only the error text already published to the session is sent to a hook. */
    displayedError?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTurnHooks") {}
