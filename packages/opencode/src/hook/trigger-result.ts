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
  /**
   * User-visible notices for hooks that failed without blocking
   * (`<event>[:<matcher>] hook error: <failure>`). Reference parity: a mistyped
   * command or a dead endpoint must not disappear into the log. Never model
   * context and never part of tool feedback.
   */
  hookErrors?: string[]
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

/** PreToolUse context stays attached to the result of the call it governed (denial, rejection or failure). */
export function withPreContext(text: string, contexts: readonly string[] | undefined): string {
  const lines = (contexts ?? []).filter(Boolean)
  return lines.length ? `${text}\n\n${lines.join("\n\n")}` : text
}

/** A failed tool whose PostToolUseFailure hook returned `continue:false`; the processor ends the turn on it. */
export class HookToolStop extends Error {
  readonly _tag = "HookToolStop"
  constructor(
    message: string,
    readonly stopReason: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "HookToolStop"
  }
}

/** Find a hook stop marker on an error or its cause chain. */
export function hookToolStop(error: unknown): HookToolStop | undefined {
  for (let depth = 0, current = error; depth < 8 && current instanceof Error; depth++, current = current.cause) {
    if (current instanceof HookToolStop) return current
  }
  return undefined
}

export function withHookFailure(error: unknown, result: TriggerResult, preContexts: readonly string[] = []): unknown {
  const feedback = [...preContexts.filter(Boolean), postHookFeedback(result)].filter(Boolean).join("\n\n")
  if (!feedback) return error
  const message = `${error instanceof Error ? error.message : String(error)}\n\n${feedback}`
  if (result.preventContinuation)
    return new HookToolStop(message, result.stopReason ?? "Hook requested stop", { cause: error })
  return new Error(message, { cause: error })
}

/**
 * Land a TriggerResult's user-visible notices so they are never silently dropped.
 *
 * Warnings are user-visible ephemeral events, not model context. `inject`
 * remains accepted for existing callers but is intentionally unused.
 */
export function landSystemMessages(
  result: TriggerResult,
  opts: { sessionID: string; inject?: (message: string) => Effect.Effect<unknown> },
): Effect.Effect<void> {
  const messages = [...(result.systemMessages ?? []), ...(result.hookErrors ?? [])]
  if (messages.length === 0) return Effect.void
  return Effect.gen(function* () {
    // Lazy import preserves this leaf's cycle-free module initialization.
    const { HookNotification } = yield* Effect.promise(() => import("./notifications"))
    for (const message of messages) {
      yield* HookNotification.message(opts.sessionID, message)
    }
  })
}
