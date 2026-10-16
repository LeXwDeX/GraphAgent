/**
 * Cycle-free home for the `TriggerResult` type and the `landSystemMessages`
 * pure helper.
 *
 * `settings.ts` is a heavy module — its construction pulls in Provider →
 * Plugin → Session, which closes a load-order-sensitive cycle when imported
 * at the top of a Session-layer file (the resulting TDZ ReferenceError breaks
 * `test/goal` and `test/hook` independently). Consumers that only need the
 * result shape or the systemMessage landing helper MUST import from here
 * rather than from `settings.ts`; `settings.ts` re-exports both for backward
 * compatibility with existing import paths.
 *
 * This module depends on `effect` only — no provider/plugin/session edges —
 * so it is safe to import from anywhere.
 */
import { Effect } from "effect"

export interface TriggerResult {
  /** additionalContext strings appended (deduplicated per session; tool events only within the trigger) */
  additionalContexts: string[]
  /** systemMessage strings emitted by hooks */
  systemMessages: string[]
  /** Validated OSC/BEL terminal sequences for interactive clients to emit. */
  terminalSequences?: string[]
  /** Block decision — non-undefined means main flow must short-circuit */
  blocked?: { reason: string; command: string }
  /** continue=false from any hook */
  preventContinuation?: boolean
  /** stopReason aggregated from hooks that requested non-continuation */
  stopReason?: string
  /** Permission verdict (PreToolUse only meaningful) */
  permissionDecision?: "allow" | "deny" | "ask" | "defer"
  permissionDecisionReason?: string
  modelSwitchDecision?: "allow" | "deny" | "ask"
  modelSwitchDecisionReason?: string
  /** PermissionRequest's independent decision object; never inferred from exit code 2. */
  permissionRequestDecision?: {
    behavior: "allow" | "deny"
    updatedInput?: Record<string, unknown>
    updatedPermissions?: PermissionUpdate[]
    message?: string
    interrupt?: boolean
  }
  /** Last hook's updatedInput wins (CC behavior) */
  updatedInput?: Record<string, unknown>
  /** Presence matters: null and empty output are valid replacements. */
  updatedToolOutput?: unknown
  updatedMCPToolOutput?: unknown
  elicitation?: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
  initialUserMessage?: string
  sessionTitle?: string
  reloadSkills?: boolean
  suppressOriginalPrompt?: boolean
  watchPaths?: string[]
  displayContent?: string
  retry?: boolean
  displayMessage?: string
  compactSummary?: string
  customSummary?: string
  worktreePath?: string
  /** Configured WorktreeRemove hook failed while its directory still exists. */
  worktreeRemoveFailed?: boolean
}

/** Claude permission update shape. Consumers must validate destination and rules before applying. */
export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules"
      rules: { toolName: string; ruleContent?: string }[]
      behavior: "allow" | "deny" | "ask"
      destination: string
    }
  | { type: "setMode"; mode: string; destination: string }
  | { type: "addDirectories" | "removeDirectories"; directories: string[]; destination: string }

/** Post hooks run after the side effect; report validation feedback to the model. */
export function postHookFeedback(result: TriggerResult): string {
  return [
    ...(result.additionalContexts ?? []),
    ...(result.blocked ? [`[Post-tool hook blocked] ${result.blocked.reason}`] : []),
    ...(result.preventContinuation ? [`[Hook stopped] ${result.stopReason ?? "Hook requested stop"}`] : []),
  ].join("\n\n")
}

export function withHookFeedback(output: string, result: TriggerResult): string {
  const feedback = postHookFeedback(result)
  return feedback ? `${output}\n\n${feedback}` : output
}

export function withHookFailure(error: unknown, result: TriggerResult): unknown {
  const feedback = postHookFeedback(result)
  if (!feedback) return error
  return new Error(`${error instanceof Error ? error.message : String(error)}\n\n${feedback}`, { cause: error })
}

/**
 * Land a TriggerResult's `systemMessages` so they are never silently dropped.
 *
 * Warnings are user-visible ephemeral events, not model context. `inject`
 * remains accepted for existing callers but is intentionally unused.
 */
export function landSystemMessages(
  result: TriggerResult,
  opts: { sessionID: string; inject?: (message: string) => Effect.Effect<unknown> },
): Effect.Effect<void> {
  const messages = result.systemMessages ?? []
  if (messages.length === 0) return Effect.void
  return Effect.gen(function* () {
    // Lazy import preserves this leaf's cycle-free module initialization.
    const { HookNotification } = yield* Effect.promise(() => import("./notifications"))
    for (const message of messages) {
      yield* HookNotification.message(opts.sessionID, message)
    }
  })
}
