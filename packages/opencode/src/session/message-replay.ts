import { AbortedError, type SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * Assistant messages with a provider-level error are omitted from the model wire unless the error is an abort that
 * still carries replayable content. Context folding must use the same predicate, otherwise its history references
 * assistant messages that never reach the provider and every downstream binding can fail.
 */
export function isReplayableAssistantMessage(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "assistant" || !message.info.error) return true
  return (
    AbortedError.isInstance(message.info.error) &&
    message.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
  )
}
