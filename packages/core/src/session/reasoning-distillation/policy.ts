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
