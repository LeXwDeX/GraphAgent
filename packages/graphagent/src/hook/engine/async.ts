// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Async rewake prompts, stop-hook caps, and background completion handling.
 *
 * Completion is split into a pure `classifyAsyncResult` decision (drop / queue
 * for the next turn / wake the session) and the effectful delivery below it.
 * A wake additionally re-checks the Stop-continuation identity token and
 * budget, which are the only mutable inputs the pure part cannot see.
 */
import path from "path"
import { createHash } from "crypto"
import { writeFileSync } from "fs"
import { Effect } from "effect"
import * as Log from "@/util/log"
import { SessionID } from "@/session/schema"
import { descriptorFor } from "../config/chain"
import { HookTranscript } from "../transcript"
import type { HookRewake } from "../rewake"
import type { HookCommand, HookEvent, RewakeToken } from "../types"
import type { HookExecution } from "../handlers/shared"
import type { SessionHookEntry } from "../session-hooks"
import type { State } from "./state"
import { claimStopContinuation, rewakeTokenValid } from "./state"

const log = Log.create({ service: "hook.settings" })

// ── Async rewake (hook-async-rewake) ───────────────────────────
// Sentinel prefix for rewake prompts. UserPromptSubmit hook processing skips
// prompts whose text starts with this prefix, preventing hook → rewake → hook
// loops. The prefix must match the opening of buildRewakePrompt exactly.
export const HOOK_REWAKE_SENTINEL = "<system-reminder>\nAsync hook completed"

const CONTEXT_LIMIT = 10_000
const CONTEXT_PREVIEW_LIMIT = 2_000
/**
 * Claude bounds hook-provided context at 10,000 characters and escapes reminder
 * tags so hook output cannot close the host envelope. Over-limit text is kept
 * whole in `spillDir` when available; what reaches the model is its path plus a
 * 2,000-character preview. Without a writable directory the value is truncated
 * in place so the cap still holds.
 */
export function sanitizeHookContext(text: string, spillDir?: string): string {
  const escaped = text
    .replaceAll("<system-reminder>", "&lt;system-reminder>")
    .replaceAll("</system-reminder>", "&lt;/system-reminder>")
  if (escaped.length <= CONTEXT_LIMIT) return escaped
  if (spillDir) {
    const file = path.join(spillDir, `context-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`)
    try {
      writeFileSync(file, text, { mode: 0o600 })
      return `Full context saved to ${file}\n\n${escaped.slice(0, CONTEXT_PREVIEW_LIMIT)}`
    } catch {
      // An unwritable scratchpad must not fail the hook; fall back to truncation.
    }
  }
  return `${escaped.slice(0, CONTEXT_LIMIT)}\n[truncated at ${CONTEXT_LIMIT} characters]`
}

function buildRewakePrompt(entry: HookCommand, event: HookEvent, content: string, spillDir?: string): string {
  const cmd = descriptorFor(entry)
  return `${HOOK_REWAKE_SENTINEL} (command: ${cmd}, event: ${event}):\n${sanitizeHookContext(content, spillDir)}\n</system-reminder>`
}

// `TriggerResult` and `landSystemMessages` live in `./trigger-result` (a
// cycle-free leaf). Re-exported here so existing `SettingsHook.*` /
// `@/hook` call sites keep working. See trigger-result.ts for the cycle rationale.
import { landSystemMessages, type TriggerResult } from "../trigger-result"
export type { TriggerResult } from "../trigger-result"
export { landSystemMessages } from "../trigger-result"

/**
 * Hard cap on how many times a blocked Stop / SubagentStop hook may drive another
 * model turn. Guards against a misbehaving hook that ignores `stop_hook_active`
 * (which would otherwise loop forever burning tokens). Shared by the main agent
 * Stop path (prompt.ts) and the SubagentStop path (task.ts).
 */
export const MAX_STOP_CONTINUATIONS = 8

/**
 * Claude Code's `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` override for the cap above.
 * Only a positive integer is accepted; anything else (including unset) keeps
 * the documented default of 8.
 */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  if (raw === undefined) return MAX_STOP_CONTINUATIONS
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : MAX_STOP_CONTINUATIONS
}

/**
 * Raw contexts an async hook contributes to the next turn's queue:
 * `systemMessage` first, then the event-matching `additionalContext`. Both are
 * unsanitized; delivery sanitizes them at the queue's single producer.
 */
function queuedContexts(event: HookEvent, result: HookExecution): string[] {
  const contexts: string[] = []
  if (result.json?.systemMessage) contexts.push(result.json.systemMessage)
  const hso = result.json?.hookSpecificOutput
  if (hso && hso.hookEventName === event && "additionalContext" in hso && typeof hso.additionalContext === "string")
    contexts.push(hso.additionalContext)
  return contexts
}

/** Completion decision for one background hook result. */
export type AsyncResultClassification =
  | { readonly kind: "drop" }
  /** Queue these unsanitized contexts for the session's next real turn. */
  | { readonly kind: "queue"; readonly contexts: readonly string[] }
  /** Wake the originating session with this unsanitized rewake body. */
  | { readonly kind: "wake"; readonly text: string }

/**
 * Decide what a completed async hook contributes, without side effects.
 *
 * Order is deliberate: SessionEnd never has a later turn; empty output is
 * nothing; ordinary async output (including StopFailure with a non-2 exit)
 * only queues for the next turn; only `asyncRewake` + exit 2 wakes, and
 * StopFailure is dropped because Claude ignores its output and exit code.
 */
export function classifyAsyncResult(
  entry: HookCommand,
  event: HookEvent,
  result: HookExecution,
): AsyncResultClassification {
  if (event === "SessionEnd") return { kind: "drop" }
  const parts: string[] = []
  if (result.exitBlock) parts.push(result.exitBlock)
  if (result.json?.systemMessage) parts.push(result.json.systemMessage)
  if (result.json?.decision === "block" && result.json.reason) parts.push(result.json.reason)
  const hso = result.json?.hookSpecificOutput
  if (hso && hso.hookEventName === event && "additionalContext" in hso && typeof hso.additionalContext === "string")
    parts.push(hso.additionalContext)
  // Asynchronous hooks deliver only their JSON fields; plain stdout is never context.
  if (parts.length === 0) return { kind: "drop" }
  if (!entry.asyncRewake || result.exitCode !== 2) return { kind: "queue", contexts: queuedContexts(event, result) }
  // Claude ignores StopFailure output and exit code.
  if (event === "StopFailure") return { kind: "drop" }
  return { kind: "wake", text: result.exitBlock ?? parts.join("\n") }
}

/**
 * Async hook completion handler. Classifies the result, queues ordinary
 * output for the next turn, and — for an async Stop rewake — validates the
 * continuation token and budget before admitting a steer prompt through the
 * HookRewake service. Best-effort: all defects are swallowed to honor the
 * "never crash host" contract.
 */
export const onAsyncComplete = Effect.fnUntraced(function* (
  entry: HookCommand,
  sessionEntry: SessionHookEntry | undefined,
  sessionOwner: string | undefined,
  event: HookEvent,
  sessionID: string | undefined,
  hookRewake: HookRewake.Interface | undefined,
  state: State,
  rewakeToken: RewakeToken | undefined,
  result: HookExecution,
  entryToken?: string,
) {
  const running = state.onceRunning.get(sessionOwner ?? sessionID ?? "")
  const ownsEntry = !!entryToken && running?.get(entry) === entryToken
  if (ownsEntry) running?.delete(entry)
  if (
    sessionEntry &&
    sessionEntry.kind !== "agent" &&
    entry.once &&
    ownsEntry &&
    result.succeeded === true &&
    !result.exitBlock &&
    sessionID
  ) {
    const onceBucket = state.once.get(sessionOwner ?? sessionID) ?? new WeakSet<HookCommand>()
    onceBucket.add(entry)
    state.once.set(sessionOwner ?? sessionID, onceBucket)
  }
  // SessionEnd has no later turn.
  if (event === "SessionEnd") return
  if (!sessionID) return
  const rawHso = result.json?.hookSpecificOutput
  // Same discriminator rule as the synchronous reducer: a missing or
  // mismatched hookEventName makes the object unusable for this event.
  if (rawHso && rawHso.hookEventName !== event)
    log.debug("ignored hookSpecificOutput for a different event", {
      event,
      hookEventName: rawHso.hookEventName,
    })

  const classified = classifyAsyncResult(entry, event, result)
  if (classified.kind === "drop") return

  const queue = (contexts: readonly string[]) =>
    Effect.gen(function* () {
      const queued = state.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
      // Ordinary async JSON fields are both model feedback on the next turn;
      // unlike synchronous systemMessage, neither is an ephemeral UI warning.
      // Sanitize at the queue's only producer: both consumers (V1 SessionPrompt
      // and the V2 turn bridge) drain raw strings, so an escaped/bounded value
      // must already be in the queue. This also keeps an oversized payload from
      // accumulating in memory while it waits for the next turn.
      const spillDir = yield* HookTranscript.scratchpadDir(sessionID)
      for (const context of contexts) queued.additionalContexts.push(sanitizeHookContext(context, spillDir))
      state.asyncResults.set(sessionID, queued)
    })

  // Ordinary async output waits for the next actual turn. asyncRewake only
  // wakes an idle session on exit 2; normal completion never invents a turn.
  if (classified.kind === "queue") {
    yield* queue(classified.contexts)
    return
  }
  if (!hookRewake) {
    yield* queue(queuedContexts(event, result))
    return
  }

  // A Stop/SubagentStop continuation owns the session's live rewake chain.
  // A newer non-hook prompt, SessionEnd, clearSession, or session cancel
  // advances the token, so a late callback must be dropped here.
  if (event === "Stop" || event === "SubagentStop") {
    if (!rewakeTokenValid(state, sessionID, rewakeToken)) {
      log.debug("async Stop callback discarded: rewake token stale", { sessionID, event })
      return
    }
    const continuationCap = stopHookBlockCap()
    if (!claimStopContinuation(state, sessionID, event, continuationCap)) {
      log.warn("async Stop hook continuation limit reached", { sessionID, limit: continuationCap })
      return
    }
  }

  const text = buildRewakePrompt(entry, event, classified.text, yield* HookTranscript.scratchpadDir(sessionID))
  // The token rides along so SessionPrompt can re-check validity at the
  // real admission point — cancel can invalidate after this completion
  // check but before the rewake lands.
  yield* hookRewake
    .rewake({
      sessionID: SessionID.make(sessionID),
      text,
      ...(rewakeToken !== undefined ? { rewakeToken } : {}),
    })
    .pipe(Effect.catchDefect(() => Effect.logError("async hook rewake failed", { sessionID })))
})
