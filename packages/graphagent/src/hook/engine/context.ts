/**
 * Lazily resolved per-trigger execution context (D1 PR2).
 *
 * A trigger constructor only names the session (and the directory comes from
 * the instance state). Everything expensive — loading persisted messages,
 * materializing the JSONL transcript, sourcing the hook environment, creating
 * the scratchpad, deriving prompt identity and the permission mode — is a
 * memoized effect evaluated only when the engine has decided that at least one
 * handler will run. Each provider is evaluated at most once per trigger, and a
 * trigger that matches no runnable hook evaluates none of them.
 */
import { Effect, Option } from "effect"
import { Database } from "@graphagent/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { HookTranscript, type Message } from "../transcript"
import { promptIdentity, type PromptIdentity } from "../prompt-identity"
import { agentToPermissionMode } from "../match"
import type { HookPayload, TriggerContext } from "../types"

export interface RunContext {
  /** Absolute path to this session's JSONL transcript. */
  readonly transcript: () => Effect.Effect<string>
  /** Environment delta exported by the hook environment files (sessionless triggers have none). */
  readonly environment: () => Effect.Effect<Record<string, string | undefined> | undefined>
  /** The file `CLAUDE_ENV_FILE` names for this trigger (sessionless triggers have none). */
  readonly environmentFile: () => Effect.Effect<string | undefined>
  /** Per-session scratch directory, or undefined when it cannot be created. */
  readonly scratchpad: () => Effect.Effect<string | undefined>
  /** CC `prompt_id` / `effort`, derived from the newest persisted user prompt. */
  readonly promptIdentity: () => Effect.Effect<PromptIdentity>
  /** CC `permission_mode` for this trigger. */
  readonly permissionMode: () => Effect.Effect<string | undefined>
  /** SubagentStop only: the stopped child's transcript (`agent_transcript_path`). */
  readonly agentTranscript: () => Effect.Effect<string | undefined>
}

/**
 * Persisted history in ascending order. Mirrors `hook/consumer-context.ts`:
 * paging keeps memory bounded and returns an empty history when no database is
 * in scope (unit layers that only mount the hook engine).
 */
const loadMessages = (sessionID: string) =>
  Effect.gen(function* () {
    if (!sessionID) return [] as readonly Message[]
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!database) return [] as readonly Message[]
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    const messages: Message[] = []
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
    return [...(yield* HookTranscript.history(sessionID, messages))]
  })

/**
 * Construct the lazy context for one trigger. The returned functions are
 * memoized effects: evaluating one twice reuses the first result (including
 * concurrent callers), and evaluating none touches no session state.
 */
export const makeRunContext: (
  payload: HookPayload,
  ctx: TriggerContext,
  directory: string,
) => Effect.Effect<RunContext> = Effect.fn("HookRunContext.make")(function* (
  payload: HookPayload,
  ctx: TriggerContext,
  directory: string,
) {
  const sessionID = ctx.sessionID
  const messages: Effect.Effect<readonly Message[]> = yield* Effect.cached(loadMessages(sessionID).pipe(Effect.orDie))
  const identity: Effect.Effect<PromptIdentity> = yield* Effect.cached(
    Effect.map(messages, (rows) => promptIdentity(rows)),
  )
  const transcript: Effect.Effect<string> = yield* Effect.cached(
    Effect.gen(function* () {
      const path = yield* HookTranscript.materialize({
        sessionID,
        directory: (yield* InstanceRef)?.directory ?? directory,
        messages: yield* messages,
      })
      return path
    }).pipe(Effect.orDie),
  )
  const environmentFileSource: Effect.Effect<string | undefined, unknown> =
    ctx.environmentFile !== undefined
      ? Effect.succeed(ctx.environmentFile)
      : sessionID
        ? HookTranscript.environmentFile(sessionID, undefined, ctx.environmentLifetime ?? "session")
        : Effect.succeed(undefined)
  const environmentFile: Effect.Effect<string | undefined> = yield* Effect.cached(
    environmentFileSource.pipe(Effect.orDie),
  )
  const environmentSource: Effect.Effect<Record<string, string | undefined> | undefined, unknown> =
    ctx.environment !== undefined
      ? Effect.succeed(ctx.environment)
      : sessionID
        ? HookTranscript.environment(sessionID)
        : Effect.succeed(undefined)
  const environment: Effect.Effect<Record<string, string | undefined> | undefined> = yield* Effect.cached(
    environmentSource.pipe(Effect.orDie),
  )
  const scratchpad: Effect.Effect<string | undefined> = yield* Effect.cached(
    (ctx.scratchpadDir !== undefined
      ? Effect.succeed<string | undefined>(ctx.scratchpadDir)
      : sessionID
        ? HookTranscript.scratchpadDir(sessionID)
        : Effect.succeed<string | undefined>(undefined)
    ).pipe(Effect.orDie),
  )
  const permissionMode: Effect.Effect<string | undefined> = yield* Effect.cached(
    Effect.gen(function* () {
      if (ctx.permissionMode !== undefined) return ctx.permissionMode
      if (!sessionID) return undefined
      const { Permission } = yield* Effect.promise(() => import("@/permission"))
      const permissions = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
      const mode = permissions ? (yield* permissions.hookPolicy(sessionID)).mode : undefined
      if (mode === "manual") return "default"
      // CC always names a mode for session events. An unknown/fork-specific
      // agent name maps to "default"; the plan agent maps to "plan".
      return mode ?? agentToPermissionMode(ctx.agentType)
    }),
  )
  const stoppedAgentID = payload.event === "SubagentStop" ? payload.agentID : undefined
  const knownAgentTranscript =
    payload.event === "SubagentStop" && payload.agentTranscriptPath !== undefined
      ? payload.agentTranscriptPath
      : undefined
  const agentTranscript: Effect.Effect<string | undefined> = yield* Effect.cached(
    Effect.gen(function* () {
      if (!stoppedAgentID) return undefined
      if (knownAgentTranscript !== undefined) return knownAgentTranscript
      const path = yield* HookTranscript.materialize({
        sessionID: stoppedAgentID,
        directory: (yield* InstanceRef)?.directory ?? directory,
        messages: yield* loadMessages(stoppedAgentID).pipe(Effect.orDie),
      })
      return path
    }).pipe(Effect.orDie),
  )
  const runContext: RunContext = {
    transcript: () => transcript,
    environment: () => environment,
    environmentFile: () => environmentFile,
    scratchpad: () => scratchpad,
    promptIdentity: () => identity,
    permissionMode: () => permissionMode,
    agentTranscript: () => agentTranscript,
  }
  return runContext
})
