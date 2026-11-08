/**
 * Async rewake prompts, stop-hook caps, and background completion handling.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
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
import type { HookCommand, HookEvent } from "../types"
import type { HookExecution } from "../handlers/shared"
import type { SessionHookEntry } from "../session-hooks"
import type { State, StopRewakeChain } from "./state"

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
 * Async hook completion handler. Computes rewake-worthiness from the result
 * and, when `asyncRewake` is set, admits a steer prompt to the originating
 * session via the opencode Session.Service (ambient in the session runtime).
 * Best-effort — all errors swallowed to honor the "never crash host" contract.
 */
export const onAsyncComplete = Effect.fnUntraced(function* (
  entry: HookCommand,
  sessionEntry: SessionHookEntry | undefined,
  sessionOwner: string | undefined,
  event: HookEvent,
  sessionID: string | undefined,
  hookRewake: HookRewake.Interface | undefined,
  state: State,
  stopChain: StopRewakeChain | undefined,
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
  const parts: string[] = []
  if (result.exitBlock) parts.push(result.exitBlock)
  if (result.json?.systemMessage) parts.push(result.json.systemMessage)
  if (result.json?.decision === "block" && result.json.reason) parts.push(result.json.reason)
  const hso = result.json?.hookSpecificOutput
  if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string") {
    parts.push(hso.additionalContext)
  }
  // Asynchronous hooks deliver only their JSON fields; plain stdout is never context.
  if (parts.length === 0) {
    return
  }

  // Ordinary async output waits for the next actual turn. asyncRewake only
  // wakes an idle session on exit 2; normal completion never invents a turn.
  if (!entry.asyncRewake || result.exitCode !== 2 || !hookRewake) {
    const queued = state.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
    // Ordinary async JSON fields are both model feedback on the next turn;
    // unlike synchronous systemMessage, neither is an ephemeral UI warning.
    // Sanitize at the queue's only producer: both consumers (V1 SessionPrompt
    // and the V2 turn bridge) drain raw strings, so an escaped/bounded value
    // must already be in the queue. This also keeps an oversized payload from
    // accumulating in memory while it waits for the next turn.
    const spillDir = yield* HookTranscript.scratchpadDir(sessionID)
    if (result.json?.systemMessage)
      queued.additionalContexts.push(sanitizeHookContext(result.json.systemMessage, spillDir))
    if (hso && "additionalContext" in hso && typeof hso.additionalContext === "string")
      queued.additionalContexts.push(sanitizeHookContext(hso.additionalContext, spillDir))
    state.asyncResults.set(sessionID, queued)
    return
  }

  if (stopChain) {
    // A newer non-hook prompt, SessionEnd, or session cancel invalidates
    // pending Stop callbacks.
    if (state.stopRewakeChains.get(`${event}:${sessionID}`) !== stopChain) {
      log.debug("async Stop callback discarded: chain invalidated", { sessionID, event })
      return
    }
    const continuationCap = stopHookBlockCap()
    if (stopChain.count >= continuationCap) {
      log.warn("async Stop hook continuation limit reached", { sessionID, limit: continuationCap })
      return
    }
    // Reserve before yielding so concurrent completions share the same bound.
    stopChain.count++
  }

  // Claude ignores StopFailure output and exit code. Keep the chain invalidation above so a cancelled callback
  // is still discarded, but never queue context or start a new turn from this event.
  if (event === "StopFailure") return

  const text = buildRewakePrompt(
    entry,
    event,
    result.exitBlock ?? parts.join("\n"),
    yield* HookTranscript.scratchpadDir(sessionID),
  )
  // The token rides along so SessionPrompt can re-check validity at the
  // real admission point — cancel can invalidate after this completion
  // check but before the rewake lands.
  yield* hookRewake
    .rewake({
      sessionID: SessionID.make(sessionID),
      text,
      stopChain,
      valid: () => Effect.sync(() => !stopChain || state.stopRewakeChains.get(`${event}:${sessionID}`) === stopChain),
    })
    .pipe(Effect.catchDefect(() => Effect.logError("async hook rewake failed", { sessionID })))
})
