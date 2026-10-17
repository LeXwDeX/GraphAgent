import { Effect } from "effect"
import { Token } from "../../util/token"
import type { ReasoningReplacement } from "./adoption"
import {
  organizePrompt,
  organizeReasoning,
  type OrganizeCall,
  type OrganizeLanguage,
  type OrganizeReason,
  type OrganizeSlot,
} from "./organize"
import { ReasoningDistillationPolicy } from "./policy"

type BudgetState = { tokens: number; consecutiveFailures: number; paused: boolean }

/**
 * Process-local organizer budget per session. Usage the provider omits is estimated from prompt and output rather than
 * pausing the session; only consecutive failures without a response pause it. The ceiling is soft under concurrency:
 * calls admitted together may overshoot it by their own size.
 */
export const makeRewriteBudget = () => {
  const states = new Map<string, BudgetState>()
  const state = (sessionID: string) => {
    let current = states.get(sessionID)
    if (!current) {
      current = { tokens: 0, consecutiveFailures: 0, paused: false }
      states.set(sessionID, current)
    }
    return current
  }
  return {
    admit: (sessionID: string): "ok" | "paused" | "exhausted" => {
      const current = state(sessionID)
      if (current.paused) return "paused"
      if (current.tokens >= ReasoningDistillationPolicy.tokens.maxTokensPerSession) return "exhausted"
      return "ok"
    },
    record: (
      sessionID: string,
      input: { responded: boolean; aborted: boolean; usageTokens?: number; prompt: string; output?: string },
    ) => {
      const current = state(sessionID)
      if (!input.responded) {
        if (input.aborted) return
        current.consecutiveFailures++
        if (current.consecutiveFailures >= ReasoningDistillationPolicy.calls.maxConsecutiveFailures)
          current.paused = true
        return
      }
      current.consecutiveFailures = 0
      const reported = input.usageTokens
      current.tokens +=
        typeof reported === "number" && Number.isFinite(reported) && reported >= 0
          ? Math.ceil(reported)
          : Token.estimateReserve(input.prompt) + Token.estimateReserve(input.output ?? "")
    },
    snapshot: (sessionID: string) => ({ ...state(sessionID) }),
    forget: (sessionID: string) => void states.delete(sessionID),
  }
}

export type RewriteBudget = ReturnType<typeof makeRewriteBudget>

export type RewriteOutcome<A> = Readonly<{
  status: "adopted" | "skipped" | "rejected"
  reason:
    OrganizeReason | "small-model-unavailable" | "budget-paused" | "budget-exhausted" | "adoption-rejected" | "none"
  adopted?: A
  modelCalls: number
  inputCharacters: number
  outputCharacters: number
  usageTokens?: number
  timing: Readonly<{ modelMs: number; parseMs: number; adoptMs: number; totalMs: number }>
}>

/**
 * Organize one settled reasoning part and adopt the result. `call` receives an abort signal tied to this effect, so
 * interrupting the caller (for example when the turn is cancelled) cancels the model request.
 */
export const runReasoningRewrite = <A>(input: {
  budget: RewriteBudget
  sessionID: string
  slot: OrganizeSlot
  language: OrganizeLanguage
  call: ((signal: AbortSignal, onResponseStarted?: () => void) => OrganizeCall) | undefined
  onResponseStarted?: () => void
  adopt: (replacement: ReasoningReplacement) => Effect.Effect<A | undefined>
}): Effect.Effect<RewriteOutcome<A>> =>
  Effect.gen(function* () {
    const started = performance.now()
    const base = {
      modelCalls: 0,
      inputCharacters: input.slot.text.length,
      outputCharacters: 0,
    }
    const timing = (modelMs = 0, parseMs = 0, adoptMs = 0) => ({
      modelMs,
      parseMs,
      adoptMs,
      totalMs: performance.now() - started,
    })
    if (!input.call) return { ...base, status: "skipped", reason: "small-model-unavailable", timing: timing() } as const
    const admission = input.budget.admit(input.sessionID)
    if (admission !== "ok")
      return {
        ...base,
        status: "skipped",
        reason: admission === "paused" ? "budget-paused" : "budget-exhausted",
        timing: timing(),
      } as const
    const call = input.call
    // Own the cancellation: interrupting the job (a sealing barrier, or closing the owning directory's scope) must
    // cancel the provider request even when the promise's own signal is not aborted on that path.
    const controller = new AbortController()
    let aborted = false
    controller.signal.addEventListener("abort", () => (aborted = true), { once: true })
    const organized = yield* Effect.promise((signal) => {
      signal.addEventListener("abort", () => controller.abort(), { once: true })
      return organizeReasoning({
        slot: input.slot,
        callModel: call(controller.signal, input.onResponseStarted),
        language: input.language,
      })
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
    if (organized.called)
      input.budget.record(input.sessionID, {
        responded: organized.output !== undefined,
        aborted,
        usageTokens: organized.usageTokens,
        prompt: organizePrompt(input.slot.text, input.language),
        output: organized.output,
      })
    const observed = {
      ...base,
      modelCalls: organized.called ? 1 : 0,
      outputCharacters: organized.output?.length ?? 0,
      usageTokens: organized.usageTokens,
    }
    if (organized.status !== "organized" || !organized.replacement)
      return {
        ...observed,
        status: "skipped",
        reason: organized.reason ?? "none",
        timing: timing(organized.timing.modelMs, organized.timing.parseMs),
      } as const
    const adoptStarted = performance.now()
    const adopted = yield* input.adopt(organized.replacement)
    const adoptMs = performance.now() - adoptStarted
    return {
      ...observed,
      status: adopted === undefined ? "rejected" : "adopted",
      reason: adopted === undefined ? "adoption-rejected" : "none",
      ...(adopted === undefined ? {} : { adopted }),
      timing: timing(organized.timing.modelMs, organized.timing.parseMs, adoptMs),
    } as const
  })

/** Allowlisted log fields for one rewrite; never includes reasoning text. */
export const rewriteLogFields = (
  outcome: RewriteOutcome<unknown>,
  extra: Readonly<Record<string, string | number | boolean>> = {},
) => ({
  "reasoning_distillation.status": outcome.status,
  "reasoning_distillation.reason": outcome.reason,
  "reasoning_distillation.model_calls": outcome.modelCalls,
  "reasoning_distillation.input_characters": outcome.inputCharacters,
  "reasoning_distillation.output_characters": outcome.outputCharacters,
  "reasoning_distillation.reported_total_tokens": outcome.usageTokens ?? "unknown",
  "reasoning_distillation.model_ms": outcome.timing.modelMs,
  "reasoning_distillation.parse_ms": outcome.timing.parseMs,
  "reasoning_distillation.adopt_ms": outcome.timing.adoptMs,
  "reasoning_distillation.total_ms": outcome.timing.totalMs,
  ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`reasoning_distillation.${key}`, value])),
})
