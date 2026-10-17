import { Cause, Exit } from "effect"
import type { TriggerResult } from "./settings"

/**
 * Pure synchronous reduction of a PreToolUse `TriggerResult` into the three
 * decisions a tool-execution call site must act on.
 *
 * Centralizes:
 * - deny / blocked → `deniedReason` (caller returns a denied result)
 * - preventContinuation → `stopReason` (caller short-circuits with a stop message)
 * - updatedInput → `effectiveArgs` (complete replacement; last hook wins).
 *
 * `permissionDecision:"ask"` is intentionally NOT handled here — it requires the
 * effectful permission dialog (`permission.ask`), which stays at each call site
 * (paths with a permission context) or degrades to deny (paths without).
 */
export interface PreHookDecision {
  /** Arguments the tool should actually execute with (original, or completely replaced by updatedInput). */
  readonly effectiveArgs: Record<string, unknown>
  /** Set when the hook denied/blocked — caller returns a denied result. */
  readonly deferred?: true
  readonly deniedReason?: string
  /** Set when the hook requested continuation stop — caller short-circuits with a stop message. */
  readonly stopReason?: string
}

export function applyPreHookDecision(
  args: Record<string, unknown>,
  preResult: TriggerResult | undefined,
): PreHookDecision {
  if (!preResult) return { effectiveArgs: args }

  if (preResult.preventContinuation) {
    const stopReason = preResult.stopReason ?? "Hook requested stop"
    return { effectiveArgs: args, stopReason }
  }

  if (preResult.permissionDecision === "deny" || preResult.blocked) {
    const deniedReason = preResult.permissionDecisionReason ?? preResult.blocked?.reason ?? "Denied by PreToolUse hook"
    return { effectiveArgs: args, deniedReason }
  }

  if (preResult.permissionDecision === "defer") return { effectiveArgs: args, deferred: true }

  const effectiveArgs = preResult.updatedInput ?? args
  return { effectiveArgs }
}

/**
 * A `defer` verdict only pauses the call when the host can resume it. When it
 * cannot, ignore just that verdict: every other aggregated field (exit-2
 * `blocked`, `deny`, `continue:false`, updatedInput, contexts, messages) must
 * keep applying so a sibling hook's rejection is never erased.
 */
export function withoutUnusableDefer(preResult: TriggerResult): TriggerResult {
  if (preResult.permissionDecision !== "defer" || preResult.preventContinuation) return preResult
  const { permissionDecision: _decision, permissionDecisionReason: _reason, ...rest } = preResult
  return rest
}

// ── Permission "ask" verdict classification ─────────────────────────────
//
// `permissionDecision:"ask"` triggers a confirmation dialog via
// `permission.ask(...).pipe(Effect.exit)`. A naive `Exit.isFailure` check would
// wrongly treat a session ABORT mid-dialog (interrupt cause) or an internal bug
// (defect cause) as a user denial, masking both as `[Tool denied by hook]`.
//
// Only a *typed* permission rejection (DeniedError / RejectedError /
// CorrectedError) is a real denial. Interrupts and defects MUST propagate so the
// session aborts / the bug surfaces instead of being silently swallowed.
export type PermissionAskOutcome<E = unknown> = "approved" | "denied" | { readonly propagate: Cause.Cause<E> }

export function classifyPermissionAsk<A, E>(exit: Exit.Exit<A, E>): PermissionAskOutcome<E> {
  if (Exit.isSuccess(exit)) return "approved"
  const cause = exit.cause
  if (Cause.hasInterrupts(cause) || Cause.hasDies(cause)) {
    return { propagate: cause }
  }
  // No interrupts and no defects ⇒ the remaining failure is a typed permission
  // rejection in the `E` channel.
  return "denied"
}
