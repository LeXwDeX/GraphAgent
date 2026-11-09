// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily resolved per-trigger execution context (D1 PR2).
 *
 * A trigger constructor only names the session (and the directory comes from
 * the instance state). Everything expensive — materializing the JSONL
 * transcript, sourcing the hook environment, creating the scratchpad, deriving
 * prompt identity and the permission mode — is a memoized effect evaluated only
 * when the engine has decided that at least one handler will run. Each provider
 * is evaluated at most once per trigger, and a trigger that matches no runnable
 * hook evaluates none of them.
 *
 * D1 PR3 removed the eager full-history load: the transcript materializes
 * incrementally from the database, and prompt identity reads only the newest
 * user messages.
 */
import { Effect, Option } from "effect"
import { Database } from "@graphagent/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { HookTranscript } from "../transcript"
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
 * Identity of the newest user prompt without loading the whole session. A
 * bounded window of the newest user messages is enough: only compaction
 * carriers are skipped, and they never occur 32 deep without a real prompt in
 * between. Without a database (unit layers that only mount the hook engine) no
 * prompt identity is derived.
 */
const loadPromptIdentity = (sessionID: string) =>
  Effect.gen(function* () {
    if (!sessionID) return {} as PromptIdentity
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!database) return {} as PromptIdentity
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    const recent = yield* MessageV2.recentUsers({ sessionID: SessionID.make(sessionID), limit: 32 }).pipe(
      Effect.provideService(Database.Service, database),
      Effect.orDie,
    )
    return promptIdentity(recent)
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
  const identity: Effect.Effect<PromptIdentity> = yield* Effect.cached(loadPromptIdentity(sessionID).pipe(Effect.orDie))
  const transcript: Effect.Effect<string> = yield* Effect.cached(
    HookTranscript.materialize({
      sessionID,
      directory: (yield* InstanceRef)?.directory ?? directory,
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
