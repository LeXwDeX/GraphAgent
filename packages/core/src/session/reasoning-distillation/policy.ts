/**
 * Reasoning-rewrite policy constants. Pure data; hosts supply live model availability and usage observations.
 */
export const ReasoningDistillationPolicy = {
  version: "reasoning-rewrite-v3-per-step",
  calls: {
    /** Concurrent organizer calls per session; further parts wait for a free slot. */
    maxConcurrentPerSession: 4,
    /** Consecutive organizer failures without a response before a session stops calling until restart. */
    maxConsecutiveFailures: 3,
  },
  tokens: {
    /** One organizer prompt may not exceed this estimate. */
    maxInputTokens: 32_768,
    /** maxOutputTokens must leave room for interleaved reasoning: reasoning models on openai-compatible relays spend
     * the cap on reasoning_content before emitting the answer, so a small cap yields empty answers (observed on real
     * qwen/deepseek/glm relays, 2026-09-27). */
    maxOutputTokens: 24_576,
    /** Per-session ceiling on organizer tokens (reported usage, or a prompt+output estimate when usage is missing).
     * Process-local: a restart starts a fresh budget. */
    maxTokensPerSession: 1_048_576,
    /** A replacement must be at least this many estimated tokens smaller than its source. */
    minimumNetSavingsTokens: 1,
    /** Reasoning below this estimated size is left as is: the organizer prompt alone costs more. */
    minimumInputTokens: 32,
  },
} as const

/**
 * Wait this long for the organizer's first provider frame. The user-visible budget grows with the estimated input:
 * a 4K-token reasoning part gets about 9s, capped at 15s. Reaching the first frame proves the upstream is responding;
 * the organizer's own reasoning frames are discarded, and the full text still has to complete within the auxiliary
 * timeout.
 */
export const firstFrameWindowMs = (inputTokens: number) =>
  Math.min(15_000, Math.max(5_000, 5_000 + Math.ceil(inputTokens / 1_000) * 1_000))
