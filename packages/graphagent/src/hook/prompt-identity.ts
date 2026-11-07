/**
 * Claude Code's prompt-scoped envelope fields: `prompt_id` and `effort`.
 *
 * CC's `prompt_id` is a UUID that matches the `prompt.id` OpenTelemetry
 * attribute for the same prompt and is absent before the first user input. The
 * fork's prompts are persisted user messages, so the truthful stable identity is
 * the message id: it exists exactly when a prompt exists, survives restarts, and
 * lets a hook join the envelope to `transcript_path` without inventing a second
 * identifier. (Message ids are not UUIDs; CC's own tool ids and session ids are
 * not either, consumers must treat it as an opaque string.)
 *
 * `effort` is derived from the selected model variant. Only CC's five levels are
 * portable; provider tiers below `low` report `low` and tiers above `max` report
 * `max`, mirroring CC's rule that the field names the level actually run. A
 * custom variant name has no portable meaning and is omitted rather than
 * guessed.
 */
import type { HookEffort } from "./settings"
import type { Message } from "./transcript"
import { variantToEffort } from "@opencode-ai/core/session/effort"

/**
 * Map a model variant to CC's effort level. Shared with every other consumer
 * that exports `CLAUDE_EFFORT` to a child process (see `variantToEffort`).
 */
export { variantToEffort }

export interface PromptIdentity {
  promptID?: string
  effort?: HookEffort
}

/**
 * A compaction-continuation user message is storage for the summary, not a
 * submitted prompt; its id must never become `prompt_id`.
 */
function isCompactionCarrier(message: Message): boolean {
  return message.parts.some(
    (part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "compaction",
  )
}

/**
 * Identity of the newest user prompt in a V1 message list. A session whose only
 * user-role entries are synthetic/compaction stand-ins returns `{}` — no prompt
 * has been submitted yet, which is exactly when CC omits `prompt_id`.
 */
export function promptIdentity(messages: readonly Message[]): PromptIdentity {
  const prompt = messages.findLast((message) => message.info.role === "user" && !isCompactionCarrier(message))
  if (!prompt) return {}
  const effort = variantToEffort(prompt.info.model?.variant)
  return { promptID: prompt.info.id, ...(effort ? { effort } : {}) }
}

/**
 * Fill prompt identity into a trigger context without overriding values the
 * caller already set (call sites that know the exact prompt win over a
 * list-derived guess).
 */
export function withPromptIdentity<T extends { promptID?: string; effort?: HookEffort }>(
  context: T,
  identity: PromptIdentity,
): T {
  const promptID = context.promptID ?? identity.promptID
  const effort = context.effort ?? identity.effort
  return {
    ...context,
    ...(promptID ? { promptID } : {}),
    ...(effort ? { effort } : {}),
  }
}
