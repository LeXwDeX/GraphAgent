export * as GoalState from "./state"

import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/schema/schema"

export const Status = Schema.Literals(["active", "paused", "done"])
export type Status = Schema.Schema.Type<typeof Status>

// `skipped` was a dead enum value with no production write path — removed.
export const Verdict = Schema.Literals(["done", "continue", "blocked"])
export type Verdict = Schema.Schema.Type<typeof Verdict>

/**
 * #892: durable automatic-recovery budget for one failure chain.
 *
 * The chain starts at the first errored turn and ends only at a committed
 * non-summary work turn, a user resume, or a new Goal instance. Compaction
 * summaries never end it. Persisting the counters (instead of deriving them
 * from a bounded transcript window) keeps the two-attempt / one-reset limits
 * true across long histories and restarts, and prevents an intervening error
 * class from resetting the other budget.
 */
export const Recovery = Schema.Struct({
  /** Number of automatic retry turns already dispatched for this chain. */
  attempts: NonNegativeInt,
  /** Whether the one allowed reasoning-state reset was already dispatched. */
  reset: Schema.Boolean,
  /** Last errored assistant message observed (diagnostics and audit). */
  boundary: Schema.String,
})
export type Recovery = Schema.Schema.Type<typeof Recovery>

export class Info extends Schema.Class<Info>("GoalState")({
  goal_id: Schema.String.pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed("legacy")),
  ),
  revision: NonNegativeInt.pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed(0 as Schema.Schema.Type<typeof NonNegativeInt>)),
  ),
  goal: Schema.String,
  status: Status,
  turns_used: NonNegativeInt,
  max_turns: NonNegativeInt,
  created_at: Schema.Number,
  last_turn_at: Schema.Number,
  last_verdict: Schema.optional(Verdict),
  last_reason: Schema.optional(Schema.String),
  paused_reason: Schema.optional(Schema.String),
  // issue #285 — the assistant message ID of the boundary judged by the last
  // committed continue evaluation. Durable crash-recovery gate: the boot scan
  // must not re-judge a window that still ends on this message (the
  // process-local evaluatedRevisions map dies with the process).
  last_judged_msg: Schema.optional(Schema.String),
  consecutive_parse_failures: NonNegativeInt,
  recovery: Schema.optional(Recovery),
  subgoals: Schema.Array(Schema.String).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>))),
}) {}

/**
 * Construct a goal NonNegativeInt field from a plain number, centralizing the
 * one unavoidable cast. Every call site computes these from validated
 * arithmetic (0, prev+1, clamped parse-failure counters) so the runtime ≥0
 * filter is redundant here; this keeps the escape hatch at a single audited
 * site instead of `as any` scattered across goal.ts.
 */
export const nni = (value: number): Schema.Schema.Type<typeof NonNegativeInt> => value

export function advance(state: Info, patch: Partial<Omit<Info, "revision">>) {
  return new Info({
    goal_id: state.goal_id,
    revision: nni((state.revision ?? 0) + 1),
    goal: state.goal,
    status: state.status,
    turns_used: state.turns_used,
    max_turns: state.max_turns,
    created_at: state.created_at,
    last_turn_at: state.last_turn_at,
    last_verdict: state.last_verdict,
    last_reason: state.last_reason,
    paused_reason: state.paused_reason,
    last_judged_msg: state.last_judged_msg,
    consecutive_parse_failures: state.consecutive_parse_failures,
    recovery: state.recovery,
    subgoals: state.subgoals,
    ...patch,
  })
}
